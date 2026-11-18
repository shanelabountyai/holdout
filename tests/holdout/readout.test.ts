import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { advanceClock, now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system';
import { assign, diffMeans, diffProportions, mulberry32 } from '@/lib/exp';
import { createExperiment, experimentHistory, getReadout, startExperiment, stopExperiment } from '@/lib/holdout/experiments';
import { ingest } from '@/lib/holdout/ingest';
import type { Readout } from '@/lib/holdout/readout';
import { computeReadout } from '@/lib/holdout/readout-data';
import { haltExperiment } from '@/app/o/[org]/experiments/actions';
import { resetAuthTables } from '../helpers/auth';
import { NavSignal } from '../helpers/next';
import { actAs, addMember } from '../helpers/org';
import { conversionDesign, meanDesign, org } from './helpers';

// Phase 3 readout against the database: the numbers on the page are the engine's numbers on what was ingested (D-28/29),
// SRM blocks the readout (HO-04), stopping writes the readout at that moment to the audit log (HO-05), guardrails hold a
// ship (D-31).

beforeEach(async () => {
  await resetAuthTables();
  advanceClock(0);
});
afterAll(async () => {
  advanceClock(0);
  await resetAuthTables(); // leave no 'acme' org behind: e2e's demo seed expects to create it (NEXT.md e2e trap)
});

const DAY = 86_400_000;
type Ev = Record<string, unknown>;

async function send(ctx: { orgId: string }, events: Ev[]) {
  const out = { accepted: 0, duplicates: 0, rejected: [] as { code: string }[] };
  for (let i = 0; i < events.length; i += 500) {
    const r = await ingest(ctx, events.slice(i, i + 500), now());
    out.accepted += r.accepted;
    out.duplicates += r.duplicates;
    out.rejected.push(...r.rejected);
  }
  return out;
}

async function running(design = conversionDesign(), slug = 'acme') {
  const a = await org(slug);
  const id = await createExperiment(a.owner, design);
  await startExperiment(a.owner, id);
  advanceClock(1000); // exposures must not predate the start
  const x = await db.experiment.findUniqueOrThrow({ where: { id }, include: { variants: { orderBy: { position: 'asc' } }, guardrails: true } });
  return { a, id, x };
}

const exposure = (key: string, unitId: string): Ev => ({ type: 'exposure', id: `x-${key}-${unitId}`, experiment: key, unitId });
const conv = (event: string, unitId: string, over: Ev = {}): Ev => ({ type: 'conversion', id: randomUUID(), event, unitId, ...over });

/** Units u0..u(n-1); each converts with the arm's rate; returns what was sent, by variant key. */
function traffic(x: { key: string; salt: string; variants: { key: string; weight: number }[] }, n: number, rate: Record<string, number>, seed = 28, event = 'purchase') {
  const rand = mulberry32(seed);
  const events: Ev[] = [];
  const truth = new Map<string, { units: number; converters: number }>(x.variants.map((v) => [v.key, { units: 0, converters: 0 }]));
  for (let i = 0; i < n; i++) {
    const u = `u${i}`;
    const v = assign(x.salt, u, x.variants);
    events.push(exposure(x.key, u));
    const t = truth.get(v)!;
    t.units++;
    if (rand() < rate[v]!) {
      t.converters++;
      events.push(conv(event, u), conv(event, u)); // a second purchase: still one converter
    }
  }
  return { events, truth };
}

describe('readout numbers are the engine on what was ingested (D-28, D-29)', () => {
  it('proportion: per-arm units and converters, fixed-horizon = diffProportions, and only post-exposure, same-org conversions count', async () => {
    const { a, id, x } = await running();
    const { events, truth } = traffic(x, 1200, { control: 0.1, treatment: 0.14 });
    const sent = await send(a.owner, events);
    expect(sent.rejected).toEqual([]);
    // Noise that must not count: a purchase before the unit's exposure, and another org's purchase by the same unit id.
    const fresh = `late-${randomUUID()}`;
    await send(a.owner, [conv('purchase', fresh, { timestamp: new Date(now().getTime() - 60_000).toISOString() })]);
    await send(a.owner, [exposure(x.key, fresh)]);
    const b = await org('globex');
    await send(b.owner, [conv('purchase', 'u0'), conv('purchase', 'u1'), conv('purchase', 'u2')]);

    const { readout: r, stored } = (await getReadout(a.owner, id))!;
    expect(stored).toBe(false);
    const freshArm = assign(x.salt, fresh, x.variants);
    const units = x.variants.map((v) => truth.get(v.key)!.units + (v.key === freshArm ? 1 : 0));
    expect(r.arms.map((v) => v.units)).toEqual(units);
    expect(r.arms.map((v) => v.units)).toEqual(await Promise.all(x.variants.map((v) => db.exposure.count({ where: { variantId: v.id } }))));
    const [c, t] = x.variants.map((v, i) => ({ conversions: truth.get(v.key)!.converters, units: units[i]! }));
    expect(r.arms.map((v) => v.level)).toEqual([c!.conversions / c!.units, t!.conversions / t!.units]);
    const f = diffProportions(c!, t!, 0.05);
    expect(r.comparisons![0]!.fixed).toEqual({ p: f.p, ciLow: f.ciLow, ciHigh: f.ciHigh, se: f.se });
    expect(r.plannedUnitsPerArm).toBe(7682); // the stored D-16 horizon
  });

  it('mean: a unit is the sum of its values after exposure; an event without a value adds 0; units without events are 0', async () => {
    const { a, id, x } = await running(meanDesign());
    const rand = mulberry32(7);
    const events: Ev[] = [];
    const vals = new Map<string, number[]>(x.variants.map((v) => [v.key, []]));
    for (let i = 0; i < 400; i++) {
      const u = `u${i}`;
      const v = assign(x.salt, u, x.variants);
      events.push(exposure(x.key, u));
      let y = 0;
      const k = Math.floor(rand() * 3); // 0, 1 or 2 orders
      for (let j = 0; j < k; j++) {
        const value = Math.round(rand() * 2000) / 100;
        y += value;
        events.push(conv('order', u, { value }));
      }
      if (i % 10 === 0) events.push(conv('order', u)); // no value: adds 0
      vals.get(v)!.push(y);
    }
    await send(a.owner, events);
    const { readout: r } = (await getReadout(a.owner, id))!;
    const s = (ys: number[]) => {
      const n = ys.length;
      const mean = ys.reduce((p, q) => p + q, 0) / n;
      return { n, mean, variance: ys.reduce((p, q) => p + (q - mean) ** 2, 0) / (n - 1) };
    };
    const [sa, sb] = x.variants.map((v) => s(vals.get(v.key)!));
    r.arms.forEach((arm, i) => expect(arm.level).toBeCloseTo([sa!, sb!][i]!.mean, 9));
    const f = diffMeans(sa!, sb!, 0.05);
    if ('notEnoughData' in f) throw new Error('unexpected');
    expect(r.comparisons![0]!.fixed!.p).toBeCloseTo(f.p, 9);
    expect(r.comparisons![0]!.fixed!.ciLow).toBeCloseTo(f.ciLow, 9);
  });

  it('looks are UTC days by receipt: the always-valid p never rises as days are added (past looks are fixed)', async () => {
    const { a, id, x } = await running();
    const ps: number[] = [];
    for (let day = 0; day < 4; day++) {
      if (day) advanceClock(day * DAY + 1000);
      const base = day * 600;
      const rand = mulberry32(100 + day);
      const ev: Ev[] = [];
      for (let i = base; i < base + 600; i++) {
        const u = `u${i}`;
        ev.push(exposure(x.key, u));
        if (rand() < (assign(x.salt, u, x.variants) === 'treatment' ? 0.12 : 0.1)) ev.push(conv('purchase', u));
      }
      await send(a.owner, ev);
      const { readout: r } = (await getReadout(a.owner, id))!;
      expect(r.looks).toBe(Math.floor((now().getTime() - Math.floor(x.startedAt!.getTime() / DAY) * DAY) / DAY) + 1);
      ps.push(r.comparisons ? r.comparisons[0]!.sequential.p : 1);
    }
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeLessThanOrEqual(ps[i - 1]!);
  });

  it('a draft has no readout; another org cannot read one (404, INV-04)', async () => {
    const a = await org('acme');
    const draft = await createExperiment(a.owner, conversionDesign());
    expect(await getReadout(a.owner, draft)).toBeNull();
    const b = await org('globex');
    await expect(getReadout(b.owner, draft)).rejects.toThrow(NavSignal);
  });
});

describe('HO-04: sample-ratio mismatch blocks the readout', () => {
  it('a skewed split (written around the app) gives "srm" with no effect; the healthy split does not', async () => {
    const { a, id, x } = await running();
    const healthy = traffic(x, 2000, { control: 0.1, treatment: 0.1 });
    await send(a.owner, healthy.events);
    expect((await getReadout(a.owner, id))!.readout.srm.blocked).toBe(false);
    // 400 more exposures, all to control, as a broken client or a logging bug would produce.
    const t = now();
    await db.exposure.createMany({ data: Array.from({ length: 400 }, (_, i) => ({ orgId: a.orgId, experimentId: id, variantId: x.variants[0]!.id, unitId: `skew-${i}`, eventId: `skew-${i}`, occurredAt: t, receivedAt: t })) });
    const { readout: r } = (await getReadout(a.owner, id))!;
    expect(r.srm.blocked).toBe(true);
    expect(r.srm.p).toBeLessThan(0.001);
    expect(r.decision.state).toBe('srm');
    expect(r.comparisons).toBeNull();
    expect(r.guardrails).toBeNull();
    expect(r.arms.every((arm) => arm.level === null)).toBe(true);
  });
});

describe('HO-05: stopping writes an audit event with the readout at that moment', () => {
  it('one experiment.stopped event whose readout equals the readout as of stoppedAt; later events do not change it', async () => {
    const { a, id, x } = await running();
    await send(a.owner, traffic(x, 1500, { control: 0.1, treatment: 0.13 }).events);
    advanceClock(5000);
    const returned = await stopExperiment(a.owner, id, '  Enough data for the review.  ');

    const e = await db.experiment.findUniqueOrThrow({ where: { id }, include: { variants: true, guardrails: true } });
    expect(e.status).toBe('stopped');
    const events = await db.auditEvent.findMany({ where: { action: 'experiment.stopped', targetId: id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).toBe(a.ownerId);
    const data = events[0]!.data as { key: string; reason: string; stoppedAt: string; readout: Readout };
    expect(data.key).toBe(x.key);
    expect(data.reason).toBe('Enough data for the review.');
    expect(data.stoppedAt).toBe(e.stoppedAt!.toISOString());
    const recomputed = await withOrg(a.owner, (tx) => computeReadout(tx, { ...e, startedAt: e.startedAt! }, e.stoppedAt!));
    expect(data.readout).toEqual(recomputed);
    expect(data.readout).toEqual(returned);
    expect(data.readout.asOf).toBe(e.stoppedAt!.toISOString());
    // 1 500 units is below the 9 835 at which the SRM check can see an 8% loss (D-41), so a winner here is reported as
    // srm_unchecked, never ship. The salt is random per experiment, so which of the two depends on the split.
    expect(['srm_unchecked', 'keep_running']).toContain(data.readout.decision.state);

    // After the stop: exposures are refused (Phase 2 trigger), conversions are stored, the page keeps the stopped readout.
    advanceClock(60_000);
    const after = await send(a.owner, [exposure(x.key, 'new-unit'), ...Array.from({ length: 200 }, (_, i) => conv('purchase', `u${i}`, { id: `late-${i}` }))]);
    expect(after.rejected.map((r) => r.code)).toEqual(['experiment_not_running']);
    expect(after.accepted).toBe(200);
    const shown = (await getReadout(a.owner, id))!;
    expect(shown.stored).toBe(true);
    expect(shown.readout).toEqual(data.readout);

    const history = await experimentHistory(a.owner, id);
    expect(history.map((h) => h.action)).toEqual(['experiment.stopped', 'experiment.started', 'experiment.created']);
  });

  it('an SRM-blocked experiment can be stopped, and the stop records the SRM state', async () => {
    const { a, id, x } = await running();
    const t = now();
    await db.exposure.createMany({ data: Array.from({ length: 300 }, (_, i) => ({ orgId: a.orgId, experimentId: id, variantId: x.variants[i < 200 ? 0 : 1]!.id, unitId: `s${i}`, eventId: `s${i}`, occurredAt: t, receivedAt: t })) });
    advanceClock(2000);
    const r = await stopExperiment(a.owner, id, '');
    expect(r.decision.state).toBe('srm');
    const ev = await db.auditEvent.findFirstOrThrow({ where: { action: 'experiment.stopped', targetId: id } });
    expect((ev.data as { readout: Readout }).readout.decision.state).toBe('srm');
  });

  it('only a running experiment stops, once; a member cannot stop; another org gets 404', async () => {
    const { a, id } = await running();
    const draft = await createExperiment(a.owner, conversionDesign({ key: 'still-draft' }));
    await expect(stopExperiment(a.owner, draft, '')).rejects.toThrow(/nothing to stop/);
    const b = await org('globex');
    await expect(stopExperiment(b.owner, id, '')).rejects.toThrow(NavSignal);
    await expect(stopExperiment(a.owner, id, 'x'.repeat(501))).rejects.toThrow(/500/);

    const member = await addMember(a.orgId, 'member', 'member@acme.test');
    await actAs(member.id, 'acme');
    await expect(haltExperiment('acme', { id, reason: '' })).rejects.toThrow(/org\.update/);
    expect((await db.experiment.findUniqueOrThrow({ where: { id } })).status).toBe('running');

    await actAs(a.ownerId, 'acme');
    await expect(haltExperiment('acme', { id, reason: 'done' })).rejects.toThrow(/redirect/);
    expect((await db.experiment.findUniqueOrThrow({ where: { id } })).status).toBe('stopped');
    await expect(stopExperiment(a.owner, id, '')).rejects.toThrow(/already stopped/);
    expect(await db.auditEvent.count({ where: { action: 'experiment.stopped', targetId: id } })).toBe(1);
  });
});

describe('guardrails through ingest (D-31)', () => {
  it('a winner whose guardrail rose is held; the readout names the guardrail', async () => {
    const { a, id, x } = await running();
    const rand = mulberry32(3);
    const ev: Ev[] = [];
    for (let i = 0; i < 3000; i++) {
      const u = `u${i}`;
      const t = assign(x.salt, u, x.variants) === 'treatment';
      ev.push(exposure(x.key, u));
      if (rand() < (t ? 0.16 : 0.1)) ev.push(conv('purchase', u));
      if (rand() < (t ? 0.08 : 0.02)) ev.push(conv('refund', u));
    }
    await send(a.owner, ev);
    const { readout: r } = (await getReadout(a.owner, id))!;
    expect(r.comparisons![0]!.verdict).toBe('better');
    expect(r.guardrails![0]!.comparisons[0]!.moved).toBe('up');
    expect(r.decision.state).toBe('guardrail');
    expect(r.decision.detail).toContain('refund moved up');
  });
});
