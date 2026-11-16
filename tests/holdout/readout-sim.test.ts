import { describe, expect, it } from 'vitest';
import { mulberry32 } from '@/lib/exp';
import { analyze, type DecisionState, type Look, type ReadoutDesign } from '@/lib/holdout/readout';

// The readout's decision rule under simulated traffic with daily looks (Phase 3; HO-03's bound applied to the decision
// people act on). Each run spreads the planned total over 14 days, looks at the end of every day, and records the first
// decision that ends the experiment (ship, guardrail, worse, srm) or the final state. Numbers are printed for the PR.

const RUNS = 2000;
const DAYS = 14;

type Arm = { units: number; conv: number; guard: number };

function run(d: ReadoutDesign, rates: number[], guardRates: number[], perDay: number, rand: () => number): DecisionState {
  const k = rates.length;
  const arms: Arm[] = rates.map(() => ({ units: 0, conv: 0, guard: 0 }));
  const cum = d.variants.map((v) => v.weight);
  const looks: Look[] = [];
  let last: DecisionState = 'keep_running';
  for (let day = 0; day < DAYS; day++) {
    for (let i = 0; i < perDay; i++) {
      let r = rand() * 10_000;
      let j = 0;
      while (j < k - 1 && r >= cum[j]!) r -= cum[j++]!;
      const a = arms[j]!;
      a.units++;
      if (rand() < rates[j]!) a.conv++;
      if (rand() < guardRates[j]!) a.guard++;
    }
    looks.push({ at: `day-${day}`, arms: arms.map((a) => ({ units: a.units, metrics: { purchase: { sum: a.conv, sumSq: a.conv }, refund: { sum: a.guard, sumSq: a.guard } } })) });
    last = analyze(d, looks).decision.state;
    if (last === 'ship' || last === 'guardrail' || last === 'worse' || last === 'srm') return last;
  }
  return last;
}

function rates(d: ReadoutDesign, conv: number[], guard: number[], seed: number) {
  const rand = mulberry32(seed);
  // 3% over the planned total, so the smaller arm of a random split still reaches plannedUnitsPerArm by the last day.
  const perDay = Math.ceil((1.03 * d.plannedUnitsPerArm * (10_000 / Math.min(...d.variants.map((v) => v.weight)))) / DAYS);
  const out: Record<string, number> = {};
  for (let i = 0; i < RUNS; i++) {
    const s = run(d, conv, guard, perDay, rand);
    out[s] = (out[s] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).map(([s, n]) => [s, n / RUNS]));
}

const two: ReadoutDesign = {
  metricEvent: 'purchase',
  metricKind: 'proportion',
  mde: 0.02,
  alpha: 0.05,
  plannedUnitsPerArm: 7682, // PRD 10% → 12%, D-16 2x
  variants: [
    { key: 'control', name: 'Control', weight: 5000 },
    { key: 'treatment', name: 'Treatment', weight: 5000 },
  ],
  guardrails: [{ event: 'refund', kind: 'proportion' }],
};

describe('decision rule under simulation (2 000 runs, 14 daily looks, planned total spread evenly)', () => {
  it('A/A: a wrong ship or stop happens in ≤ 6% of runs (HO-03 bound); a false guardrail hold is rare', () => {
    const r = rates(two, [0.1, 0.1], [0.02, 0.02], 28);
    console.log('A/A two arms', r);
    expect((r.ship ?? 0) + (r.worse ?? 0)).toBeLessThanOrEqual(0.06);
    expect(r.guardrail ?? 0).toBeLessThanOrEqual(0.01); // a guardrail can only hold a (false) winner
    expect(r.srm ?? 0).toBeLessThanOrEqual(0.01); // ≈ 0.001 per look under healthy assignment
    expect(r.no_effect).toBeGreaterThan(0.85);
  }, 120_000);

  it('A/A with three arms: Bonferroni keeps the family-wise wrong-decision rate ≤ 6% (D-30)', () => {
    const three = { ...two, variants: [{ key: 'control', name: 'Control', weight: 3334 }, { key: 'b', name: 'B', weight: 3333 }, { key: 'c', name: 'C', weight: 3333 }] };
    const r = rates(three, [0.1, 0.1, 0.1], [0.02, 0.02, 0.02], 29);
    console.log('A/A three arms', r);
    expect((r.ship ?? 0) + (r.worse ?? 0)).toBeLessThanOrEqual(0.06);
  }, 120_000);

  it('PRD effect 10% → 12% at the planned horizon: shipped in most runs, wrongly stopped almost never', () => {
    const r = rates(two, [0.1, 0.12], [0.02, 0.02], 30);
    console.log('10% → 12%', r);
    expect(r.ship).toBeGreaterThan(0.75); // D-16 measured 86.7% with looks every 400 units; daily looks are coarser
    expect(r.worse ?? 0).toBe(0);
  }, 120_000);

  // A guardrail is checked with the data that exists when the primary wins, which is often early (the mSPRT stops early on
  // real effects). A large harm is caught before most ships; a moderate one only some of the time (PR: not verified).
  it('a large guardrail harm (refunds 2% → 4%) holds most true winners instead of shipping them', () => {
    const r = rates(two, [0.1, 0.12], [0.02, 0.04], 31);
    console.log('10% → 12% with refunds 2% → 4%', r);
    expect(r.guardrail).toBeGreaterThan(0.5);
  }, 120_000);

  it('a moderate guardrail harm (refunds 2% → 3%) holds a share of true winners; with no harm almost none are held', () => {
    const harm = rates(two, [0.1, 0.12], [0.02, 0.03], 32);
    const none = rates(two, [0.1, 0.12], [0.02, 0.02], 33);
    console.log('10% → 12% with refunds 2% → 3%', harm, 'no harm', none);
    expect(harm.guardrail).toBeGreaterThan(0.2);
    expect(none.guardrail ?? 0).toBeLessThan(0.03);
  }, 120_000);
});
