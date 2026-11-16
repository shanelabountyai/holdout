// The demo site's server path, against Holdout's real routes and database: the server SDK loads config from
// GET /api/v1/experiments and relays through POST /api/v1/ingest; the relay stamps the cookie's unit id over whatever the
// browser sent (D-35) and refuses bad bodies before calling Holdout.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { advanceClock, now } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system';
import { assign } from '@/lib/exp';
import { createExperiment, startExperiment } from '@/lib/holdout/experiments';
import * as configRoute from '@/app/api/v1/experiments/route';
import * as ingestRoute from '@/app/api/v1/ingest/route';
import { HoldoutServer } from '@/sdk/server';
import { COOKIE, createDemoSite, MAX_EVENTS } from '../../demo-site/app';
import { resetAuthTables } from '../helpers/auth';
import { conversionDesign, ingestKey, org } from '../holdout/helpers';
import { SNIPPET_JS } from './load-snippet';

beforeEach(async () => {
  await resetAuthTables();
  advanceClock(0);
});
afterAll(async () => {
  advanceClock(0);
  await resetAuthTables(); // leave no 'acme' org behind (NEXT.md e2e trap)
});

/** fetch that dispatches to the route handlers in-process, as Holdout on :8100 would. */
const holdoutFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const req = new Request(String(input), init);
  const path = new URL(req.url).pathname;
  if (req.method === 'GET' && path === '/api/v1/experiments') return configRoute.GET(req, { params: Promise.resolve({}) } as never);
  if (req.method === 'POST' && path === '/api/v1/ingest') return ingestRoute.POST(req);
  return new Response('not found', { status: 404 });
}) as typeof fetch;

const UID_A = '11111111-1111-4111-8111-111111111111';
const UID_B = '22222222-2222-4222-8222-222222222222';

async function setup(opts: { scopes?: string[] } = {}) {
  const a = await org('acme');
  const id = await createExperiment(a.owner, conversionDesign());
  await startExperiment(a.owner, id);
  advanceClock(1000); // exposures must not predate the start
  const key = await ingestKey(a.owner, opts.scopes);
  const x = await db.experiment.findUniqueOrThrow({ where: { id }, include: { variants: { orderBy: { position: 'asc' } } } });
  const holdout = new HoldoutServer({ baseUrl: 'http://holdout.test', apiKey: key, fetch: holdoutFetch, now });
  const logs: string[] = [];
  let next = 0;
  const site = createDemoSite({ holdout, snippetJs: SNIPPET_JS(), experiment: 'checkout-button', newUnitId: () => [UID_A, UID_B][next++]!, log: (m) => logs.push(m) });
  const split = x.variants.map((v) => ({ key: v.key, weight: v.weight }));
  return { a, x, key, holdout, site, logs, split };
}

const get = (path: string, uid?: string) => new Request(`http://localhost:8101${path}`, { headers: uid ? { cookie: `${COOKIE}=${uid}` } : {} });
const collect = (uid: string | null, body: unknown) =>
  new Request('http://localhost:8101/collect', { method: 'POST', headers: { 'content-type': 'application/json', ...(uid && { cookie: `other=1; ${COOKIE}=${uid}` }) }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('demo site relay → Holdout ingest (real routes, real database)', () => {
  it('the shop page sets a visitor cookie and inlines only running experiments’ config, never the key', async () => {
    const { site, key, x } = await setup();
    const res = await site(get('/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${COOKIE}=${UID_A}; Path=/; .*HttpOnly`));
    const html = await res.text();
    const cfg = JSON.parse(/<script type="application\/json" id="holdout-config">(.*?)<\/script>/s.exec(html)![1]!) as { experiments: { key: string; salt: string }[]; unitId: string; endpoint: string };
    expect(cfg).toMatchObject({ unitId: UID_A, endpoint: '/collect', experiments: [{ key: 'checkout-button', salt: x.salt }] });
    expect(html).not.toContain(key);
    expect(html).not.toContain(key.slice(0, 12));
  });

  it('relays the snippet’s exposure and purchase; the stored variant is the server-computed one for the cookie’s unit', async () => {
    const { site, split, x } = await setup();
    const v = assign(x.salt, UID_A, split);
    const res = await site(collect(UID_A, { events: [
      { type: 'exposure', id: 'e1', experiment: 'checkout-button', unitId: UID_A, variant: v, timestamp: now().toISOString() },
      { type: 'conversion', id: 'c1', event: 'purchase', unitId: UID_A, timestamp: now().toISOString() },
    ] }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2, duplicates: 0, rejected: 0, queued: 0 });
    const ex = await db.exposure.findMany({ include: { variant: true } });
    expect(ex.map((e) => [e.unitId, e.variant.key, e.eventId])).toEqual([[UID_A, v, `${UID_A}.e1`]]);
    expect((await db.conversion.findMany()).map((c) => [c.unitId, c.event, c.eventId])).toEqual([[UID_A, 'purchase', `${UID_A}.c1`]]);
    // A retried batch (same ids) counts nothing twice.
    const again = await site(collect(UID_A, { events: [{ type: 'conversion', id: 'c1', event: 'purchase', unitId: UID_A }] }));
    expect(await again.json()).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it('ignores a browser-supplied unitId: events are stored for the cookie’s visitor, ids namespaced by visitor', async () => {
    const { site } = await setup();
    await site(collect(UID_B, { events: [{ type: 'conversion', id: 'c1', event: 'purchase', unitId: UID_A }] }));
    await site(collect(UID_A, { events: [{ type: 'conversion', id: 'c1', event: 'purchase', unitId: UID_A }] }));
    const rows = await db.conversion.findMany({ orderBy: { unitId: 'asc' } });
    expect(rows.map((r) => [r.unitId, r.eventId])).toEqual([[UID_A, `${UID_A}.c1`], [UID_B, `${UID_B}.c1`]]);
  });

  it('a variant the browser got wrong is rejected by Holdout, not stored, and logged', async () => {
    const { site, split, x, logs } = await setup();
    const wrong = split.map((s) => s.key).find((k) => k !== assign(x.salt, UID_A, split))!;
    const res = await site(collect(UID_A, { events: [{ type: 'exposure', id: 'e1', experiment: 'checkout-button', variant: wrong }] }));
    expect(await res.json()).toMatchObject({ accepted: 0, rejected: 1 });
    expect(await db.exposure.count()).toBe(0);
    expect(logs).toContain('relay: variant_mismatch');
  });

  it('refuses before calling Holdout: no cookie, not JSON, too many events, bad ids or names, unknown types, oversize body', async () => {
    const { site, holdout } = await setup();
    const cases: [Request, number][] = [
      [collect(null, { events: [{ type: 'conversion', id: 'c', event: 'purchase' }] }), 400],
      [collect(UID_A, 'not json'), 400],
      [collect(UID_A, { events: [] }), 400],
      [collect(UID_A, { events: Array.from({ length: MAX_EVENTS + 1 }, (_, i) => ({ type: 'conversion', id: `c${i}`, event: 'purchase' })) }), 400],
      [collect(UID_A, { events: [{ type: 'conversion', id: 'has space', event: 'purchase' }] }), 400],
      [collect(UID_A, { events: [{ type: 'conversion', id: 'c', event: 'bad name!' }] }), 400],
      [collect(UID_A, { events: [{ type: 'pageview', id: 'c' }] }), 400],
      [collect(UID_A, { events: [{ type: 'conversion', id: 'c', event: 'purchase', pad: 'x'.repeat(70_000) }] }), 413],
      [collect('not-a-uuid', { events: [{ type: 'conversion', id: 'c', event: 'purchase' }] }), 400],
    ];
    for (const [req, status] of cases) expect((await site(req)).status).toBe(status);
    expect(holdout.pending()).toBe(0);
    expect(await db.conversion.count()).toBe(0);
  });

  it('the server-rendered page shows the same variant as the snippet computes, and logs that exposure', async () => {
    const { site, split, x } = await setup();
    const html = await (await site(get('/server', UID_B))).text();
    const v = assign(x.salt, UID_B, split);
    expect(html).toContain(`data-variant="${v}"`);
    const ex = await db.exposure.findMany({ include: { variant: true } });
    expect(ex.map((e) => [e.unitId, e.variant.key])).toEqual([[UID_B, v]]);
  });

  it('with a key that lacks the read scope the page still renders (no experiment, control button) and logs why', async () => {
    const { site, logs } = await setup({ scopes: ['ingest'] });
    const html = await (await site(get('/'))).text();
    expect(html).toMatch(/"experiments":\[\]/);
    expect(logs.some((l) => /refresh failed.*403/.test(l))).toBe(true);
  });

  it('serves the committed snippet and a 404 for anything else', async () => {
    const { site } = await setup();
    const js = await site(get('/holdout.js'));
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(await js.text()).toBe(SNIPPET_JS());
    expect((await site(get('/nope'))).status).toBe(404);
  });
});
