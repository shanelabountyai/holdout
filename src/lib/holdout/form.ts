import { z } from 'zod';
import { Refused } from '@/core/errors';
import type { DesignInput } from './experiments';

// The experiment form (Phase 2 UI), in the units people type: percent and percentage points for a conversion metric,
// metric units for a mean. toDesign turns it into the stored design (fractions, basis points).

const kind = z.enum(['proportion', 'mean']);
export const design = z.object({
  key: z.string().max(64),
  name: z.string().max(120),
  description: z.string().max(2000).default(''),
  metricEvent: z.string().max(100),
  metricKind: kind,
  baseline: z.string().max(40).default(''),
  sd: z.string().max(40).default(''),
  mde: z.string().max(40),
  variantKeys: z.array(z.string().max(64)).max(10).default([]),
  variantNames: z.array(z.string().max(80)).max(10).default([]),
  variantWeights: z.array(z.string().max(20)).max(10).default([]),
  guardrailEvents: z.array(z.string().max(100)).max(10).default([]),
  guardrailKinds: z.array(kind).max(10).default([]),
});
export type DesignForm = z.infer<typeof design>;

const number = (s: string, label: string) => {
  const t = s.trim();
  const n = t === '' ? NaN : Number(t);
  if (!Number.isFinite(n)) throw new Refused(`${label}: enter a number.`);
  return n;
};

/** Percent with at most two decimals → basis points, exactly. */
const bps = (s: string) => {
  const pct = number(s, 'Variant weight');
  const b = Math.round(pct * 100);
  if (Math.abs(pct * 100 - b) > 1e-6) throw new Refused('Variant weights: at most two decimals (steps of 0.01%).');
  return b;
};

/** The form, in the units people type (percent, percentage points), to the stored design (fractions). */
export function toDesign(i: DesignForm): DesignInput {
  const proportion = i.metricKind === 'proportion';
  const variants = i.variantKeys
    .map((key, n) => ({ key, name: i.variantNames[n] ?? '', w: i.variantWeights[n] ?? '' }))
    .filter((v) => v.key.trim() !== '')
    .map((v) => ({ key: v.key, name: v.name, weight: bps(v.w) }));
  const guardrails = i.guardrailEvents
    .map((event, n) => ({ event: event.trim(), kind: i.guardrailKinds[n] ?? 'proportion' }))
    .filter((g) => g.event !== '');
  return {
    key: i.key,
    name: i.name,
    description: i.description,
    metricEvent: i.metricEvent.trim(),
    metricKind: i.metricKind,
    baselineRate: proportion ? number(i.baseline, 'Baseline conversion rate') / 100 : null,
    baselineMean: !proportion && i.baseline.trim() !== '' ? number(i.baseline, 'Baseline mean') : null,
    baselineSd: proportion ? null : number(i.sd, 'Standard deviation'),
    mde: proportion ? number(i.mde, 'Minimum detectable effect') / 100 : number(i.mde, 'Minimum detectable effect'),
    variants,
    guardrails,
  };
}

