import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { assign, mulberry32 } from '@/lib/exp';
import { createExperiment, startExperiment, updateDraft } from '@/lib/holdout/experiments';
import { resetAuthTables } from '../helpers/auth';
import { conversionDesign, org } from './helpers';

// HO-01 "a unit's assignment never changes for a running experiment", Phase 2 half: assign() is pure (Phase 1, golden
// file), so what could move a unit is the stored input, the salt and the variants' weights and order. Once an experiment
// leaves draft the database itself refuses every change to them (migration 20261114000001_holdout_freeze, D-18). These
// tests write as the database owner with raw SQL, i.e. around the app, to prove the rule holds for any writer.

beforeEach(resetAuthTables);
afterAll(resetAuthTables); // leave no 'acme' org behind: e2e's demo seed expects to create it (NEXT.md e2e trap)

const sql = (q: string, ...args: unknown[]) => db.$executeRawUnsafe(q, ...args);
const HO01 = /HO-01/;

async function setup(started: boolean) {
  const a = await org('acme');
  const id = await createExperiment(a.owner, conversionDesign());
  if (started) await startExperiment(a.owner, id);
  const [v0, v1] = await db.variant.findMany({ where: { experimentId: id }, orderBy: { position: 'asc' } });
  const g = await db.guardrail.findFirstOrThrow({ where: { experimentId: id } });
  return { a, id, v0: v0!, v1: v1!, g };
}

// Every edit that could move a unit or change what counts as a win. Each returns a promise of the raw statement.
const edits = ({ id, v0, v1, g, a }: Awaited<ReturnType<typeof setup>>): [string, () => Promise<unknown>][] => [
  ['ramp: change a weight', () => db.$transaction([db.$executeRawUnsafe(`UPDATE "Variant" SET "weight" = 9000 WHERE "id" = $1::uuid`, v0.id), db.$executeRawUnsafe(`UPDATE "Variant" SET "weight" = 1000 WHERE "id" = $1::uuid`, v1.id)])],
  ['reorder: swap positions', () => db.$transaction([sql(`UPDATE "Variant" SET "position" = 9 WHERE "id" = $1::uuid`, v0.id), sql(`UPDATE "Variant" SET "position" = 0 WHERE "id" = $1::uuid`, v1.id), sql(`UPDATE "Variant" SET "position" = 1 WHERE "id" = $1::uuid`, v0.id)])],
  ['rename a variant key', () => sql(`UPDATE "Variant" SET "key" = 'renamed' WHERE "id" = $1::uuid`, v0.id)],
  ['add a variant', () => sql(`INSERT INTO "Variant" ("id","orgId","experimentId","key","name","weight","position") VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'c', 'C', 0, 2)`, a.orgId, id)],
  ['remove a variant', () => sql(`DELETE FROM "Variant" WHERE "id" = $1::uuid`, v1.id)],
  ['change a guardrail', () => sql(`UPDATE "Guardrail" SET "event" = 'other' WHERE "id" = $1::uuid`, g.id)],
  ['add a guardrail', () => sql(`INSERT INTO "Guardrail" ("id","orgId","experimentId","event","kind","position") VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'new', 'mean', 1)`, a.orgId, id)],
  ['remove a guardrail', () => sql(`DELETE FROM "Guardrail" WHERE "id" = $1::uuid`, g.id)],
  ['change the salt', () => sql(`UPDATE "Experiment" SET "salt" = 'other' WHERE "id" = $1::uuid`, id)],
  ['change the key', () => sql(`UPDATE "Experiment" SET "key" = 'other' WHERE "id" = $1::uuid`, id)],
  ['change the metric', () => sql(`UPDATE "Experiment" SET "metricEvent" = 'other' WHERE "id" = $1::uuid`, id)],
  ['change the MDE', () => sql(`UPDATE "Experiment" SET "mde" = 0.05 WHERE "id" = $1::uuid`, id)],
  ['change the planned n', () => sql(`UPDATE "Experiment" SET "plannedUnitsPerArm" = 100 WHERE "id" = $1::uuid`, id)],
  ['change alpha', () => sql(`UPDATE "Experiment" SET "alpha" = 0.1 WHERE "id" = $1::uuid`, id)],
];

describe('HO-01: the database freezes a started experiment', () => {
  it('every design edit is refused once running, and nothing changes', async () => {
    const s = await setup(true);
    const before = JSON.stringify(await db.experiment.findUniqueOrThrow({ where: { id: s.id }, include: { variants: { orderBy: { position: 'asc' } }, guardrails: true } }));
    for (const [what, run] of edits(s)) await expect(run(), what).rejects.toThrow(HO01);
    const after = JSON.stringify(await db.experiment.findUniqueOrThrow({ where: { id: s.id }, include: { variants: { orderBy: { position: 'asc' } }, guardrails: true } }));
    expect(after).toBe(before);
  });

  it('control: the same edits all succeed on a draft (the trigger refuses only started experiments)', async () => {
    for (const [what] of edits(await setup(false))) {
      await resetAuthTables();
      const s = await setup(false);
      const run = edits(s).find(([w]) => w === what)![1];
      await expect(run(), what).resolves.toBeDefined();
    }
  });

  it('a started experiment never returns to draft, a stopped one never restarts; name and description stay editable', async () => {
    const { id } = await setup(true);
    await expect(sql(`UPDATE "Experiment" SET "status" = 'draft' WHERE "id" = $1::uuid`, id)).rejects.toThrow(HO01);
    await expect(sql(`UPDATE "Experiment" SET "name" = 'renamed', "description" = 'why' WHERE "id" = $1::uuid`, id)).resolves.toBe(1);
    await expect(sql(`UPDATE "Experiment" SET "status" = 'stopped', "stoppedAt" = now() WHERE "id" = $1::uuid`, id)).resolves.toBe(1);
    await expect(sql(`UPDATE "Experiment" SET "status" = 'running' WHERE "id" = $1::uuid`, id)).rejects.toThrow(HO01);
  });

  it('a variant cannot point at another org\'s experiment', async () => {
    const { id } = await setup(false);
    const b = await org('globex');
    await expect(sql(`INSERT INTO "Variant" ("id","orgId","experimentId","key","name","weight","position") VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'x', 'X', 0, 7)`, b.orgId, id)).rejects.toThrow(HO01);
  });

  it('exposures: only for a running experiment, with one of its variants; append-only', async () => {
    const draft = await setup(false);
    const ins = (orgId: string, expId: string, variantId: string) =>
      sql(`INSERT INTO "Exposure" ("id","orgId","experimentId","variantId","unitId","eventId","occurredAt","receivedAt") VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, 'e', now(), now())`, orgId, expId, variantId, randomUUID());
    await expect(ins(draft.a.orgId, draft.id, draft.v0.id)).rejects.toThrow(HO01);
    await startExperiment(draft.a.owner, draft.id);
    await expect(ins(draft.a.orgId, draft.id, draft.v0.id)).resolves.toBe(1);
    const other = await createExperiment(draft.a.owner, conversionDesign({ key: 'other' }));
    await startExperiment(draft.a.owner, other);
    await expect(ins(draft.a.orgId, other, draft.v0.id)).rejects.toThrow(HO01); // variant of a different experiment
    await expect(sql(`UPDATE "Exposure" SET "variantId" = $1::uuid`, draft.v1.id)).rejects.toThrow(HO01);
  });

  it('deleting the org still cascades through a running experiment, its variants and exposures', async () => {
    const s = await setup(true);
    await sql(`INSERT INTO "Exposure" ("id","orgId","experimentId","variantId","unitId","eventId","occurredAt","receivedAt") VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'u1', 'e', now(), now())`, s.a.orgId, s.id, s.v0.id);
    await db.org.delete({ where: { id: s.a.orgId } });
    expect([await db.experiment.count(), await db.variant.count(), await db.guardrail.count(), await db.exposure.count()]).toEqual([0, 0, 0, 0]);
  });
});

describe('HO-01 property: no ramp attempt moves a unit', () => {
  it('random designs, 2 000 units each: every refused ramp, reorder or resize leaves every assignment unchanged', async () => {
    const rnd = mulberry32(28);
    const a = await org('acme');
    const units = Array.from({ length: 2000 }, (_, i) => `user-${i}-${Math.floor(rnd() * 1e9)}`);
    for (let trial = 0; trial < 6; trial++) {
      const k = 2 + Math.floor(rnd() * 3); // 2..4 variants
      const cuts = Array.from({ length: k - 1 }, () => 1 + Math.floor(rnd() * 98)).sort((x, y) => x - y);
      const pcts = [...cuts, 100].map((c, i) => c - (i ? cuts[i - 1]! : 0));
      if (pcts.some((p) => p < 1)) continue;
      const variants = pcts.map((p, i) => ({ key: `v${i}`, name: '', weight: p * 100 }));
      const id = await createExperiment(a.owner, conversionDesign({ key: `trial-${trial}`, variants }));
      await startExperiment(a.owner, id);

      const stored = async () => {
        const x = await db.experiment.findUniqueOrThrow({ where: { id }, include: { variants: { orderBy: { position: 'asc' } } } });
        return units.map((u) => assign(x.salt, u, x.variants));
      };
      const before = await stored();
      const vs = await db.variant.findMany({ where: { experimentId: id }, orderBy: { position: 'asc' } });
      const attempts: (() => Promise<unknown>)[] = [
        () => db.$transaction(vs.map((v, i) => sql(`UPDATE "Variant" SET "weight" = $2 WHERE "id" = $1::uuid`, v.id, i === 0 ? 10000 - 100 * (vs.length - 1) : 100))),
        () => db.$transaction(vs.map((v, i) => sql(`UPDATE "Variant" SET "position" = $2 WHERE "id" = $1::uuid`, v.id, vs.length - 1 - i + 100))),
        () => sql(`DELETE FROM "Variant" WHERE "id" = $1::uuid`, vs[vs.length - 1]!.id),
        () => sql(`UPDATE "Experiment" SET "salt" = 'reset' WHERE "id" = $1::uuid`, id),
        () => updateDraft(a.owner, id, conversionDesign({ key: `trial-${trial}`, variants: [...variants].reverse() })),
      ];
      for (const attempt of attempts) await expect(attempt()).rejects.toThrow(/HO-01/);
      expect(await stored()).toEqual(before);
    }
  });
});
