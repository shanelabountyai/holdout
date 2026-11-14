// Fixed-horizon comparisons of a treatment (B) against control (A). Effects are B − A. Two-sided throughout.
import { normPpf, twoSidedP } from './normal';
import { MIN_UNITS_PER_ARM } from './sequential';

export interface FixedResult {
  /** B − A on the metric's own scale (absolute, not relative). */
  diff: number;
  /** (B − A) / A; NaN when A's level is 0. Point estimate only. */
  relLift: number;
  /** Standard error behind the confidence interval. */
  se: number;
  z: number;
  p: number;
  ciLow: number;
  ciHigh: number;
}

export interface Proportion {
  conversions: number;
  units: number;
}

/** Summary statistics of a continuous metric; `variance` is the sample variance (n − 1 denominator). */
export interface MeanStats {
  n: number;
  mean: number;
  variance: number;
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new RangeError(msg);
}

/**
 * Difference in proportions. The p-value uses the pooled two-proportion z test (statsmodels `proportions_ztest`);
 * the CI is the unpooled Wald interval (statsmodels `confint_proportions_2indep(method="wald")`), which is what the
 * readout shows. The two can disagree right at the boundary; the readout's decision uses the p-value.
 */
export function diffProportions(a: Proportion, b: Proportion, alpha = 0.05): FixedResult {
  check(a.units > 0 && b.units > 0, 'each arm needs at least one unit');
  check(a.conversions >= 0 && a.conversions <= a.units && b.conversions >= 0 && b.conversions <= b.units, 'conversions must be within [0, units]');
  const pa = a.conversions / a.units;
  const pb = b.conversions / b.units;
  const diff = pb - pa;
  const pooled = (a.conversions + b.conversions) / (a.units + b.units);
  const se0 = Math.sqrt(pooled * (1 - pooled) * (1 / a.units + 1 / b.units));
  const z = se0 > 0 ? diff / se0 : 0;
  const se = Math.sqrt((pa * (1 - pa)) / a.units + (pb * (1 - pb)) / b.units);
  const q = normPpf(1 - alpha / 2);
  return { diff, relLift: pa > 0 ? diff / pa : NaN, se, z, p: se0 > 0 ? twoSidedP(z) : 1, ciLow: diff - q * se, ciHigh: diff + q * se };
}

/** Returned instead of a result when an arm has fewer than `minUnitsPerArm` units: the readout says "not enough data". */
export interface NotEnoughData {
  notEnoughData: true;
  minUnitsPerArm: number;
  unitsA: number;
  unitsB: number;
}

/**
 * Difference in means from summary stats: large-sample z test on the Welch (unequal-variance) standard error (D-09).
 * The z premise only holds at large n (A/A type I error is ~8.8% at 5/arm, ~6.6% at 10/arm), so below
 * MIN_UNITS_PER_ARM in either arm this returns NotEnoughData instead of a result (D-15).
 */
export function diffMeans(a: MeanStats, b: MeanStats, alpha = 0.05): FixedResult | NotEnoughData {
  check(a.n > 1 && b.n > 1, 'each arm needs at least two units');
  check(a.variance >= 0 && b.variance >= 0, 'variance must be non-negative');
  if (a.n < MIN_UNITS_PER_ARM || b.n < MIN_UNITS_PER_ARM) return { notEnoughData: true, minUnitsPerArm: MIN_UNITS_PER_ARM, unitsA: a.n, unitsB: b.n };
  const diff = b.mean - a.mean;
  const se = Math.sqrt(a.variance / a.n + b.variance / b.n);
  const z = se > 0 ? diff / se : 0;
  const q = normPpf(1 - alpha / 2);
  return { diff, relLift: a.mean !== 0 ? diff / a.mean : NaN, se, z, p: se > 0 ? twoSidedP(z) : 1, ciLow: diff - q * se, ciHigh: diff + q * se };
}

/** Online summary of a sample (Welford), for callers holding raw values. */
export function summarize(values: Iterable<number>): MeanStats {
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (const x of values) {
    n++;
    const d = x - mean;
    mean += d / n;
    m2 += d * (x - mean);
  }
  return { n, mean, variance: n > 1 ? m2 / (n - 1) : 0 };
}

/**
 * Units per arm (equal split) to detect an absolute lift of `mde` over `baseline` with a two-sided α test at the
 * given power: n = (z_{1−α/2}·√(2·p̄(1−p̄)) + z_{power}·√(p₁(1−p₁) + p₂(1−p₂)))² / mde², p̄ = (p₁+p₂)/2.
 * Returned unrounded; the planner rounds up.
 */
export function sampleSizeProportions(baseline: number, mde: number, alpha = 0.05, power = 0.8): number {
  const p1 = baseline;
  const p2 = baseline + mde;
  check(p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1 && mde !== 0, 'baseline and baseline + mde must be in (0, 1), mde ≠ 0');
  const pbar = (p1 + p2) / 2;
  const za = normPpf(1 - alpha / 2);
  const zb = normPpf(power);
  const num = za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return (num * num) / (mde * mde);
}

/** Units per arm (equal split) for a difference in means: n = 2σ²(z_{1−α/2} + z_{power})² / mde². Unrounded. */
export function sampleSizeMeans(sd: number, mde: number, alpha = 0.05, power = 0.8): number {
  check(sd > 0 && mde !== 0, 'sd > 0 and mde ≠ 0');
  const z = normPpf(1 - alpha / 2) + normPpf(power);
  return (2 * sd * sd * z * z) / (mde * mde);
}

/**
 * Sequential (mSPRT) experiments plan their horizon at this multiple of the fixed-horizon n (D-16, resolving D-14).
 * At the fixed-horizon n the mSPRT has only ~49% (conversion) / ~39% (means) power; at 2× it has 86.7% / 84.4%
 * (HO-03 simulator, 2 000 runs, seed 28). Change it here and in tools/oracle/oracle.py together.
 */
export const SEQUENTIAL_HORIZON_MULTIPLIER = 2;

/** `sequential` is the primary readout (D-02); `fixed` is the fixed-horizon test shown alongside it. */
export type AnalysisMethod = 'sequential' | 'fixed';

/**
 * Planned units per arm: the fixed-horizon n from `sampleSizeProportions` / `sampleSizeMeans`, rounded up, times
 * SEQUENTIAL_HORIZON_MULTIPLIER for a sequential experiment. This is the horizon the readout's "no detectable
 * effect at planned sample size" state is measured against (Phase 3).
 */
export function plannedUnitsPerArm(fixedHorizonN: number, method: AnalysisMethod = 'sequential'): number {
  check(Number.isFinite(fixedHorizonN) && fixedHorizonN > 0, 'fixed-horizon n must be a positive number');
  const n = Math.ceil(fixedHorizonN);
  return method === 'sequential' ? n * SEQUENTIAL_HORIZON_MULTIPLIER : n;
}
