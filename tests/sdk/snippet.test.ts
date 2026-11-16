// The browser snippet's behaviour (sdk/holdout.js, the committed bundle): one exposure per experiment per page, conversions
// for the page's unit, batches to the configured same-site endpoint, retries keep ids, and no key ever leaves it (D-35).
import { describe, expect, it } from 'vitest';
import { loadSnippet } from './load-snippet';

const split = [{ key: 'control', weight: 5000 }, { key: 'treatment', weight: 5000 }];
type Sent = { url: string; init: { method: string; headers: Record<string, string>; body: string; keepalive: boolean; credentials: string } };

function page(respond: (n: number) => { ok: boolean; status: number } | Error = () => ({ ok: true, status: 204 })) {
  const sent: Sent[] = [];
  const timers: (() => void)[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const g = {
    fetch: async (url: string, init: Sent['init']) => {
      sent.push({ url, init });
      const r = respond(sent.length);
      if (r instanceof Error) throw r;
      return r;
    },
    setTimeout: (f: () => void) => timers.push(f),
    clearTimeout: () => undefined,
    crypto: { randomUUID: (() => { let i = 0; return () => `uuid-${++i}`; })() },
    addEventListener: (t: string, f: () => void) => (listeners[t] ??= []).push(f),
    document: { visibilityState: 'visible' },
  };
  const { api } = loadSnippet(g);
  return { api, sent, timers, listeners, g, events: (i: number) => (JSON.parse(sent[i]!.init.body) as { events: Record<string, unknown>[] }).events };
}

describe('Holdout snippet', () => {
  it('logs one exposure per experiment per page and returns null for experiments that are not running', async () => {
    const p = page();
    p.api.init({ experiments: [{ key: 'checkout', salt: 's', variants: split }], unitId: 'visitor-1', endpoint: '/collect' });
    const v = p.api.variant('checkout');
    expect(v).toBe(p.api.assign('s', 'visitor-1', split));
    expect(p.api.variant('checkout')).toBe(v);
    expect(p.api.variant('not-running')).toBeNull();
    expect(p.api.pending()).toBe(1);
    await p.api.flush();
    expect(p.sent).toHaveLength(1);
    expect(p.events(0)).toEqual([{ type: 'exposure', id: 'uuid-1', experiment: 'checkout', unitId: 'visitor-1', variant: v, timestamp: expect.stringMatching(/Z$/) }]);
  });

  it('queues conversions for the page’s unit, keeps finite values only, and posts JSON same-origin with keepalive', async () => {
    const p = page();
    p.api.init({ experiments: [], unitId: 'visitor-2', endpoint: '/collect' });
    p.api.track('purchase');
    p.api.track('order', 24.5);
    p.api.track('order', Number.NaN);
    await p.api.flush();
    const s = p.sent[0]!;
    expect(s.url).toBe('/collect');
    expect(s.init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' } });
    expect(p.events(0)).toEqual([
      { type: 'conversion', id: 'uuid-1', event: 'purchase', unitId: 'visitor-2', timestamp: expect.any(String) },
      { type: 'conversion', id: 'uuid-2', event: 'order', unitId: 'visitor-2', value: 24.5, timestamp: expect.any(String) },
      { type: 'conversion', id: 'uuid-3', event: 'order', unitId: 'visitor-2', timestamp: expect.any(String) },
    ]);
  });

  it('sends on its debounce timer and when the page is hidden or left', async () => {
    const p = page();
    p.api.init({ experiments: [], unitId: 'v', endpoint: '/collect', flushMs: 50 });
    p.api.track('a');
    expect(p.timers).toHaveLength(1);
    p.timers[0]!();
    await new Promise((r) => setImmediate(r));
    expect(p.sent).toHaveLength(1);
    p.api.track('b');
    p.g.document.visibilityState = 'hidden';
    p.listeners.visibilitychange!.forEach((f) => f());
    await new Promise((r) => setImmediate(r));
    expect(p.sent).toHaveLength(2);
    p.api.track('c');
    p.listeners.pagehide!.forEach((f) => f());
    await new Promise((r) => setImmediate(r));
    expect(p.sent).toHaveLength(3);
  });

  it('keeps events with the same ids after a network error or 5xx/429, and drops a batch the endpoint refused (4xx)', async () => {
    const answers: ({ ok: boolean; status: number } | Error)[] = [new TypeError('offline'), { ok: false, status: 503 }, { ok: false, status: 429 }, { ok: true, status: 204 }];
    const p = page((n) => answers[n - 1] ?? { ok: false, status: 400 });
    p.api.init({ experiments: [], unitId: 'v', endpoint: '/collect' });
    p.api.track('purchase');
    for (let i = 0; i < 4; i++) await p.api.flush();
    expect(p.sent.map((_, i) => p.events(i)[0]!.id)).toEqual(['uuid-1', 'uuid-1', 'uuid-1', 'uuid-1']);
    expect(p.api.pending()).toBe(0);
    p.api.track('bad');
    await p.api.flush();
    expect(p.api.pending()).toBe(0);
  });

  it('splits more than 500 queued events into batches', async () => {
    const p = page();
    p.api.init({ experiments: [], unitId: 'v', endpoint: '/collect' });
    for (let i = 0; i < 1203; i++) p.api.track('e');
    await p.api.flush();
    expect(p.sent.map((_, i) => p.events(i).length)).toEqual([500, 500, 203]);
  });

  it('carries no key, token or secret: only event fields leave the page', async () => {
    const p = page();
    p.api.init({ experiments: [{ key: 'checkout', salt: 's', variants: split }], unitId: 'v', endpoint: '/collect' });
    p.api.variant('checkout');
    p.api.track('purchase', 3);
    await p.api.flush();
    const s = p.sent[0]!;
    expect(Object.keys(s.init.headers)).toEqual(['content-type']);
    const fields = new Set(p.events(0).flatMap((e) => Object.keys(e)));
    expect([...fields].sort()).toEqual(['event', 'experiment', 'id', 'timestamp', 'type', 'unitId', 'value', 'variant']);
    expect(s.init.body).not.toMatch(/salt|key|token|secret|authorization/i);
  });

  it('refuses to run before init or with a bad config', () => {
    const p = page();
    expect(() => p.api.variant('x')).toThrow(/init/);
    expect(() => p.api.init({ experiments: [], unitId: '', endpoint: '/c' })).toThrow(/required/);
  });
});
