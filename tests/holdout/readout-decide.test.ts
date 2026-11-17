import { describe, expect, it } from 'vitest';
import { diffMeans, diffProportions, MIN_UNITS_PER_ARM, sequentialPath } from '@/lib/exp';
import { analyze, type ArmAgg, type Look, type ReadoutDesign } from '@/lib/holdout/readout';

// The readout's decision rule, pure (Phase 3). One case per PRD state, the precedence between them, the D-16 horizon,
// the MDE's direction, Bonferroni across treatments (D-30) and guardrails (D-31).

const design = (over: Partial<ReadoutDesign> = {}): ReadoutDesign => ({
  metricEvent: 'purchase',
  metricKind: 'proportion',
  mde: 0.02,
  alpha: 0.05,
  plannedUnitsPerArm: 7682,
  variants: [
    { key: 'control', name: 'Control', weight: 5000 },
    { key: 'treatment', name: 'Treatment', weight: 5000 },
  ],
  guardrails: [],
  ...over,
});

/** Proportion arm: n units, c converters of `purchase`, plus optional guardrail converters. */
const arm = (n: number, c: number, extra: Record<string, number> = {}): ArmAgg => ({
  units: n,
  metrics: Object.fromEntries([['purchase', c], ...Object.entries(extra)].map(([e, x]) => [e, { sum: x as number, sumSq: x as number }])),
});
const look = (arms: ArmAgg[], at = '2026-11-15T00:00:00.000Z'): Look => ({ at, arms });

describe('decision states (PRD readout)', () => {
  it('not enough data below MIN_UNITS_PER_ARM in any arm, with no effect reported', () => {
    const r = analyze(design(), [look([arm(MIN_UNITS_PER_ARM, 10), arm(MIN_UNITS_PER_ARM - 1, 40)])]);
    expect(r.decision.state).toBe('not_enough_data');
    expect(r.comparisons).toBeNull();
    expect(r.arms.every((a) => a.level === null)).toBe(true);
  });

  it('no units at all is not enough data, not SRM', () => {
    expect(analyze(design(), [look([arm(0, 0), arm(0, 0)])]).decision.state).toBe('not_enough_data');
  });

  it('HO-04: SRM at p < 0.001 blocks the readout and withholds every effect, even a huge one', () => {
    const r = analyze(design(), [look([arm(5000, 500), arm(4500, 1500)])]);
    expect(r.srm.blocked).toBe(true);
    expect(r.srm.p).toBeLessThan(0.001);
    expect(r.decision.state).toBe('srm');
    expect(r.comparisons).toBeNull();
    expect(r.guardrails).toBeNull();
    expect(r.arms.map((a) => a.level)).toEqual([null, null]);
  });

  it('SRM outranks not-enough-data', () => {
    expect(analyze(design(), [look([arm(400, 0), arm(40, 0)])]).decision.state).toBe('srm');
  });

  it('a split just inside the 0.001 threshold is not blocked', () => {
    // 10 000 units, 50/50: χ² = (diff)²/n; 5 160 vs 4 840 → χ² = 10.24, p ≈ 0.0014.
    const r = analyze(design(), [look([arm(5160, 516), arm(4840, 484)])]);
    expect(r.srm.blocked).toBe(false);
    expect(r.srm.p).toBeGreaterThan(0.001);
  });

  it('ship B when the sequential test rejects in the MDE direction', () => {
    const r = analyze(design(), [look([arm(8000, 800), arm(8000, 1000)])]);
    expect(r.decision).toMatchObject({ state: 'ship', variant: 'treatment', headline: 'Ship Treatment' });
    expect(r.comparisons![0]!.verdict).toBe('better');
    expect(r.comparisons![0]!.sequential.ciLow).toBeGreaterThan(0);
  });

  it('a negative MDE means lower is better: a drop ships, a rise is worse', () => {
    const d = design({ mde: -0.02 });
    expect(analyze(d, [look([arm(8000, 1000), arm(8000, 800)])]).decision.state).toBe('ship');
    expect(analyze(d, [look([arm(8000, 800), arm(8000, 1000)])]).decision.state).toBe('worse');
  });

  it('stop when every variant is significantly worse', () => {
    const r = analyze(design(), [look([arm(8000, 1000), arm(8000, 800)])]);
    expect(r.decision.state).toBe('worse');
    expect(r.decision.headline).toBe('Stop: no variant beats control');
  });

  it('no detectable effect once every arm reaches plannedUnitsPerArm (the stored D-16 horizon), not the fixed n', () => {
    const fixedN = 3841;
    const planned = 2 * fixedN;
    // Between the fixed-horizon n and the 2x horizon the readout keeps running.
    expect(analyze(design({ plannedUnitsPerArm: planned }), [look([arm(fixedN, 384), arm(fixedN, 390)])]).decision.state).toBe('keep_running');
    expect(analyze(design({ plannedUnitsPerArm: planned }), [look([arm(planned - 1, 768), arm(planned, 770)])]).decision.state).toBe('keep_running');
    const r = analyze(design({ plannedUnitsPerArm: planned }), [look([arm(planned, 768), arm(planned + 3, 772)])]);
    expect(r.decision.state).toBe('no_effect');
    expect(r.decision.headline).toBe('No detectable effect at planned sample size');
    expect(r.decision.detail).toContain('7,682');
  });

  it('inconclusive, not "no detectable effect", when the sequential test has not rejected but the reference fixed-horizon p < α (issue #5, D-40)', () => {
    // 7 682 per arm, 10.00% vs 11.30%: fixed-horizon p ≈ 0.009, the mSPRT at τ² = MDE² does not reject on one look.
    const r = analyze(design(), [look([arm(7682, 768), arm(7682, 868)])]);
    expect(r.comparisons![0]!.sequential.reject).toBe(false);
    expect(r.comparisons![0]!.fixed!.p).toBeLessThan(0.05);
    expect(r.decision).toMatchObject({ state: 'inconclusive', variant: null, headline: 'Inconclusive at planned sample size' });
    expect(r.decision.detail).toContain(`fixed-horizon p = ${r.comparisons![0]!.fixed!.p.toFixed(4)}`);
    expect(r.decision.detail).toContain('reference only, not a decision');
    // The same comparison one unit short of the horizon keeps running: only the wording at the horizon changes.
    expect(analyze(design(), [look([arm(7681, 768), arm(7682, 868)])]).decision.state).toBe('keep_running');
  });

  it('with several treatments, inconclusive uses each comparison\'s own Bonferroni α (D-30)', () => {
    const three = design({ variants: [{ key: 'control', name: 'Control', weight: 3334 }, { key: 'b', name: 'B', weight: 3333 }, { key: 'c', name: 'C', weight: 3333 }] });
    // b: fixed p between 0.025 and 0.05 → not below its α of 0.025, so no-effect wording stays.
    let found = false;
    for (let c = 800; c < 900 && !found; c++) {
      const r = analyze(three, [look([arm(7682, 768), arm(7682, c), arm(7682, 768)])]);
      const p = r.comparisons![0]!.fixed!.p;
      if (p < 0.05 && p >= 0.025 && !r.comparisons![0]!.sequential.reject) {
        expect(r.decision.state).toBe('no_effect');
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  it('never ships while the split is too small for the SRM check to see an 8% exposure loss (issue #5, D-41)', () => {
    // 4 000 per arm, 10% vs 14%: the sequential test rejects, but 8 000 units < 9 835.
    const r = analyze(design(), [look([arm(4000, 400), arm(4000, 560)])]);
    expect(r.comparisons![0]!.verdict).toBe('better');
    expect(r.srm).toMatchObject({ blocked: false, checkable: false, minTotalUnits: 9835 });
    expect(r.decision).toMatchObject({ state: 'srm_unchecked', variant: null, headline: 'Keep running: SRM not yet checkable' });
    expect(r.decision.detail).toContain('8,000 of the 9,835');
    // From 9 835 units on, the same winner ships.
    const at = analyze(design(), [look([arm(4917, 492), arm(4918, 689)])]);
    expect(at.srm.checkable).toBe(true);
    expect(at.decision.state).toBe('ship');
  });

  it('a guardrail hold and a "worse" stop are not ships, so they are not held back by the SRM minimum', () => {
    const g = design({ guardrails: [{ event: 'refund', kind: 'proportion' }] });
    expect(analyze(g, [look([arm(4000, 400, { refund: 80 }), arm(4000, 560, { refund: 200 })])]).decision.state).toBe('guardrail');
    expect(analyze(design(), [look([arm(4000, 560), arm(4000, 400)])]).decision.state).toBe('worse');
  });

  it('keep running in between, with the progress against the planned horizon', () => {
    const r = analyze(design(), [look([arm(2000, 200), arm(2000, 210)])]);
    expect(r.decision.state).toBe('keep_running');
    expect(r.decision.detail).toContain('2,000 of the planned 7,682');
    expect(r.comparisons![0]!.verdict).toBe('undecided');
  });
});

describe('numbers behind the decision', () => {
  it('fixed-horizon result on the last look is exactly diffProportions; sequential is sequentialPath over eligible looks', () => {
    const looks = [look([arm(50, 5), arm(60, 9)]), look([arm(900, 90), arm(910, 120)]), look([arm(2100, 210), arm(2080, 260)])];
    const r = analyze(design(), looks);
    const c = r.comparisons![0]!;
    const f = diffProportions({ conversions: 210, units: 2100 }, { conversions: 260, units: 2080 }, 0.05);
    expect(c.fixed).toEqual({ p: f.p, ciLow: f.ciLow, ciHigh: f.ciHigh, se: f.se });
    expect(c.diff).toBe(f.diff);
    // The first look is below MIN_UNITS_PER_ARM, so the path starts at the second.
    const v = (n: number, x: number) => (x / n) * (1 - x / n) / n;
    const path = sequentialPath(
      [
        { diff: 120 / 910 - 90 / 900, variance: v(900, 90) + v(910, 120) },
        { diff: 260 / 2080 - 210 / 2100, variance: v(2100, 210) + v(2080, 260) },
      ],
      0.02 ** 2,
      0.05,
    );
    expect(c.sequential).toEqual({ p: path[1]!.p, ciLow: path[1]!.ciLow, ciHigh: path[1]!.ciHigh, reject: path[1]!.reject, looks: 2 });
  });

  it('means: per-arm sums and sums of squares give diffMeans exactly', () => {
    const a = { n: 500, sum: 5000, sumSq: 5000 * 10 + 499 * 25 }; // mean 10, variance 25
    const b = { n: 520, sum: 520 * 10.4, sumSq: 520 * 10.4 * 10.4 + 519 * 30 };
    const d = design({ metricEvent: 'order', metricKind: 'mean', mde: 0.5, plannedUnitsPerArm: 3140 });
    const r = analyze(d, [look([{ units: a.n, metrics: { order: { sum: a.sum, sumSq: a.sumSq } } }, { units: b.n, metrics: { order: { sum: b.sum, sumSq: b.sumSq } } }])]);
    const f = diffMeans({ n: 500, mean: 10, variance: 25 }, { n: 520, mean: 10.4, variance: 30 }, 0.05);
    if ('notEnoughData' in f) throw new Error('unexpected');
    const c = r.comparisons![0]!;
    expect(c.diff).toBeCloseTo(f.diff, 12);
    expect(c.fixed!.p).toBeCloseTo(f.p, 12);
    expect(c.fixed!.ciLow).toBeCloseTo(f.ciLow, 12);
    expect(r.arms.map((x) => x.level)).toEqual([10, 10.4]);
  });

  it('is JSON-safe (no NaN or Infinity), so the stop audit event can store it (HO-05)', () => {
    // Zero conversions everywhere: relLift is NaN in the engine and the CS is unbounded.
    const r = analyze(design(), [look([arm(300, 0), arm(300, 0)])]);
    const s = JSON.stringify(r);
    expect(JSON.parse(s)).toEqual(r);
    expect(r.comparisons![0]!.relLift).toBeNull();
    expect(r.comparisons![0]!.sequential.ciLow).toBeNull();
  });

  it('a rejection sticks: a later look with a smaller effect cannot unship (running minimum, always valid)', () => {
    const r = analyze(design(), [look([arm(8000, 800), arm(8000, 1000)]), look([arm(9000, 900), arm(9000, 1000)])]);
    expect(r.decision.state).toBe('ship');
  });
});

describe('more than two variants (PR #1 review; D-30 Bonferroni)', () => {
  const three = design({
    plannedUnitsPerArm: 20000,
    variants: [
      { key: 'control', name: 'Control', weight: 3334 },
      { key: 'b', name: 'B', weight: 3333 },
      { key: 'c', name: 'C', weight: 3333 },
    ],
  });

  it('tests each treatment against control at α / (k − 1)', () => {
    const r = analyze(three, [look([arm(5000, 500), arm(5000, 520), arm(5000, 510)])]);
    expect(r.comparisons!.map((c) => c.alpha)).toEqual([0.025, 0.025]);
    expect(analyze({ ...three, variants: [...three.variants.slice(0, 2), { key: 'c', name: 'C', weight: 1666 }, { key: 'd', name: 'D', weight: 1667 }].map((v, i) => ({ ...v, weight: [3334, 3333, 1666, 1667][i]! })) }, [look([arm(5000, 500), arm(5000, 520), arm(2500, 255), arm(2500, 250)])]).comparisons!.map((c) => c.alpha)).toEqual([0.05 / 3, 0.05 / 3, 0.05 / 3]);
  });

  it('a result that rejects at α but not at α / 2 does not ship with two treatments', () => {
    // Find a two-arm effect that ships at 0.05 but not at 0.025 by scanning the treatment's converters.
    let found = false;
    for (let c = 900; c < 1100 && !found; c++) {
      const two = analyze(design(), [look([arm(8000, 800), arm(8000, c)])]);
      const twoStrict = analyze(design({ alpha: 0.025 }), [look([arm(8000, 800), arm(8000, c)])]);
      if (two.decision.state === 'ship' && twoStrict.decision.state !== 'ship') {
        const r = analyze(three, [look([arm(8000, 800), arm(8000, c), arm(8000, 800)])]);
        expect(r.decision.state).toBe('keep_running');
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  it('ships the best of several winners', () => {
    const r = analyze(three, [look([arm(8000, 800), arm(8000, 1000), arm(8000, 1100)])]);
    expect(r.decision).toMatchObject({ state: 'ship', variant: 'c' });
  });

  it('is not "worse" while one treatment is undecided', () => {
    expect(analyze(three, [look([arm(8000, 1000), arm(8000, 800), arm(8000, 1000)])]).decision.state).toBe('keep_running');
  });
});

describe('guardrails (D-31)', () => {
  const g = design({ guardrails: [{ event: 'refund', kind: 'proportion' }] });

  it('a winner with a guardrail that moved is held for review, not shipped', () => {
    const r = analyze(g, [look([arm(8000, 800, { refund: 160 }), arm(8000, 1000, { refund: 320 })])]);
    expect(r.decision).toMatchObject({ state: 'guardrail', variant: 'treatment' });
    expect(r.decision.detail).toContain('refund moved up');
    expect(r.guardrails![0]!.comparisons[0]!.moved).toBe('up');
  });

  it('a quiet guardrail leaves the ship', () => {
    const r = analyze(g, [look([arm(8000, 800, { refund: 160 }), arm(8000, 1000, { refund: 163 })])]);
    expect(r.decision.state).toBe('ship');
    expect(r.guardrails![0]!.comparisons[0]!.moved).toBeNull();
    expect(r.guardrails![0]!.tau2).toBeCloseTo((0.25 * 0.02) ** 2, 15);
  });

  it('τ² is fixed at the first eligible look where control has a level, and waits while control is 0', () => {
    const looks = [look([arm(200, 20, { refund: 0 }), arm(200, 22, { refund: 0 })]), look([arm(1000, 100, { refund: 50 }), arm(1000, 101, { refund: 52 })]), look([arm(3000, 300, { refund: 300 }), arm(3000, 310, { refund: 290 })])];
    const r = analyze(g, looks);
    expect(r.guardrails![0]!.tau2).toBeCloseTo((0.25 * 0.05) ** 2, 15);
    expect(r.guardrails![0]!.comparisons[0]!.sequential.looks).toBe(2);
  });

  it('a guardrail moving on a variant that is not the winner does not hold the winner', () => {
    const d = design({
      guardrails: [{ event: 'refund', kind: 'proportion' }],
      variants: [
        { key: 'control', name: 'Control', weight: 3334 },
        { key: 'b', name: 'B', weight: 3333 },
        { key: 'c', name: 'C', weight: 3333 },
      ],
    });
    const r = analyze(d, [look([arm(8000, 800, { refund: 160 }), arm(8000, 1100, { refund: 162 }), arm(8000, 800, { refund: 400 })])]);
    expect(r.decision).toMatchObject({ state: 'ship', variant: 'b' });
  });
});
