// Unit tests for the engine's edges; numeric agreement lives in ho-02-oracle.test.ts.
import { describe, expect, it } from 'vitest';
import { csHalfWidth, diffMeans, diffProportions, logLambda, MIN_UNITS_PER_ARM, mulberry32, normCdf, normPpf, sequentialPath, sequentialStep, srmCheck, summarize } from '@/lib/exp';

describe('engine edges', () => {
  it('normal quantile inverts the CDF across the range', () => {
    for (const p of [1e-12, 1e-5, 0.01, 0.3, 0.5, 0.7, 0.99, 1 - 1e-9]) expect(Math.abs(normCdf(normPpf(p)) - p)).toBeLessThan(1e-14 + p * 1e-12);
    expect(normPpf(0)).toBe(-Infinity);
    expect(normPpf(1)).toBe(Infinity);
    expect(() => normPpf(1.5)).toThrow();
  });

  it('identical arms: zero effect, p = 1, symmetric CI', () => {
    const r = diffProportions({ conversions: 50, units: 1000 }, { conversions: 50, units: 1000 });
    expect(r.diff).toBe(0);
    expect(r.p).toBeCloseTo(1, 12);
    expect(r.ciLow).toBeCloseTo(-r.ciHigh, 15);
  });

  it('degenerate proportions (0 conversions everywhere) do not divide by zero', () => {
    const r = diffProportions({ conversions: 0, units: 100 }, { conversions: 0, units: 100 });
    expect(r.p).toBe(1);
    expect(Number.isNaN(r.relLift)).toBe(true);
  });

  it('rejects impossible inputs', () => {
    expect(() => diffProportions({ conversions: 5, units: 3 }, { conversions: 1, units: 3 })).toThrow();
    expect(() => diffMeans({ n: 1, mean: 0, variance: 1 }, { n: 5, mean: 0, variance: 1 })).toThrow();
    expect(() => srmCheck([10, 10], [1])).toThrow();
    expect(() => srmCheck([10, 10], [1, 0])).toThrow();
  });

  it('diffMeans: below MIN_UNITS_PER_ARM in either arm it reports not enough data instead of a result (D-15)', () => {
    // n = 5 per arm with a large observed gap: the z test would call this significant; the guard refuses.
    expect(diffMeans({ n: 5, mean: 10, variance: 25 }, { n: 5, mean: 20, variance: 25 })).toEqual({ notEnoughData: true, minUnitsPerArm: MIN_UNITS_PER_ARM, unitsA: 5, unitsB: 5 });
    expect(diffMeans({ n: 2, mean: 0, variance: 1 }, { n: 1000, mean: 0, variance: 1 })).toMatchObject({ notEnoughData: true });
    expect(diffMeans({ n: 1000, mean: 0, variance: 1 }, { n: MIN_UNITS_PER_ARM - 1, mean: 0, variance: 1 })).toMatchObject({ notEnoughData: true, unitsB: 99 });
    const r = diffMeans({ n: MIN_UNITS_PER_ARM, mean: 10, variance: 25 }, { n: MIN_UNITS_PER_ARM, mean: 11, variance: 25 });
    if ('notEnoughData' in r) throw new Error('100 per arm must give a result');
    expect(r.diff).toBe(1);
    expect(r.se).toBeCloseTo(Math.sqrt(0.5), 14);
    expect(MIN_UNITS_PER_ARM).toBe(100);
  });

  it('summarize matches a two-pass computation', () => {
    const rand = mulberry32(1);
    const xs = Array.from({ length: 1000 }, () => 1e6 + rand());
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
    const s = summarize(xs);
    expect(s.mean).toBeCloseTo(m, 8);
    expect(s.variance / v).toBeCloseTo(1, 9);
  });

  it('SRM: a healthy 50/50 split passes, a 50.7/49.3 split of 100k blocks (HO-04 threshold)', () => {
    expect(srmCheck([5012, 4988], [5000, 5000]).blocked).toBe(false);
    expect(srmCheck([50_700, 49_300], [5000, 5000]).blocked).toBe(true);
    expect(srmCheck([0, 0], [1, 1]).p).toBe(1);
  });

  it('sequential: rejection boundary and the confidence sequence agree (|θ̂| ≥ half-width ⇔ Λ ≥ 1/α)', () => {
    const v = 1e-4;
    const tau2 = 4e-4;
    const h = csHalfWidth(v, tau2, 0.05);
    expect(logLambda(h * (1 + 1e-9), v, tau2)).toBeGreaterThan(Math.log(20));
    expect(logLambda(h * (1 - 1e-9), v, tau2)).toBeLessThan(Math.log(20));
  });

  it('sequential: p never increases, CI never widens, rejection is sticky', () => {
    const rand = mulberry32(7);
    const looks = Array.from({ length: 40 }, (_, t) => ({ diff: (rand() - 0.5) * 0.05, variance: 0.01 / (t + 1) }));
    const path = sequentialPath(looks, 4e-4);
    for (let t = 1; t < path.length; t++) {
      expect(path[t]!.p).toBeLessThanOrEqual(path[t - 1]!.p);
      expect(path[t]!.ciHigh - path[t]!.ciLow).toBeLessThanOrEqual(path[t - 1]!.ciHigh - path[t - 1]!.ciLow + 1e-15);
      if (path[t - 1]!.reject) expect(path[t]!.reject).toBe(true);
    }
  });

  it('sequential: a zero-variance look (no conversions yet) carries no evidence instead of throwing', () => {
    const first = sequentialStep({ diff: 0, variance: 0 }, 4e-4);
    expect(first).toMatchObject({ p: 1, reject: false, ciLow: -Infinity, ciHigh: Infinity });
    const later = sequentialStep({ diff: 0.01, variance: 1e-5 }, 4e-4, 0.05, first);
    expect(sequentialStep({ diff: 0, variance: 0 }, 4e-4, 0.05, later)).toMatchObject({ p: later.p, ciLow: later.ciLow, ciHigh: later.ciHigh, reject: later.reject });
  });

  it('simulator PRNG is deterministic per seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });
});
