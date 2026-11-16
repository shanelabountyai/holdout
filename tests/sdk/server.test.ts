// Server SDK (Phase 4): config paging, local assignment with the engine's assign(), exposures once per unit, batching,
// rejected events surfaced, retry keeps ids. Fake fetch only; tests/sdk/demo-relay.test.ts drives the real routes.
import { describe, expect, it } from 'vitest';
import { assign } from '@/lib/exp';
import { HoldoutError, HoldoutServer, type HoldoutEvent } from '@/sdk/server';

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
  return { f, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const split = [{ key: 'control', weight: 5000 }, { key: 'treatment', weight: 5000 }];
let n = 0;
const ids = () => `id-${++n}`;
const fixed = () => new Date('2026-11-16T12:00:00.000Z');

describe('HoldoutServer config', () => {
  it('follows nextCursor across pages, sends the key only in the authorization header, and replaces the old config', async () => {
    const { f, calls } = fakeFetch((url) => {
      const u = new URL(url);
      if (!u.searchParams.get('cursor')) return json({ data: [{ key: 'a', salt: 's-a', startedAt: null, variants: split }], nextCursor: 'c1' });
      return json({ data: [{ key: 'b', salt: 's-b', startedAt: null, variants: split }], nextCursor: null });
    });
    const h = new HoldoutServer({ baseUrl: 'http://holdout.test/', apiKey: 'hk_secret', fetch: f });
    h.load([{ key: 'old', salt: 'x', variants: split }]);
    const got = await h.refresh();
    expect(got.map((x) => x.key)).toEqual(['a', 'b']);
    expect(calls.map((c) => c.url)).toEqual(['http://holdout.test/api/v1/experiments?limit=100', 'http://holdout.test/api/v1/experiments?limit=100&cursor=c1']);
    for (const c of calls) {
      expect((c.init.headers as Record<string, string>).authorization).toBe('Bearer hk_secret');
      expect(c.url).not.toContain('hk_secret');
    }
    expect(h.variant('old', 'u1')).toBeNull();
  });

  it('throws a HoldoutError with the status when the config request fails', async () => {
    const { f } = fakeFetch(() => json({ title: 'no' }, 403));
    const h = new HoldoutServer({ baseUrl: 'http://holdout.test', apiKey: 'k', fetch: f });
    await expect(h.refresh()).rejects.toMatchObject({ name: 'HoldoutError', status: 403 });
  });

  it('refuses to start without a key', () => {
    expect(() => new HoldoutServer({ baseUrl: 'http://x', apiKey: '' })).toThrow(HoldoutError);
  });
});

describe('HoldoutServer assignment and events', () => {
  it('assigns with the engine’s assign() and logs one exposure per (experiment, unit)', () => {
    const { f } = fakeFetch(() => json({}));
    const h = new HoldoutServer({ baseUrl: 'http://h', apiKey: 'k', fetch: f, newId: ids, now: fixed });
    h.load([{ key: 'checkout', salt: 'salt-1', variants: split }]);
    for (let i = 0; i < 200; i++) expect(h.variant('checkout', `u${i}`)).toBe(assign('salt-1', `u${i}`, split));
    for (let i = 0; i < 200; i++) h.variant('checkout', `u${i}`);
    expect(h.pending()).toBe(200);
    h.variant('checkout', 'peek', { log: false });
    expect(h.pending()).toBe(200);
  });

  it('returns null and logs nothing for an experiment that is not running', () => {
    const h = new HoldoutServer({ baseUrl: 'http://h', apiKey: 'k', fetch: fakeFetch(() => json({})).f });
    expect(h.variant('nope', 'u1')).toBeNull();
    expect(h.pending()).toBe(0);
  });

  it('sends exposures and conversions in the ingest shape, in batches of at most 500', async () => {
    const bodies: { events: HoldoutEvent[] }[] = [];
    const { f, calls } = fakeFetch((_u, init) => {
      const b = JSON.parse(String(init.body)) as { events: HoldoutEvent[] };
      bodies.push(b);
      return json({ accepted: b.events.length, duplicates: 0, rejected: [] });
    });
    const h = new HoldoutServer({ baseUrl: 'http://h', apiKey: 'k', fetch: f, newId: ids, now: fixed });
    h.load([{ key: 'checkout', salt: 'salt-1', variants: split }]);
    for (let i = 0; i < 700; i++) h.variant('checkout', `v${i}`);
    h.track('purchase', 'v1');
    h.track('order', 'v2', 19.5);
    const r = await h.flush();
    expect(r).toEqual({ sent: 702, accepted: 702, duplicates: 0, rejected: [], failed: 0 });
    expect(bodies.map((b) => b.events.length)).toEqual([500, 202]);
    expect(calls.every((c) => c.url === 'http://h/api/v1/ingest' && c.init.method === 'POST')).toBe(true);
    const e0 = bodies[0]!.events[0]!;
    expect(e0).toEqual({ type: 'exposure', id: expect.any(String), experiment: 'checkout', unitId: 'v0', variant: assign('salt-1', 'v0', split), timestamp: '2026-11-16T12:00:00.000Z' });
    expect(bodies[1]!.events.slice(-2)).toEqual([
      { type: 'conversion', id: expect.any(String), event: 'purchase', unitId: 'v1', timestamp: '2026-11-16T12:00:00.000Z' },
      { type: 'conversion', id: expect.any(String), event: 'order', unitId: 'v2', value: 19.5, timestamp: '2026-11-16T12:00:00.000Z' },
    ]);
    expect(h.pending()).toBe(0);
  });

  it('surfaces rejected events with their code and drops them (resending cannot fix them)', async () => {
    const { f } = fakeFetch(() => json({ accepted: 1, duplicates: 0, rejected: [{ index: 1, code: 'experiment_not_running', detail: 'stopped' }] }));
    const h = new HoldoutServer({ baseUrl: 'http://h', apiKey: 'k', fetch: f, newId: ids });
    h.track('purchase', 'a');
    h.track('purchase', 'b');
    const r = await h.flush();
    expect(r.rejected).toEqual([{ event: expect.objectContaining({ unitId: 'b' }), code: 'experiment_not_running', detail: 'stopped' }]);
    expect(h.pending()).toBe(0);
  });

  it('keeps a batch that failed in transport or with 5xx/429, with the same ids, for the next flush', async () => {
    let mode: 'down' | 'busy' | 'up' = 'down';
    const seen: string[][] = [];
    const { f } = fakeFetch((_u, init) => {
      const b = JSON.parse(String(init.body)) as { events: HoldoutEvent[] };
      seen.push(b.events.map((e) => e.id));
      if (mode === 'down') throw new TypeError('fetch failed');
      if (mode === 'busy') return json({}, 429);
      return json({ accepted: b.events.length, duplicates: 0, rejected: [] });
    });
    const h = new HoldoutServer({ baseUrl: 'http://h', apiKey: 'k', fetch: f, newId: ids });
    h.track('purchase', 'a');
    h.track('purchase', 'b');
    expect(await h.flush()).toMatchObject({ sent: 0, failed: 2 });
    mode = 'busy';
    expect(await h.flush()).toMatchObject({ sent: 0, failed: 2 });
    mode = 'up';
    expect(await h.flush()).toMatchObject({ sent: 2, accepted: 2, failed: 0 });
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[1]).toEqual(seen[2]);
    expect(h.pending()).toBe(0);
  });

  it('on 401/403 keeps every event and throws, so a fixed key can resend them', async () => {
    let ok = false;
    const { f } = fakeFetch((_u, init) => (ok ? json({ accepted: (JSON.parse(String(init.body)) as { events: unknown[] }).events.length, duplicates: 0, rejected: [] }) : json({}, 401)));
    const h = new HoldoutServer({ baseUrl: 'http://h', apiKey: 'k', fetch: f, newId: ids, maxBatch: 1 });
    h.track('purchase', 'a');
    h.track('purchase', 'b');
    await expect(h.flush()).rejects.toMatchObject({ status: 401 });
    expect(h.pending()).toBe(2);
    ok = true;
    expect(await h.flush()).toMatchObject({ sent: 2, accepted: 2 });
  });
});
