import { Refused } from '@/core/errors';
import type { MetricKind } from '@/generated/prisma/enums';
import { BUCKETS, plannedUnitsPerArm, sampleSizeMeans, sampleSizeProportions } from '@/lib/exp';

// The design limits (D-25) and the up-front plan (D-16, D-20), with no server imports so the new-experiment form can run the
// same planFor in the browser while it is filled in. Moved here unchanged from experiments.ts, which re-exports them.

export const LIMITS = { minVariants: 2, maxVariants: 4, maxGuardrails: 5, minWeightBps: 100 } as const; // D-25
export const DEFAULT_ALPHA = 0.05;
export const DEFAULT_POWER = 0.8;

export type PlanInput = {
  metricKind: MetricKind;
  baselineRate?: number | null;
  baselineSd?: number | null;
  mde: number;
  variants: { weight: number }[];
};

export type Plan = { fixedUnitsPerArm: number; plannedUnitsPerArm: number; plannedTotalUnits: number };

const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * The planned sample size, fixed up front (PRD). Fixed-horizon n per arm at α/power for the primary metric, then
 * plannedUnitsPerArm(…, 'sequential'), which is 2× under D-16. The per-arm formula assumes equal arms, so with an unequal
 * split the smallest arm must reach it: total = per-arm n × 10 000 / smallest weight (D-20).
 */
export function planFor(d: PlanInput, alpha = DEFAULT_ALPHA, power = DEFAULT_POWER): Plan {
  let fixed: number;
  if (d.metricKind === 'proportion') {
    if (!fin(d.baselineRate) || d.baselineRate <= 0 || d.baselineRate >= 1) throw new Refused('Baseline conversion rate must be between 0% and 100%.');
    if (!fin(d.mde) || d.mde === 0) throw new Refused('The minimum detectable effect must be a number other than 0.');
    const p2 = d.baselineRate + d.mde;
    if (p2 <= 0 || p2 >= 1) throw new Refused('Baseline plus the minimum detectable effect must stay between 0% and 100%.');
    fixed = sampleSizeProportions(d.baselineRate, d.mde, alpha, power);
  } else {
    if (!fin(d.baselineSd) || d.baselineSd <= 0) throw new Refused('The standard deviation must be a number above 0.');
    if (!fin(d.mde) || d.mde === 0) throw new Refused('The minimum detectable effect must be a number other than 0.');
    fixed = sampleSizeMeans(d.baselineSd, d.mde, alpha, power);
  }
  const fixedUnitsPerArm = Math.ceil(fixed);
  const perArm = plannedUnitsPerArm(fixed, 'sequential');
  const minWeight = Math.min(...d.variants.map((v) => v.weight));
  const total = Math.ceil((perArm * BUCKETS) / minWeight);
  if (!Number.isSafeInteger(total) || total > 2_000_000_000) throw new Refused('That plan needs more units than Holdout can track. Raise the minimum detectable effect.');
  return { fixedUnitsPerArm, plannedUnitsPerArm: perArm, plannedTotalUnits: total };
}
