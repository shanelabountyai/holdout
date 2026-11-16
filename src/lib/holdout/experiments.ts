import { randomBytes } from 'node:crypto';
import { notFound } from 'next/navigation';
import { audit } from '@/core/audit';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { Prisma } from '@/generated/prisma/client';
import type { MetricKind } from '@/generated/prisma/enums';
import { BUCKETS, plannedUnitsPerArm, sampleSizeMeans, sampleSizeProportions, validateWeights } from '@/lib/exp';
import type { Readout } from './readout';
import { computeReadout } from './readout-data';

// Experiments (PRD "Flags & experiments", Phase 2). Design rules, the up-front plan (D-16) and the freeze (HO-01, D-18).
// The database triggers in 20261114000001_holdout_freeze refuse the same edits; these checks exist to say why in words.

export const LIMITS = { minVariants: 2, maxVariants: 4, maxGuardrails: 5, minWeightBps: 100 } as const; // D-25
export const DEFAULT_ALPHA = 0.05;
export const DEFAULT_POWER = 0.8;
export const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const EVENT_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

export type DesignInput = {
  key: string;
  name: string;
  description: string;
  metricEvent: string;
  metricKind: MetricKind;
  /** proportion: baseline conversion rate in (0, 1). */
  baselineRate?: number | null;
  /** mean: the current mean (display only) and standard deviation per unit. */
  baselineMean?: number | null;
  baselineSd?: number | null;
  /** Absolute: rate points (as a fraction) for a proportion, metric units for a mean. */
  mde: number;
  variants: { key: string; name: string; weight: number }[];
  guardrails: { event: string; kind: MetricKind }[];
};

export type Plan = { fixedUnitsPerArm: number; plannedUnitsPerArm: number; plannedTotalUnits: number };

const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * The planned sample size, fixed up front (PRD). Fixed-horizon n per arm at α/power for the primary metric, then
 * plannedUnitsPerArm(…, 'sequential'), which is 2× under D-16. The per-arm formula assumes equal arms, so with an unequal
 * split the smallest arm must reach it: total = per-arm n × 10 000 / smallest weight (D-20).
 */
export function planFor(d: Pick<DesignInput, 'metricKind' | 'baselineRate' | 'baselineSd' | 'mde' | 'variants'>, alpha = DEFAULT_ALPHA, power = DEFAULT_POWER): Plan {
  let fixed: number;
  if (d.metricKind === 'proportion') {
    if (!fin(d.baselineRate) || d.baselineRate <= 0 || d.baselineRate >= 1) throw new Refused('Baseline conversion rate must be between 0% and 100%.');
    if (!fin(d.mde) || d.mde === 0) throw new Refused('The minimum detectable effect must be a number other than 0.');
    const p2 = d.baselineRate + d.mde;
    if (p2 <= 0 || p2 >= 1) throw new Refused('Baseline plus the minimum detectable effect must stay between 0% and 100%.');
    fixed = sampleSizeProportions(d.baselineRate, d.mde, alpha, power);
  } else {
    if (!fin(d.baselineSd) || d.baselineSd <= 0) throw new Refused('The standard deviation must be a number above 0.');
    if (!fin(d.mde) || d.mde === 0) throw new Refused('The minimum detectable effect must be a number other than 0.');
    fixed = sampleSizeMeans(d.baselineSd, d.mde, alpha, power);
  }
  const fixedUnitsPerArm = Math.ceil(fixed);
  const perArm = plannedUnitsPerArm(fixed, 'sequential');
  const minWeight = Math.min(...d.variants.map((v) => v.weight));
  const total = Math.ceil((perArm * BUCKETS) / minWeight);
  if (!Number.isSafeInteger(total) || total > 2_000_000_000) throw new Refused('That plan needs more units than Holdout can track. Raise the minimum detectable effect.');
  return { fixedUnitsPerArm, plannedUnitsPerArm: perArm, plannedTotalUnits: total };
}

/** Normalises and checks a design; throws Refused with the first problem a person can fix. */
export function checkDesign(d: DesignInput): DesignInput {
  const key = d.key.trim();
  if (!KEY_RE.test(key)) throw new Refused('Key: lowercase letters, digits, - and _, starting with a letter or digit, up to 64 characters.');
  const name = d.name.trim();
  if (!name || name.length > 120) throw new Refused('Give the experiment a name of 1 to 120 characters.');
  if (d.description.length > 2000) throw new Refused('Description: up to 2000 characters.');
  if (!EVENT_RE.test(d.metricEvent)) throw new Refused('Primary metric event: letters, digits and _ . : - only, up to 100 characters.');
  const variants = d.variants.map((v) => ({ key: v.key.trim(), name: v.name.trim() || v.key.trim(), weight: v.weight }));
  if (variants.length < LIMITS.minVariants || variants.length > LIMITS.maxVariants) throw new Refused(`An experiment has ${LIMITS.minVariants} to ${LIMITS.maxVariants} variants.`);
  for (const v of variants) {
    if (!KEY_RE.test(v.key)) throw new Refused(`Variant key "${v.key}": lowercase letters, digits, - and _ only.`);
    if (v.name.length > 80) throw new Refused('Variant names: up to 80 characters.');
    if (!Number.isInteger(v.weight) || v.weight < LIMITS.minWeightBps) throw new Refused(`Every variant needs at least ${LIMITS.minWeightBps / 100}% of traffic, in steps of 0.01%.`);
  }
  try {
    validateWeights(variants);
  } catch (e) {
    const msg = (e as Error).message;
    throw new Refused(msg.startsWith('weights sum') ? 'Variant weights must add up to exactly 100%.' : `Variants: ${msg}.`);
  }
  if (d.guardrails.length > LIMITS.maxGuardrails) throw new Refused(`Up to ${LIMITS.maxGuardrails} guardrail metrics.`);
  const seen = new Set<string>();
  for (const g of d.guardrails) {
    if (!EVENT_RE.test(g.event)) throw new Refused(`Guardrail event "${g.event}": letters, digits and _ . : - only.`);
    if (g.event === d.metricEvent) throw new Refused('A guardrail cannot be the primary metric.');
    if (seen.has(g.event)) throw new Refused(`Guardrail "${g.event}" is listed twice.`);
    seen.add(g.event);
  }
  const proportion = d.metricKind === 'proportion';
  return {
    ...d,
    key,
    name,
    variants,
    baselineRate: proportion ? d.baselineRate ?? null : null,
    baselineMean: proportion ? null : d.baselineMean ?? null,
    baselineSd: proportion ? null : d.baselineSd ?? null,
  };
}

const columns = (d: DesignInput, p: Plan) => ({
  key: d.key,
  name: d.name,
  description: d.description,
  metricEvent: d.metricEvent,
  metricKind: d.metricKind,
  baselineRate: d.baselineRate ?? null,
  baselineMean: d.baselineMean ?? null,
  baselineSd: d.baselineSd ?? null,
  mde: d.mde,
  alpha: DEFAULT_ALPHA,
  power: DEFAULT_POWER,
  ...p,
});

async function writeChildren(tx: Tx, orgId: string, experimentId: string, d: DesignInput) {
  await tx.variant.createMany({ data: d.variants.map((v, position) => ({ orgId, experimentId, key: v.key, name: v.name, weight: v.weight, position })) });
  if (d.guardrails.length) await tx.guardrail.createMany({ data: d.guardrails.map((g, position) => ({ orgId, experimentId, event: g.event, kind: g.kind, position })) });
}

const keyTaken = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export async function createExperiment(ctx: OrgCtx, input: DesignInput): Promise<string> {
  const d = checkDesign(input);
  const p = planFor(d);
  try {
    return await withOrg(ctx, async (tx) => {
      const x = await tx.experiment.create({ data: { ...inOrg(ctx), ...columns(d, p), salt: randomBytes(12).toString('hex'), createdById: ctx.userId } });
      await writeChildren(tx, ctx.orgId, x.id, d);
      await audit(ctx, 'experiment.created', { targetType: 'experiment', targetId: x.id, data: { key: d.key, ...p } }, tx);
      return x.id;
    });
  } catch (e) {
    if (keyTaken(e)) throw new Refused(`Another experiment in this org already uses the key "${d.key}".`);
    throw e;
  }
}

/** The experiment, locked for this transaction, or 404 (not yours ≡ not found, INV-04). */
async function locked(tx: Tx, ctx: { orgId: string }, id: string) {
  const rows = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status"::text AS "status" FROM "Experiment" WHERE "id" = ${id}::uuid AND "orgId" = ${ctx.orgId}::uuid FOR UPDATE`;
  return rows[0] ?? notFound();
}

const FROZEN = 'This experiment has started, so its variants, weights, metrics and plan are frozen (HO-01). To change them, create a new experiment.';

/**
 * Replace a draft's whole design. Refused once it has started. The design is built only after the row is found, so an id
 * from another org gets the same 404 as one that does not exist, whatever the form says (INV-02/04).
 */
export async function updateDraft(ctx: OrgCtx, id: string, input: DesignInput | (() => DesignInput)) {
  let key = '';
  try {
    await withOrg(ctx, async (tx) => {
      const x = await locked(tx, ctx, id);
      if (x.status !== 'draft') throw new Refused(FROZEN);
      const d = checkDesign(typeof input === 'function' ? input() : input);
      const p = planFor(d);
      key = d.key;
      await tx.variant.deleteMany({ where: { experimentId: id, ...inOrg(ctx) } });
      await tx.guardrail.deleteMany({ where: { experimentId: id, ...inOrg(ctx) } });
      await tx.experiment.update({ where: { id }, data: columns(d, p) });
      await writeChildren(tx, ctx.orgId, id, d);
      await audit(ctx, 'experiment.updated', { targetType: 'experiment', targetId: id, data: { key: d.key, ...p } }, tx);
    });
  } catch (e) {
    if (keyTaken(e)) throw new Refused(`Another experiment in this org already uses the key "${key}".`);
    throw e;
  }
}

/** Name and description stay editable after the start: they decide nothing. */
export async function renameExperiment(ctx: OrgCtx, id: string, name: string, description: string) {
  const n = name.trim();
  if (!n || n.length > 120) throw new Refused('Give the experiment a name of 1 to 120 characters.');
  if (description.length > 2000) throw new Refused('Description: up to 2000 characters.');
  await withOrg(ctx, async (tx) => {
    await locked(tx, ctx, id);
    await tx.experiment.update({ where: { id }, data: { name: n, description } });
    await audit(ctx, 'experiment.renamed', { targetType: 'experiment', targetId: id, data: { name: n } }, tx);
  });
}

export async function deleteDraft(ctx: OrgCtx, id: string) {
  await withOrg(ctx, async (tx) => {
    const x = await locked(tx, ctx, id);
    if (x.status !== 'draft') throw new Refused('Only a draft can be deleted. A started experiment keeps its record.');
    await tx.experiment.delete({ where: { id } });
    await audit(ctx, 'experiment.deleted', { targetType: 'experiment', targetId: id }, tx);
  });
}

/** draft → running. From here on the design is frozen (HO-01): the audit line keeps the exact design that went live. */
export async function startExperiment(ctx: OrgCtx, id: string) {
  await withOrg(ctx, async (tx) => {
    const x = await locked(tx, ctx, id);
    if (x.status !== 'draft') throw new Refused('This experiment has already started.');
    const variants = await tx.variant.findMany({ where: { experimentId: id, ...inOrg(ctx) }, orderBy: { position: 'asc' }, select: { key: true, weight: true, position: true } });
    try {
      validateWeights(variants);
    } catch {
      throw new Refused('Variant weights must add up to exactly 100% across at least two variants before the start.');
    }
    const startedAt = now();
    const e = await tx.experiment.update({ where: { id }, data: { status: 'running', startedAt }, select: { key: true, salt: true, plannedUnitsPerArm: true, plannedTotalUnits: true } });
    await audit(ctx, 'experiment.started', { targetType: 'experiment', targetId: id, data: { ...e, startedAt: startedAt.toISOString(), variants } }, tx);
  });
}

export const listExperiments = (ctx: { orgId: string }) =>
  withOrg(
    ctx,
    (tx) =>
      tx.experiment.findMany({
        where: inOrg(ctx),
        orderBy: { createdAt: 'desc' },
        include: { variants: { orderBy: { position: 'asc' } }, _count: { select: { exposures: true } } },
      }),
    { atomic: false },
  );

export async function getExperiment(ctx: { orgId: string }, id: string) {
  const x = await withOrg(
    ctx,
    async (tx) => {
      const e = await tx.experiment.findFirst({
        where: { id, ...inOrg(ctx) },
        include: { variants: { orderBy: { position: 'asc' } }, guardrails: { orderBy: { position: 'asc' } }, _count: { select: { exposures: true } } },
      });
      if (!e) return null;
      const events = [e.metricEvent, ...e.guardrails.map((g) => g.event)];
      const conversions = await tx.conversion.groupBy({ by: ['event'], where: { ...inOrg(ctx), event: { in: events } }, _count: { _all: true } });
      return { ...e, conversions: Object.fromEntries(conversions.map((c) => [c.event, c._count._all])) as Record<string, number> };
    },
    { atomic: false },
  );
  return x ?? notFound();
}

// ---- Phase 3: readout and stop (HO-04, HO-05)

export const MAX_STOP_REASON = 500;

async function forReadout(tx: Tx, ctx: { orgId: string }, id: string) {
  const x = await tx.experiment.findFirst({
    where: { id, ...inOrg(ctx) },
    include: { variants: { orderBy: { position: 'asc' } }, guardrails: { orderBy: { position: 'asc' } } },
  });
  return x ?? notFound();
}

/**
 * running → stopped (HO-05). One transaction: lock the row (ingest holds FOR SHARE on it, so no exposure lands
 * mid-stop), compute the readout at this instant, record the stop, and write `experiment.stopped` with that readout. The
 * stopped experiment's page shows this stored readout, so what was decided on is what stays on record.
 */
export async function stopExperiment(ctx: OrgCtx, id: string, reason: string): Promise<Readout> {
  const why = reason.trim();
  if (why.length > MAX_STOP_REASON) throw new Refused(`Reason: up to ${MAX_STOP_REASON} characters.`);
  return withOrg(ctx, async (tx) => {
    const row = await locked(tx, ctx, id);
    if (row.status === 'draft') throw new Refused('A draft has not started, so there is nothing to stop. Delete it instead.');
    if (row.status !== 'running') throw new Refused('This experiment has already stopped.');
    const x = await forReadout(tx, ctx, id);
    const stoppedAt = now();
    const readout = await computeReadout(tx, { ...x, startedAt: x.startedAt! }, stoppedAt);
    await tx.experiment.update({ where: { id }, data: { status: 'stopped', stoppedAt } });
    await audit(ctx, 'experiment.stopped', { targetType: 'experiment', targetId: id, data: { key: x.key, reason: why, stoppedAt: stoppedAt.toISOString(), readout } }, tx);
    return readout;
  });
}

/**
 * The readout to show: computed now for a running experiment; for a stopped one, the readout stored with the stop
 * (HO-05). null for a draft.
 */
export async function getReadout(ctx: { orgId: string }, id: string): Promise<{ readout: Readout; stored: boolean } | null> {
  return withOrg(ctx, async (tx) => {
    const x = await forReadout(tx, ctx, id);
    if (x.status === 'draft' || !x.startedAt) return null;
    if (x.status === 'stopped') {
      const ev = await tx.auditEvent.findFirst({ where: { ...inOrg(ctx), action: 'experiment.stopped', targetType: 'experiment', targetId: id }, orderBy: { id: 'desc' } });
      const data = ev?.data as { readout?: Readout } | null | undefined;
      if (data?.readout) return { readout: data.readout, stored: true };
      return { readout: await computeReadout(tx, { ...x, startedAt: x.startedAt }, x.stoppedAt ?? now()), stored: false };
    }
    return { readout: await computeReadout(tx, { ...x, startedAt: x.startedAt }, now()), stored: false };
  }, { atomic: false });
}

/** The experiment's own lines in the org audit log, newest first. */
export const experimentHistory = (ctx: { orgId: string }, id: string) =>
  withOrg(ctx, (tx) => tx.auditEvent.findMany({ where: { ...inOrg(ctx), targetType: 'experiment', targetId: id }, orderBy: { id: 'desc' }, take: 50 }), { atomic: false });
