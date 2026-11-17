import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { srmMinTotalUnits } from '@/lib/exp';
import { analyze, type DecisionState, type Readout } from '@/lib/holdout/readout';
import type { runCaseStudy } from '../../scripts/case-study';
import { caseStudyDesign, caseStudyLooks } from './case-study-looks';

// Issue #5 (readout clarity, from the Phase 4 case study). Statistics unchanged (D-16, D-32, D-33 bind); only what the
// readout says changes:
//   1. no sequential rejection by the 2× horizon, but the reference fixed-horizon p < α → "Inconclusive at planned sample
//      size" with that p labelled reference only, not a decision (D-40);
//   2. never "Ship" while the split is too small for the SRM check to see the case study's 8% exposure loss; show "SRM not
//      yet checkable" instead (D-41).
// The looks are the case study's own traffic (same seeds and salts, tests/holdout/case-study-looks.ts), checked against
// docs/holdout/case-study.json first, so these are the readouts the README tables report.

type Study = Awaited<ReturnType<typeof runCaseStudy>>;
const study = JSON.parse(readFileSync('docs/holdout/case-study.json', 'utf8')) as Study;
const design = caseStudyDesign();
const days = (key: string): Readout[] => {
  const looks = caseStudyLooks(key);
  return looks.map((_, i) => analyze(design, looks.slice(0, i + 1)));
};
const real = days('real-effect');
const aa = days('a-a');
const broken = days('broken-client');

describe('the case-study traffic, rebuilt from its seeds', () => {
  it('matches docs/holdout/case-study.json day by day (units, rates, sequential and fixed p, SRM p)', () => {
    for (const r of study.results) {
      const mine = days(r.key);
      expect(mine.length).toBe(r.days.length);
      expect(r.plannedUnitsPerArm).toBe(design.plannedUnitsPerArm);
      r.days.forEach((d, i) => {
        const x = mine[i]!;
        const c = x.comparisons?.[0];
        expect(x.arms.map((a) => a.units), `${r.key} day ${d.day} units`).toEqual(d.units);
        const r6 = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 1e6) / 1e6);
        expect(x.arms.map((a) => r6(a.level)), `${r.key} day ${d.day} rates`).toEqual(d.rates);
        expect(r6(c?.sequential.p), `${r.key} day ${d.day} seq p`).toBe(d.seqP);
        expect(r6(c?.fixed?.p), `${r.key} day ${d.day} fixed p`).toBe(d.fixedP);
        expect(r6(x.srm.p), `${r.key} day ${d.day} srm p`).toBe(d.srmP);
      });
    }
  });
});

describe('issue #5.1: inconclusive, not "no detectable effect", when only the reference fixed-horizon p is below α', () => {
  it('real effect, day 13 and 14: sequential test has not rejected at the 2× horizon, fixed-horizon p < 0.05', () => {
    for (const day of [13, 14]) {
      const r = real[day - 1]!;
      const c = r.comparisons![0]!;
      expect(r.minArmUnits).toBeGreaterThanOrEqual(r.plannedUnitsPerArm);
      expect(c.sequential.reject).toBe(false);
      expect(c.fixed!.p).toBeLessThan(c.alpha);
      expect(r.decision.state).toBe('inconclusive');
      expect(r.decision.headline).toBe('Inconclusive at planned sample size');
      expect(r.decision.headline).not.toContain('No detectable effect');
      expect(r.decision.detail).toContain('reference only, not a decision');
    }
    expect(real[12]!.decision.detail).toContain('fixed-horizon p = 0.0106');
    expect(real[13]!.decision.detail).toContain('fixed-horizon p = 0.0036');
  });

  it('the sequential result stays the decision: no ship, no variant, verdict undecided', () => {
    for (const r of real.slice(12)) {
      expect(r.decision.variant).toBeNull();
      expect(r.comparisons![0]!.verdict).toBe('undecided');
    }
  });

  it('before the 2× horizon the same data keeps running, even with fixed-horizon p < 0.05 (days 10 and 12)', () => {
    for (const day of [10, 12]) {
      expect(real[day - 1]!.comparisons![0]!.fixed!.p).toBeLessThan(0.05);
      expect(real[day - 1]!.decision.state).toBe('keep_running');
    }
  });

  it('A/A, day 13 and 14: fixed-horizon p is not below α, so it is still "No detectable effect at planned sample size"', () => {
    for (const r of aa.slice(12)) {
      expect(r.comparisons![0]!.fixed!.p).toBeGreaterThanOrEqual(0.05);
      expect(r.decision.state).toBe('no_effect');
      expect(r.decision.headline).toBe('No detectable effect at planned sample size');
    }
  });

  it('every day of every scenario: the headline is in the expected state (real effect never "no effect")', () => {
    const states = (rs: Readout[]) => rs.map((r) => r.decision.state);
    const keep = Array<DecisionState>(12).fill('keep_running');
    expect(states(real)).toEqual([...keep, 'inconclusive', 'inconclusive']);
    expect(states(aa)).toEqual([...keep, 'no_effect', 'no_effect']);
  });
});

describe('issue #5.2: "SRM not yet checkable" and never "Ship" until the SRM check can see an 8% exposure loss', () => {
  const min = srmMinTotalUnits([5000, 5000]);

  it('the minimum for the case study split is 9 835 units in total (8% loss of one arm, p < 0.001, 80% power; D-41)', () => {
    expect(min).toBe(9835);
    expect(broken[0]!.srm.minTotalUnits).toBe(min);
  });

  it('broken client: days 4 to 8 (4 582 to 9 203 units) say "SRM not yet checkable", not "Ship", though the test rejected', () => {
    for (let day = 4; day <= 8; day++) {
      const r = broken[day - 1]!;
      const total = r.arms.reduce((s, a) => s + a.units, 0);
      expect(total).toBeLessThan(min);
      expect(r.srm.checkable).toBe(false);
      expect(r.srm.blocked).toBe(false);
      expect(r.comparisons![0]!.sequential.reject).toBe(true); // the statistics are unchanged; only the decision waits
      expect(r.decision.state).toBe('srm_unchecked');
      expect(r.decision.headline).toBe('Keep running: SRM not yet checkable');
      expect(r.decision.headline).not.toMatch(/Ship/);
      expect(r.decision.variant).toBeNull();
      expect(r.decision.detail).toContain('9,835');
    }
  });

  it('broken client, whole run: the state per day (ship only once checkable; SRM still stops it on day 13)', () => {
    expect(broken.map((r) => r.decision.state)).toEqual([
      'keep_running', 'keep_running', 'keep_running',
      'srm_unchecked', 'srm_unchecked', 'srm_unchecked', 'srm_unchecked', 'srm_unchecked',
      'ship', 'ship', 'ship', 'ship', // ≥ 9 835 units, SRM p 0.0155 to 0.0021: at 80% power this run is one the check misses (D-41)
      'srm', 'srm',
    ]);
  });

  it('every day of every scenario: "Ship" never appears while the SRM check is not yet checkable', () => {
    for (const r of [...real, ...aa, ...broken]) {
      const total = r.arms.reduce((s, a) => s + a.units, 0);
      expect(r.srm.checkable).toBe(total >= min);
      if (!r.srm.checkable) {
        expect(r.decision.state).not.toBe('ship');
        expect(r.decision.headline).not.toMatch(/^Ship/);
      }
    }
  });

  it('the readout still reports the SRM test itself while not checkable (χ², p, expected units; D-33 unchanged)', () => {
    const r = broken[4]!;
    expect(r.srm.p).toBeCloseTo(0.0053, 4);
    expect(r.comparisons).not.toBeNull(); // nothing is blocked: the split has not failed, it is too small to judge
    expect(r.arms.every((a) => a.level !== null)).toBe(true);
  });
});
