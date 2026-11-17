// Sample-ratio mismatch (PRD; HO-04 enforces the block in Phase 3). A broken split means the comparison is not
// randomized any more, so no effect estimate from it is trustworthy, however significant.
import { chi2Sf, lnGamma } from './normal';

/** p below this blocks the readout (HO-04). */
export const SRM_ALPHA = 0.001;

export interface SrmResult {
  chi2: number;
  df: number;
  p: number;
  blocked: boolean;
  expected: number[];
}

/** Pearson chi-square goodness of fit of observed units per variant against configured weights (any positive scale). */
export function srmCheck(observed: readonly number[], weights: readonly number[], alpha = SRM_ALPHA): SrmResult {
  if (observed.length !== weights.length || observed.length < 2) throw new RangeError('need one weight per variant, at least two variants');
  if (observed.some((o) => !Number.isInteger(o) || o < 0)) throw new RangeError('observed counts must be non-negative integers');
  if (weights.some((w) => !(w > 0))) throw new RangeError('weights must be positive (a 0-weight variant has no traffic to check)');
  const total = observed.reduce((s, o) => s + o, 0);
  const wsum = weights.reduce((s, w) => s + w, 0);
  const expected = weights.map((w) => (total * w) / wsum);
  if (total === 0) return { chi2: 0, df: observed.length - 1, p: 1, blocked: false, expected };
  let chi2 = 0;
  for (let i = 0; i < observed.length; i++) chi2 += (observed[i]! - expected[i]!) ** 2 / expected[i]!;
  const df = observed.length - 1;
  const p = chi2Sf(chi2, df);
  return { chi2, df, p, blocked: p < alpha, expected };
}

// When is the SRM check able to see a broken split at all? (issue #5, D-41.) With p < 0.001 the check is strict about
// false alarms, so on a small sample it cannot detect a modest exposure loss: in the Phase 4 case study an 8% loss of
// treatment exposures only crossed the threshold at about 15 000 units, and the readout said "Ship" before that. The
// readout therefore treats the split as checkable only once the test has SRM_POWER power to detect a loss of
// SRM_DETECTABLE_LOSS of one arm's exposures. This changes no test statistic; it is a sample-size bound on the
// existing χ² test, mirrored by srm_power_case in tools/oracle/oracle.py.

/** The exposure loss (share of one arm's exposures that never arrive) the SRM check must be able to see: the case study's. */
export const SRM_DETECTABLE_LOSS = 0.08;
/** Power the SRM check needs against that loss before the readout may ship (the platform's design power, D-25). */
export const SRM_POWER = 0.8;

/** Upper quantile of χ²(df): the x with chi2Sf(x, df) = alpha (bisection; chi2Sf is decreasing in x). */
export function chi2Isf(alpha: number, df: number): number {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError('chi2Isf: need 0 < alpha < 1');
  let lo = 0;
  let hi = Math.max(1, df);
  while (chi2Sf(hi, df) > alpha) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-15 * hi; i++) {
    const mid = (lo + hi) / 2;
    if (chi2Sf(mid, df) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Noncentral χ² survival P(X ≥ x), X ~ χ²(df, λ): the Poisson(λ/2) mixture of central χ²(df + 2j) survivals. */
export function ncChi2Sf(x: number, df: number, lambda: number): number {
  if (lambda < 0) throw new RangeError('ncChi2Sf: need lambda >= 0');
  if (lambda === 0) return chi2Sf(x, df);
  const h = lambda / 2;
  let total = 0;
  // Sum outward from the Poisson mode so the weights that matter come first; stop once a weight is negligible (each
  // term is at most its weight, and the weights fall off faster than geometrically past that point).
  const mode = Math.floor(h);
  const lw = (j: number) => -h + j * Math.log(h) - lnGamma(j + 1);
  for (let j = mode; j >= 0; j--) {
    const w = Math.exp(lw(j));
    total += w * chi2Sf(x, df + 2 * j);
    if (w < 1e-18 && j < mode) break;
  }
  for (let j = mode + 1; j < mode + 10_000; j++) {
    const w = Math.exp(lw(j));
    total += w * chi2Sf(x, df + 2 * j);
    if (w < 1e-18) break;
  }
  return Math.min(1, total);
}

export interface SrmPowerResult {
  /** χ²(df) critical value at alpha. */
  critical: number;
  /** Noncentrality at which the test has the requested power. */
  lambda: number;
  /** Cohen's w² of the hardest-to-see loss: Σ (q − p)² / p, q the split after losing `loss` of one arm's exposures. */
  w2: number;
  /** Smallest total units (all arms) with that power: ⌈λ / w²⌉. */
  minTotalUnits: number;
}

/**
 * How many units the SRM χ² test needs to detect losing `loss` of one arm's exposures with probability `power` at `alpha`.
 * The loss is put on whichever arm makes it hardest to detect (the smallest w²), so the bound holds for every arm.
 */
export function srmPower(weights: readonly number[], loss = SRM_DETECTABLE_LOSS, alpha = SRM_ALPHA, power = SRM_POWER): SrmPowerResult {
  if (weights.length < 2 || weights.some((w) => !(w > 0))) throw new RangeError('need at least two positive weights');
  if (!(loss > 0 && loss < 1) || !(power > 0 && power < 1)) throw new RangeError('need 0 < loss < 1 and 0 < power < 1');
  const sum = weights.reduce((s, w) => s + w, 0);
  const p = weights.map((w) => w / sum);
  const df = p.length - 1;
  let w2 = Infinity;
  for (let j = 0; j < p.length; j++) {
    const kept = 1 - p[j]! * loss;
    const q = p.map((pi, i) => (i === j ? pi * (1 - loss) : pi) / kept);
    w2 = Math.min(w2, q.reduce((s, qi, i) => s + (qi - p[i]!) ** 2 / p[i]!, 0));
  }
  const critical = chi2Isf(alpha, df);
  let lo = 0;
  let hi = 1;
  while (ncChi2Sf(critical, df, hi) < power) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-15 * hi; i++) {
    const mid = (lo + hi) / 2;
    if (ncChi2Sf(critical, df, mid) < power) lo = mid;
    else hi = mid;
  }
  const lambda = (lo + hi) / 2;
  return { critical, lambda, w2, minTotalUnits: Math.ceil(lambda / w2) };
}

/** Total units below which the readout reports "SRM not yet checkable" and does not ship (D-41). */
export function srmMinTotalUnits(weights: readonly number[]): number {
  return srmPower(weights).minTotalUnits;
}
