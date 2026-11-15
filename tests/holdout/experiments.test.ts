import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { Refused } from '@/core/errors';
import { plannedUnitsPerArm, sampleSizeMeans, sampleSizeProportions } from '@/lib/exp';
import { checkDesign, createExperiment, deleteDraft, getExperiment, planFor, renameExperiment, startExperiment, updateDraft } from '@/lib/holdout/experiments';
import { design, toDesign } from '@/lib/holdout/form';
import { addExperiment, launchExperiment } from '@/app/o/[org]/experiments/actions';
import { resetAuthTables } from '../helpers/auth';
import { NavSignal } from '../helpers/next';
import { actAs, addMember } from '../helpers/org';
import { conversionDesign, meanDesign, org } from './helpers';

beforeEach(resetAuthTables);
afterAll(resetAuthTables); // leave no 'acme' org behind: e2e's demo seed expects to create it (NEXT.md e2e trap)

describe('planned sample size, fixed up front (PRD; D-16 sequential at 2x)', () => {
  it('PRD conversion case 10% → 12%: 3 841 fixed-horizon, 7 682 planned per arm, 15 364 total at 50/50', () => {
    expect(planFor(conversionDesign())).toEqual({ fixedUnitsPerArm: 3841, plannedUnitsPerArm: 7682, plannedTotalUnits: 15364 });
  });

  it('PRD means case 10 ± 5 → 10.5: 1 570 fixed-horizon, 3 140 planned per arm', () => {
    expect(planFor(meanDesign())).toEqual({ fixedUnitsPerArm: 1570, plannedUnitsPerArm: 3140, plannedTotalUnits: 6280 });
  });

  it('is exactly plannedUnitsPerArm(sampleSize*, "sequential"), never the fixed n alone', () => {
    for (const [b, m] of [[0.05, 0.01], [0.3, -0.03], [0.5, 0.05]] as const) {
      const p = planFor(conversionDesign({ baselineRate: b, mde: m }));
      expect(p.plannedUnitsPerArm).toBe(plannedUnitsPerArm(sampleSizeProportions(b, m), 'sequential'));
      expect(p.plannedUnitsPerArm).toBe(2 * p.fixedUnitsPerArm);
    }
    expect(planFor(meanDesign({ baselineSd: 12, mde: 1 })).plannedUnitsPerArm).toBe(plannedUnitsPerArm(sampleSizeMeans(12, 1), 'sequential'));
  });

  it('an unequal split plans on the smallest arm (D-20): 90/10 needs 10x the per-arm n in total', () => {
    const p = planFor(conversionDesign({ variants: [{ key: 'control', name: '', weight: 9000 }, { key: 'treatment', name: '', weight: 1000 }] }));
    expect(p.plannedUnitsPerArm).toBe(7682);
    expect(p.plannedTotalUnits).toBe(76820);
  });

  it('refuses inputs the formulas cannot plan', () => {
    expect(() => planFor(conversionDesign({ baselineRate: 0 }))).toThrow(Refused);
    expect(() => planFor(conversionDesign({ baselineRate: 0.95, mde: 0.06 }))).toThrow(Refused);
    expect(() => planFor(conversionDesign({ mde: 0 }))).toThrow(Refused);
    expect(() => planFor(meanDesign({ baselineSd: 0 }))).toThrow(Refused);
    expect(() => planFor(conversionDesign({ baselineRate: 0.1, mde: 0.00001 }))).toThrow(/more units/);
  });
});

describe('design rules (D-25)', () => {
  const bad: [string, Partial<Parameters<typeof conversionDesign>[0]>][] = [
    ['one variant', { variants: [{ key: 'only', name: '', weight: 10000 }] }],
    ['five variants', { variants: Array.from({ length: 5 }, (_, i) => ({ key: `v${i}`, name: '', weight: 2000 })) }],
    ['weights not 100%', { variants: [{ key: 'a', name: '', weight: 5000 }, { key: 'b', name: '', weight: 4000 }] }],
    ['a weight under 1%', { variants: [{ key: 'a', name: '', weight: 9950 }, { key: 'b', name: '', weight: 50 }] }],
    ['duplicate variant keys', { variants: [{ key: 'a', name: '', weight: 5000 }, { key: 'a', name: '', weight: 5000 }] }],
    ['bad key', { key: 'Has Spaces' }],
    ['guardrail = primary', { guardrails: [{ event: 'purchase', kind: 'proportion' }] }],
    ['six guardrails', { guardrails: Array.from({ length: 6 }, (_, i) => ({ event: `g${i}`, kind: 'proportion' as const })) }],
  ];
  for (const [what, over] of bad) it(`refuses ${what}`, () => expect(() => checkDesign(conversionDesign(over))).toThrow(Refused));

  it('the form converts percent and percentage points exactly, and refuses a third decimal', () => {
    const form = design.parse({
      key: 'k', name: 'n', metricEvent: 'purchase', metricKind: 'proportion', baseline: '10', mde: '2',
      variantKeys: ['control', 'treatment', ''], variantNames: ['', '', ''], variantWeights: ['33.33', '66.67', ''],
      guardrailEvents: ['', 'refund'], guardrailKinds: ['proportion', 'mean'],
    });
    const d = toDesign(form);
    expect(d.baselineRate).toBeCloseTo(0.1, 15);
    expect(d.mde).toBeCloseTo(0.02, 15);
    expect(d.variants.map((v) => v.weight)).toEqual([3333, 6667]);
    expect(d.guardrails).toEqual([{ event: 'refund', kind: 'mean' }]);
    expect(() => toDesign({ ...form, variantWeights: ['33.333', '66.667'] })).toThrow(/two decimals/);
  });
});

describe('experiment lifecycle', () => {
  it('create stores the design, the plan and a random salt; start freezes it and audits the exact design', async () => {
    const a = await org('acme');
    const id = await createExperiment(a.owner, conversionDesign());
    const x = await getExperiment(a.owner, id);
    expect(x).toMatchObject({ status: 'draft', key: 'checkout-button', fixedUnitsPerArm: 3841, plannedUnitsPerArm: 7682, plannedTotalUnits: 15364, alpha: 0.05, power: 0.8 });
    expect(x.salt).toMatch(/^[0-9a-f]{24}$/);
    expect(x.variants.map((v) => [v.key, v.weight, v.position])).toEqual([['control', 5000, 0], ['treatment', 5000, 1]]);
    const other = await createExperiment(a.owner, conversionDesign({ key: 'other' }));
    expect((await getExperiment(a.owner, other)).salt).not.toBe(x.salt);

    await startExperiment(a.owner, id);
    const started = await getExperiment(a.owner, id);
    expect(started.status).toBe('running');
    expect(started.startedAt).toBeInstanceOf(Date);
    const ev = await db.auditEvent.findFirstOrThrow({ where: { action: 'experiment.started', targetId: id } });
    expect(ev.data).toMatchObject({ salt: x.salt, plannedUnitsPerArm: 7682, variants: [{ key: 'control', weight: 5000, position: 0 }, { key: 'treatment', weight: 5000, position: 1 }] });
    await expect(startExperiment(a.owner, id)).rejects.toThrow(/already started/);
  });

  it('a draft can be edited and deleted; a started experiment can only be renamed', async () => {
    const a = await org('acme');
    const id = await createExperiment(a.owner, conversionDesign());
    await updateDraft(a.owner, id, conversionDesign({ mde: 0.03, variants: [{ key: 'control', name: '', weight: 3000 }, { key: 'b', name: '', weight: 3000 }, { key: 'c', name: '', weight: 4000 }] }));
    let x = await getExperiment(a.owner, id);
    expect(x.variants.map((v) => v.key)).toEqual(['control', 'b', 'c']);
    expect(x.plannedUnitsPerArm).toBe(2 * Math.ceil(sampleSizeProportions(0.1, 0.03)));

    await startExperiment(a.owner, id);
    await expect(updateDraft(a.owner, id, conversionDesign())).rejects.toThrow(/frozen \(HO-01\)/);
    await expect(deleteDraft(a.owner, id)).rejects.toThrow(/Only a draft/);
    await renameExperiment(a.owner, id, 'Checkout button v2', 'clearer copy');
    x = await getExperiment(a.owner, id);
    expect([x.name, x.description, x.variants.length]).toEqual(['Checkout button v2', 'clearer copy', 3]);

    const draft = await createExperiment(a.owner, conversionDesign({ key: 'gone' }));
    await deleteDraft(a.owner, draft);
    expect(await db.variant.count({ where: { experimentId: draft } })).toBe(0);
  });

  it('a key is unique per org, not across orgs', async () => {
    const a = await org('acme');
    const b = await org('globex');
    await createExperiment(a.owner, conversionDesign());
    await expect(createExperiment(a.owner, conversionDesign())).rejects.toThrow(/already uses the key/);
    await expect(createExperiment(b.owner, conversionDesign())).resolves.toBeTruthy();
  });

  it("another org's experiment is not found, the same as one that does not exist (INV-04)", async () => {
    const a = await org('acme');
    const b = await org('globex');
    const theirs = await createExperiment(b.owner, conversionDesign());
    for (const id of [theirs, '00000000-0000-4000-8000-000000000999']) {
      await expect(getExperiment(a.owner, id)).rejects.toThrow(NavSignal);
      await expect(startExperiment(a.owner, id)).rejects.toThrow(NavSignal);
      await expect(updateDraft(a.owner, id, () => { throw new Error('the design must not be built for a row that is not ours'); })).rejects.toThrow(NavSignal);
    }
    expect((await db.experiment.findUniqueOrThrow({ where: { id: theirs } })).status).toBe('draft');
  });

  it('a member drafts but cannot start; an admin can (D-21)', async () => {
    const a = await org('acme');
    const member = await addMember(a.orgId, 'member', 'member@acme.test');
    await actAs(member.id, 'acme');
    const form = {
      key: 'by-member', name: 'By member', metricEvent: 'purchase', metricKind: 'proportion', baseline: '10', mde: '2',
      variantKeys: ['control', 'treatment'], variantNames: ['', ''], variantWeights: ['50', '50'],
    };
    await expect(addExperiment('acme', form)).rejects.toThrow(/redirect \/o\/acme\/experiments\//);
    const x = await db.experiment.findFirstOrThrow({ where: { key: 'by-member' } });
    await expect(launchExperiment('acme', { id: x.id })).rejects.toThrow(/org\.update/);
    expect((await db.experiment.findUniqueOrThrow({ where: { id: x.id } })).status).toBe('draft');

    const admin = await addMember(a.orgId, 'admin', 'admin@acme.test');
    await actAs(admin.id, 'acme');
    await expect(launchExperiment('acme', { id: x.id })).rejects.toThrow(/redirect/);
    expect((await db.experiment.findUniqueOrThrow({ where: { id: x.id } })).status).toBe('running');
  });
});
