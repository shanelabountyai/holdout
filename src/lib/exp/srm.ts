// Sample-ratio mismatch (PRD; HO-04 enforces the block in Phase 3). A broken split means the comparison is not
// randomized any more, so no effect estimate from it is trustworthy, however significant.
import { chi2Sf } from './normal';

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
