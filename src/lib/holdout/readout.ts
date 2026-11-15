import { diffMeans, diffProportions, MIN_UNITS_PER_ARM, sequentialStep, srmCheck, SRM_ALPHA, type SequentialResult } from '@/lib/exp';

// The readout (PRD "Readout page", Phase 3). A pure function from cumulative per-look aggregates to numbers and one
// decision. The loader in readout-data.ts builds the aggregates from Exposure and Conversion; this file never touches the
// database, so the decision rule is tested directly and by simulation (tests/holdout/readout-*.test.ts).
//
// Primary result: the mSPRT always-valid p-value and confidence sequence (D-02, D-10, τ² = MDE²) over every look so far.
// The fixed-horizon test on the latest look is shown alongside it but never decides. With more than one treatment, each is
// compared with control (the first variant) at α / (k − 1) (Bonferroni, D-30). Guardrails use the same always-valid test
// (D-31). SRM at p < 0.001 blocks everything else (HO-04). Every number in a Readout is finite or null: it is stored as
// JSON in the audit log when an experiment stops (HO-05), and JSON has no NaN or Infinity.

export type Kind = 'proportion' | 'mean';

/** One metric in one arm at one look. Proportion: y ∈ {0, 1} per unit (converted). Mean: y = sum of values per unit. */
export type MetricAgg = { sum: number; sumSq: number };
/** One arm at one look, cumulative: every unit exposed and every metric event received up to the look. */
export type ArmAgg = { units: number; metrics: Record<string, MetricAgg> };
export type Look = { at: string; arms: ArmAgg[] };

export type ReadoutDesign = {
  metricEvent: string;
  metricKind: Kind;
  mde: number;
  alpha: number;
  plannedUnitsPerArm: number;
  /** In frozen order: position 0 is control. */
  variants: { key: string; name: string; weight: number }[];
  guardrails: { event: string; kind: Kind }[];
};

export type DecisionState = 'srm' | 'not_enough_data' | 'ship' | 'guardrail' | 'worse' | 'no_effect' | 'keep_running';

export type Comparison = {
  variant: string;
  /** B − control on the metric's own scale (rate as a fraction, or metric units). */
  diff: number;
  relLift: number | null;
  /** The α this comparison is tested at (Bonferroni across treatments for the primary metric). */
  alpha: number;
  sequential: { p: number; ciLow: number | null; ciHigh: number | null; reject: boolean; looks: number };
  fixed: { p: number; ciLow: number; ciHigh: number; se: number } | null;
  verdict: 'better' | 'worse' | 'undecided';
};

export type GuardrailResult = {
  event: string;
  kind: Kind;
  /** τ² is fixed at the first look where control has a non-zero level (D-31); null until then. */
  tau2: number | null;
  arms: { variant: string; level: number | null }[];
  comparisons: (Omit<Comparison, 'verdict'> & { moved: 'up' | 'down' | null })[];
};

export type Readout = {
  asOf: string;
  looks: number;
  metricEvent: string;
  metricKind: Kind;
  mde: number;
  alpha: number;
  plannedUnitsPerArm: number;
  minArmUnits: number;
  arms: { key: string; name: string; weight: number; units: number; level: number | null }[];
  srm: { chi2: number; df: number; p: number; blocked: boolean; expected: number[] };
  /** null when SRM blocks the readout or an arm is below MIN_UNITS_PER_ARM: no effect is reported then. */
  comparisons: Comparison[] | null;
  guardrails: GuardrailResult[] | null;
  decision: { state: DecisionState; variant: string | null; headline: string; detail: string };
};

const fin = (x: number): number | null => (Number.isFinite(x) ? x : null);

function stats(n: number, m: MetricAgg | undefined) {
  const sum = m?.sum ?? 0;
  const sumSq = m?.sumSq ?? 0;
  const mean = n > 0 ? sum / n : 0;
  const variance = n > 1 ? Math.max(0, (sumSq - n * mean * mean) / (n - 1)) : 0;
  return { n, sum, mean, variance };
}

/** The estimate and its plug-in variance for one look, the same construction the HO-03 simulator uses. */
function lookOf(kind: Kind, event: string, a: ArmAgg, b: ArmAgg) {
  const sa = stats(a.units, a.metrics[event]);
  const sb = stats(b.units, b.metrics[event]);
  if (kind === 'proportion') return { diff: sb.mean - sa.mean, variance: (sa.mean * (1 - sa.mean)) / sa.n + (sb.mean * (1 - sb.mean)) / sb.n };
  return { diff: sb.mean - sa.mean, variance: sa.variance / sa.n + sb.variance / sb.n };
}

function fixedOf(kind: Kind, event: string, a: ArmAgg, b: ArmAgg, alpha: number) {
  if (kind === 'proportion') {
    const r = diffProportions({ conversions: a.metrics[event]?.sum ?? 0, units: a.units }, { conversions: b.metrics[event]?.sum ?? 0, units: b.units }, alpha);
    return { r, relLift: fin(r.relLift) };
  }
  const r = diffMeans(stats(a.units, a.metrics[event]), stats(b.units, b.metrics[event]), alpha);
  if ('notEnoughData' in r) return null;
  return { r, relLift: fin(r.relLift) };
}

/** Runs the mSPRT over every look at which both arms have MIN_UNITS_PER_ARM units. */
function sequentialOver(looks: Look[], kind: Kind, event: string, j: number, tau2: (l: Look) => number | null, alpha: number) {
  let s: SequentialResult | undefined;
  let used = 0;
  let fixedTau: number | null = null;
  for (const l of looks) {
    const a = l.arms[0]!;
    const b = l.arms[j]!;
    if (a.units < MIN_UNITS_PER_ARM || b.units < MIN_UNITS_PER_ARM) continue;
    fixedTau ??= tau2(l);
    if (fixedTau === null) continue;
    s = sequentialStep(lookOf(kind, event, a, b), fixedTau, alpha, s);
    used++;
  }
  return { s, used, tau2: fixedTau };
}

function compare(looks: Look[], kind: Kind, event: string, j: number, alpha: number, tau2: (l: Look) => number | null) {
  const last = looks.at(-1)!;
  const { s, used, tau2: t } = sequentialOver(looks, kind, event, j, tau2, alpha);
  const f = fixedOf(kind, event, last.arms[0]!, last.arms[j]!, alpha);
  const { diff } = lookOf(kind, event, last.arms[0]!, last.arms[j]!);
  const ciLow = s ? fin(s.ciLow) : null;
  const ciHigh = s ? fin(s.ciHigh) : null;
  const reject = s?.reject ?? false;
  // Direction from the confidence sequence (it excludes 0 once the test rejects), else the point estimate.
  const dir = ciLow !== null && ciLow > 0 ? 1 : ciHigh !== null && ciHigh < 0 ? -1 : Math.sign(diff);
  return {
    tau2: t,
    dir,
    c: {
      diff,
      relLift: f ? f.relLift : null,
      alpha,
      sequential: { p: s?.p ?? 1, ciLow, ciHigh, reject, looks: used },
      fixed: f ? { p: f.r.p, ciLow: f.r.ciLow, ciHigh: f.r.ciHigh, se: f.r.se } : null,
    },
  };
}

const pts = (kind: Kind, x: number) => (kind === 'proportion' ? `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(2)} pts` : `${x >= 0 ? '+' : '−'}${Number(Math.abs(x).toPrecision(4))}`);
const pv = (p: number) => (p < 0.0001 ? 'p < 0.0001' : `p = ${p.toFixed(4)}`);
const ci = (kind: Kind, lo: number | null, hi: number | null) => `${lo === null ? '−∞' : pts(kind, lo)} to ${hi === null ? '+∞' : pts(kind, hi)}`;
const count = (n: number) => n.toLocaleString('en-US');

/** Guardrail τ: 10% of control's level at the first eligible look (or 10% of its standard deviation for a zero mean), D-31. */
function guardrailTau(kind: Kind, event: string) {
  return (l: Look): number | null => {
    const a = stats(l.arms[0]!.units, l.arms[0]!.metrics[event]);
    const scale = Math.abs(a.mean) > 0 ? Math.abs(a.mean) : kind === 'mean' ? Math.sqrt(a.variance) : 0;
    return scale > 0 ? (0.1 * scale) ** 2 : null;
  };
}

export function analyze(d: ReadoutDesign, looks: Look[]): Readout {
  if (!looks.length) throw new RangeError('a readout needs at least one look');
  const last = looks.at(-1)!;
  const k = d.variants.length;
  const units = last.arms.map((a) => a.units);
  const total = units.reduce((s, u) => s + u, 0);
  const minArmUnits = Math.min(...units);
  const srm = srmCheck(units, d.variants.map((v) => v.weight), SRM_ALPHA);
  const blocked = srm.blocked;
  const enough = minArmUnits >= MIN_UNITS_PER_ARM;
  const show = !blocked && enough;
  const base = {
    asOf: last.at,
    looks: looks.length,
    metricEvent: d.metricEvent,
    metricKind: d.metricKind,
    mde: d.mde,
    alpha: d.alpha,
    plannedUnitsPerArm: d.plannedUnitsPerArm,
    minArmUnits,
    arms: d.variants.map((v, i) => ({ ...v, units: units[i]!, level: show ? stats(units[i]!, last.arms[i]!.metrics[d.metricEvent]).mean : null })),
    srm: { chi2: srm.chi2, df: srm.df, p: srm.p, blocked, expected: srm.expected },
  };
  const out = (state: DecisionState, variant: string | null, headline: string, detail: string, comparisons: Comparison[] | null = null, guardrails: GuardrailResult[] | null = null): Readout => ({
    ...base,
    comparisons,
    guardrails,
    decision: { state, variant, headline, detail },
  });

  // HO-04: a broken split is not a randomized comparison any more; no effect estimate is trustworthy, so none is shown.
  if (total > 0 && blocked)
    return out('srm', null, 'Stop: sample-ratio mismatch', `The traffic split does not match the configured weights (χ² = ${srm.chi2.toFixed(2)}, ${pv(srm.p)}, threshold 0.001). The comparison is no longer randomized, so no effect is reported. Find the cause (assignment, exposure logging, bots), fix it and start a new experiment.`);
  if (!enough)
    return out('not_enough_data', null, 'Keep running: not enough data', `Every arm needs at least ${MIN_UNITS_PER_ARM} units before any result is shown. The smallest arm has ${count(minArmUnits)}.`);

  const primaryAlpha = d.alpha / (k - 1);
  const want = Math.sign(d.mde) || 1; // the MDE's sign says which direction is an improvement
  const comparisons: Comparison[] = [];
  for (let j = 1; j < k; j++) {
    const { c, dir } = compare(looks, d.metricKind, d.metricEvent, j, primaryAlpha, () => d.mde * d.mde);
    comparisons.push({ variant: d.variants[j]!.key, ...c, verdict: c.sequential.reject ? (dir === want ? 'better' : 'worse') : 'undecided' });
  }
  const guardrails: GuardrailResult[] = d.guardrails.map((g) => {
    let tau2: number | null = null;
    const cs = [];
    for (let j = 1; j < k; j++) {
      const r = compare(looks, g.kind, g.event, j, d.alpha, guardrailTau(g.kind, g.event));
      tau2 ??= r.tau2;
      cs.push({ variant: d.variants[j]!.key, ...r.c, moved: r.c.sequential.reject ? (r.dir > 0 ? ('up' as const) : ('down' as const)) : null });
    }
    return { event: g.event, kind: g.kind, tau2, arms: d.variants.map((v, i) => ({ variant: v.key, level: stats(units[i]!, last.arms[i]!.metrics[g.event]).mean })), comparisons: cs };
  });

  const name = (key: string) => d.variants.find((v) => v.key === key)!.name;
  const winners = comparisons.filter((c) => c.verdict === 'better').sort((a, b) => want * (b.diff - a.diff));
  if (winners.length) {
    const w = winners[0]!;
    const evidence = `${pts(d.metricKind, w.diff)} on ${d.metricEvent} against ${d.variants[0]!.name} (always-valid ${Math.round((1 - w.alpha) * 100)}% confidence sequence ${ci(d.metricKind, w.sequential.ciLow, w.sequential.ciHigh)}, ${pv(w.sequential.p)})`;
    const moved = guardrails.flatMap((g) => g.comparisons.filter((c) => c.variant === w.variant && c.moved).map((c) => ({ g, c })));
    if (moved.length) {
      const list = moved.map(({ g, c }) => `${g.event} moved ${c.moved} (${pts(g.kind, c.diff)}, ${pv(c.sequential.p)})`).join('; ');
      return out('guardrail', w.variant, `Hold: a guardrail moved for ${name(w.variant)}`, `${name(w.variant)} beats control: ${evidence}. But ${list}. Review the guardrail before shipping.`, comparisons, guardrails);
    }
    return out('ship', w.variant, `Ship ${name(w.variant)}`, `${name(w.variant)} beats control: ${evidence}. No guardrail moved.`, comparisons, guardrails);
  }
  if (comparisons.every((c) => c.verdict === 'worse'))
    return out('worse', null, 'Stop: no variant beats control', `Every variant is significantly worse than ${d.variants[0]!.name} on ${d.metricEvent} (${comparisons.map((c) => `${name(c.variant)} ${pts(d.metricKind, c.diff)}, ${pv(c.sequential.p)}`).join('; ')}). Keep control.`, comparisons, guardrails);
  if (minArmUnits >= d.plannedUnitsPerArm)
    return out('no_effect', null, 'No detectable effect at planned sample size', `Every arm reached the planned ${count(d.plannedUnitsPerArm)} units (2× the fixed-horizon n, D-16) and no variant differs from control on ${d.metricEvent}. A real effect, if any, is probably smaller than the minimum detectable effect of ${pts(d.metricKind, Math.abs(d.mde)).slice(1)}.`, comparisons, guardrails);
  return out('keep_running', null, 'Keep running', `No decision yet. The smallest arm has ${count(minArmUnits)} of the planned ${count(d.plannedUnitsPerArm)} units (${Math.floor((100 * minArmUnits) / d.plannedUnitsPerArm)}%). The sequential test can be checked at any time without inflating false positives.`, comparisons, guardrails);
}
