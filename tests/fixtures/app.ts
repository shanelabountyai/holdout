import { createHash, randomUUID } from 'node:crypto';
import { now } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)

// CLONE-OWNED. The INV-01..04 harness seeds these rows in both fixture orgs, so it can drive
// actions whose inputs use ref('<model>') for the clone's own tables. Return { model: id } for
// one row of each model, owned by `org.orgId`. INV-29 (RLS enforce) calls it too, so every org-owned clone table has rows to scope.
//
// Holdout: a draft experiment (the ref the experiment actions take, so start/edit/delete really run for the owner) and a
// running one carrying an exposure, plus a conversion, so every Holdout table has rows in both orgs. The running one is
// ref('runningExperiment'), which the stop action takes (Phase 3), so the harness's owner call really stops it.
export async function seedApp(org: { orgId: string; userId: string }, key: 'a' | 'b'): Promise<Record<string, string>> {
  const { orgId, userId } = org;
  // Ids and keys derive from the org: the harness reseeds before every call and must find the same ref each time.
  const h = (s: string) => createHash('sha256').update(`${orgId}:${s}`).digest('hex');
  const uuid = (s: string) => { const x = h(s); return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`; };
  const tag = `${key}-${h('tag').slice(0, 6)}`;
  const base = {
    orgId, name: `Experiment ${tag}`, metricEvent: 'signup', metricKind: 'proportion' as const, baselineRate: 0.1, mde: 0.02,
    fixedUnitsPerArm: 3841, plannedUnitsPerArm: 7682, plannedTotalUnits: 15364, createdById: userId,
  };
  const draft = await db.experiment.create({ data: { ...base, id: uuid('draft'), key: `draft-${tag}`, salt: h('salt-draft').slice(0, 24) } });
  const running = await db.experiment.create({ data: { ...base, id: uuid('live'), key: `live-${tag}`, salt: h('salt-live').slice(0, 24) } });
  for (const x of [draft, running]) {
    await db.variant.createMany({ data: [
      { orgId, experimentId: x.id, key: 'control', name: 'Control', weight: 5000, position: 0 },
      { orgId, experimentId: x.id, key: 'treatment', name: 'Treatment', weight: 5000, position: 1 },
    ] });
    await db.guardrail.create({ data: { orgId, experimentId: x.id, event: 'refund', kind: 'proportion', position: 0 } });
  }
  const t = now();
  await db.experiment.update({ where: { id: running.id }, data: { status: 'running', startedAt: t } });
  const variant = await db.variant.findFirstOrThrow({ where: { experimentId: running.id, position: 0 } });
  await db.exposure.create({ data: { orgId, experimentId: running.id, variantId: variant.id, unitId: `u-${tag}`, eventId: randomUUID(), occurredAt: t, receivedAt: t } });
  await db.conversion.create({ data: { orgId, eventId: randomUUID(), event: 'signup', unitId: `u-${tag}`, occurredAt: t, receivedAt: t } });
  return { experiment: draft.id, runningExperiment: running.id };
}

// CLONE-OWNED. The clone's models with no orgId column, i.e. outside tenancy and RLS on purpose (INV-42, v1.7.0). Name
// each one with a comment saying why; a model without orgId that is not here (or in core's list) fails INV-42.
export const GLOBAL_MODELS: readonly string[] = [];
