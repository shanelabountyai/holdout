import { beforeEach, describe, expect, it } from 'vitest';
import { advanceClock, now } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system';
import { assign, mulberry32, srmCheck } from '@/lib/exp';
import { createExperiment, startExperiment } from '@/lib/holdout/experiments';
import { MAX_BATCH } from '@/lib/holdout/ingest';
import * as config from '@/app/api/v1/experiments/route';
import * as ingestRoute from '@/app/api/v1/ingest/route';
import { resetAuthTables } from '../helpers/auth';
import { conversionDesign, ingestKey, org, req } from './helpers';

beforeEach(async () => {
  await resetAuthTables();
  advanceClock(0);
});

const post = (key: string | null, body: unknown) => ingestRoute.POST(req('/ingest', key, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
const send = async (key: string, events: unknown[]) => {
  const res = await post(key, { events });
  expect(res.status).toBe(200);
  return (await res.json()) as { accepted: number; duplicates: number; rejected: { index: number; code: string; detail: string }[] };
};
const exposure = (unitId: string, over: object = {}) => ({ type: 'exposure', id: `x-${unitId}`, experiment: 'checkout-button', unitId, ...over });
const conversion = (id: string, unitId: string, over: object = {}) => ({ type: 'conversion', id, event: 'purchase', unitId, ...over });

async function running(slug = 'acme') {
  const a = await org(slug);
  const id = await createExperiment(a.owner, conversionDesign());
  await startExperiment(a.owner, id);
  const key = await ingestKey(a.owner);
  const x = await db.experiment.findUniqueOrThrow({ where: { id }, include: { variants: { orderBy: { position: 'asc' } } } });
  return { a, id, key, x };
}

describe('ingest auth (foundation apikeys module)', () => {
  it('no key 401; a key without the ingest scope 403; nothing stored', async () => {
    const { a } = await running();
    const readOnly = await ingestKey(a.owner, ['read']);
    expect((await post(null, { events: [exposure('u1')] })).status).toBe(401);
    const res = await post(readOnly, { events: [exposure('u1')] });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN_SCOPE');
    expect(await db.exposure.count()).toBe(0);
  });

  it("an experiment key from another org is unknown, the same answer as one that does not exist (INV-40)", async () => {
    const { key } = await running('acme');
    const b = await org('globex');
    const theirs = await createExperiment(b.owner, conversionDesign({ key: 'globex-only' }));
    await startExperiment(b.owner, theirs);
    const r = await send(key, [exposure('u1', { experiment: 'globex-only' }), exposure('u2', { experiment: 'no-such-key' })]);
    expect(r.rejected.map((x) => x.code)).toEqual(['unknown_experiment', 'unknown_experiment']);
    expect(r.rejected[0]!.detail.replace('globex-only', 'K')).toBe(r.rejected[1]!.detail.replace('no-such-key', 'K'));
    expect(await db.exposure.count()).toBe(0);
  });
});

describe('ingest: exposures (D-19)', () => {
  it('stores the server-side assignment for each unit; first exposure wins; a retried batch is all duplicates', async () => {
    const { key, x } = await running();
    const units = Array.from({ length: 300 }, (_, i) => `user-${i}`);
    const r1 = await send(key, units.map((u) => exposure(u)));
    expect(r1).toEqual({ accepted: 300, duplicates: 0, rejected: [] });
    const rows = await db.exposure.findMany({ include: { variant: true } });
    for (const row of rows) expect(row.variant.key).toBe(assign(x.salt, row.unitId, x.variants));

    expect(await send(key, units.map((u) => exposure(u)))).toEqual({ accepted: 0, duplicates: 300, rejected: [] });
    expect(await send(key, [exposure('new-1'), exposure('new-1', { id: 'other-id' }), exposure('user-0')])).toEqual({ accepted: 1, duplicates: 2, rejected: [] });
    expect(await db.exposure.count()).toBe(301);
  });

  it('a client variant that disagrees with assign() is rejected; one that agrees is accepted', async () => {
    const { key, x } = await running();
    const right = assign(x.salt, 'u1', x.variants);
    const wrong = x.variants.find((v) => v.key !== right)!.key;
    const r = await send(key, [exposure('u1', { variant: wrong }), exposure('u1', { variant: right, id: 'x2' })]);
    expect(r.accepted).toBe(1);
    expect(r.rejected).toEqual([{ index: 0, code: 'variant_mismatch', detail: expect.stringContaining(`assigned to "${right}"`) }]);
  });

  it('a draft experiment takes no exposures; nor does a timestamp before its start', async () => {
    const a = await org('acme');
    await createExperiment(a.owner, conversionDesign());
    const key = await ingestKey(a.owner);
    expect((await send(key, [exposure('u1')])).rejected.map((x) => x.code)).toEqual(['experiment_not_running']);
    const id = (await db.experiment.findFirstOrThrow()).id;
    await startExperiment(a.owner, id);
    const early = new Date(now().getTime() - 60_000).toISOString();
    expect((await send(key, [exposure('u1', { timestamp: early })])).rejected.map((x) => x.code)).toEqual(['before_start']);
  });

  it('a simulated 50/50 stream through ingest passes the SRM check (the split is the configured one)', async () => {
    const { key, x } = await running();
    const rnd = mulberry32(7);
    for (let batch = 0; batch < 8; batch++) {
      const evs = Array.from({ length: MAX_BATCH }, (_, i) => exposure(`u-${batch}-${i}-${Math.floor(rnd() * 1e9)}`));
      expect((await send(key, evs)).accepted).toBe(MAX_BATCH);
    }
    const counts = await Promise.all(x.variants.map((v) => db.exposure.count({ where: { variantId: v.id } })));
    expect(counts.reduce((s, c) => s + c, 0)).toBe(8 * MAX_BATCH);
    expect(srmCheck(counts, x.variants.map((v) => v.weight)).blocked).toBe(false);
  });
});

describe('ingest: conversions and the envelope', () => {
  it('conversions dedupe on the client event id, keep value and timestamp, and are not tied to an experiment', async () => {
    const { key } = await running();
    const ts = new Date(now().getTime() - 3_600_000).toISOString();
    const r = await send(key, [conversion('c1', 'u1', { value: 12.5, timestamp: ts }), conversion('c1', 'u1'), conversion('c2', 'u1', { event: 'refund' })]);
    expect(r).toEqual({ accepted: 2, duplicates: 1, rejected: [] });
    const c1 = await db.conversion.findFirstOrThrow({ where: { eventId: 'c1' } });
    expect([c1.event, c1.value, c1.occurredAt.toISOString()]).toEqual(['purchase', 12.5, ts]);
    expect((await send(key, [conversion('c1', 'u1')])).duplicates).toBe(1);
  });

  it('one bad event is rejected by index and never sinks the rest', async () => {
    const { key } = await running();
    const future = new Date(now().getTime() + 10 * 60_000).toISOString();
    const old = new Date(now().getTime() - 8 * 86_400_000).toISOString();
    const r = await send(key, [
      exposure('ok-1'),
      { type: 'exposure', id: 'no-unit', experiment: 'checkout-button' },
      { type: 'click', id: 'x', unitId: 'u' },
      conversion('bad-name', 'u', { event: 'has spaces' }),
      conversion('f', 'u', { timestamp: future }),
      conversion('o', 'u', { timestamp: old }),
      exposure('extra', { color: 'red' }),
      conversion('ok-2', 'u'),
    ]);
    expect(r.accepted).toBe(2);
    expect(r.rejected.map((x) => [x.index, x.code])).toEqual([[1, 'invalid'], [2, 'invalid'], [3, 'invalid'], [4, 'timestamp_in_future'], [5, 'timestamp_too_old'], [6, 'invalid']]);
  });

  it('the envelope must be JSON with 1 to 500 events (400), and nothing is stored', async () => {
    const { key } = await running();
    for (const body of ['not json', { events: [] }, { events: Array.from({ length: MAX_BATCH + 1 }, (_, i) => exposure(`u${i}`)) }, { events: [exposure('u')], extra: 1 }, [exposure('u')]]) {
      const res = await post(key, body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect((await res.json()).code).toBe('VALIDATION');
    }
    expect(await db.exposure.count()).toBe(0);
  });
});

describe('GET /api/v1/experiments: assignment config', () => {
  it('lists only running experiments of the key\'s org, variants in frozen order, enough to reproduce assign()', async () => {
    const { a, key, x } = await running('acme');
    await createExperiment(a.owner, conversionDesign({ key: 'still-draft' }));
    const b = await org('globex');
    const theirs = await createExperiment(b.owner, conversionDesign({ key: 'globex-only' }));
    await startExperiment(b.owner, theirs);

    const res = await config.GET(req('/experiments', key));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{ key: 'checkout-button', salt: x.salt, startedAt: x.startedAt!.toISOString(), variants: [{ key: 'control', weight: 5000 }, { key: 'treatment', weight: 5000 }] }]);
    const cfg = body.data[0];
    for (const u of ['a', 'b', 'c', 'd']) expect(assign(cfg.salt, u, cfg.variants)).toBe(assign(x.salt, u, x.variants));
    expect((await config.GET(req('/experiments', null))).status).toBe(401);
  });
});
