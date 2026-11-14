// Unit tests for the engine's edges; numeric agreement lives in ho-02-oracle.test.ts.
import { describe, expect, it } from 'vitest';
import { csHalfWidth, diffMeans, diffProportions, logLambda, mulberry32, normCdf, normPpf, sequentialPath, srmCheck, summarize } from '@/lib/exp';

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

  it('simulator PRNG is deterministic per seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });
});
