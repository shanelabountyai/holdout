// Synthetic traffic with a known true effect (PRD "Simulator"), used by tests to measure the false-positive rate
// (HO-03) and power empirically. Units go through the real assignment function, so the realized split is the
// binomial one production sees, and SRM is checked the same way.
import { BUCKETS, bucketOf } from './hash';
import { normPpf } from './normal';
import { srmCheck, SRM_ALPHA } from './srm';
import { diffMeans, diffProportions } from './tests';
import { MIN_UNITS_PER_ARM, sequentialStep, type SequentialResult } from './sequential';

/** mulberry32: tiny, fast, seedable 32-bit PRNG. Returns floats in [0, 1). Not for anything security-relevant. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = rand();
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

export type Metric =
  | { kind: 'proportion'; baseline: number; trueLift: number }
  | { kind: 'mean'; baseline: number; sd: number; trueLift: number };

export interface SimConfig {
  metric: Metric;
  /** Total units per run (both arms together). */
  unitsPerRun: number;
  runs: number;
  seed: number;
  alpha?: number;
  /** Treatment share in basis points (default 5 000 = 50/50). */
  treatmentWeight?: number;
  /** A sequential look after every this many units in total (default 400, i.e. ~200 per arm). */
  peekEvery?: number;
  /** Mixture variance for the sequential test (D-10: mde²). */
  tau2: number;
}

export interface SimReport {
  runs: number;
  /** Share of runs where the fixed-horizon test at `unitsPerRun` rejected H0. */
  fixedRejectRate: number;
  /** Share of runs where the sequential test rejected at any look up to `unitsPerRun`. */
  sequentialRejectRate: number;
  /** Share of runs where a fixed-horizon test checked at every look would have rejected at some look: the peeking problem. */
  naivePeekRejectRate: number;
  /** Share of runs whose final split failed the SRM check (expected ≈ SRM_ALPHA when assignment is healthy). */
  srmRate: number;
  /** Mean units (total) at the first sequential rejection, over rejecting runs; NaN if none. */
  meanStopUnits: number;
}

interface Arm {
  n: number;
  sum: number;
  sumSq: number;
}

function stats(arm: Arm) {
  const mean = arm.sum / arm.n;
  const variance = arm.n > 1 ? Math.max(0, (arm.sumSq - arm.n * mean * mean) / (arm.n - 1)) : 0;
  return { n: arm.n, mean, variance };
}

function look(metric: Metric, a: Arm, b: Arm): { diff: number; variance: number } {
  if (metric.kind === 'proportion') {
    const pa = a.sum / a.n;
    const pb = b.sum / b.n;
    return { diff: pb - pa, variance: (pa * (1 - pa)) / a.n + (pb * (1 - pb)) / b.n };
  }
  const sa = stats(a);
  const sb = stats(b);
  return { diff: sb.mean - sa.mean, variance: sa.variance / sa.n + sb.variance / sb.n };
}

export function simulate(cfg: SimConfig): SimReport {
  const alpha = cfg.alpha ?? 0.05;
  const tw = cfg.treatmentWeight ?? BUCKETS / 2;
  const peekEvery = cfg.peekEvery ?? 400;
  const rand = mulberry32(cfg.seed);
  const gauss = gaussian(rand);
  const m = cfg.metric;
  const zCrit = normPpf(1 - alpha / 2);
  let fixed = 0;
  let seq = 0;
  let srm = 0;
  let stopSum = 0;
  let naive = 0;
  for (let run = 0; run < cfg.runs; run++) {
    const salt = `sim-${cfg.seed}-${run}`;
    const a: Arm = { n: 0, sum: 0, sumSq: 0 };
    const b: Arm = { n: 0, sum: 0, sumSq: 0 };
    let state: SequentialResult | undefined;
    let stoppedAt = 0;
    let naiveHit = false;
    for (let i = 1; i <= cfg.unitsPerRun; i++) {
      const treated = bucketOf(salt, `u${i}`) >= BUCKETS - tw;
      const arm = treated ? b : a;
      let y: number;
      if (m.kind === 'proportion') y = rand() < m.baseline + (treated ? m.trueLift : 0) ? 1 : 0;
      else y = m.baseline + (treated ? m.trueLift : 0) + m.sd * gauss();
      arm.n++;
      arm.sum += y;
      arm.sumSq += y * y;
      if (i % peekEvery === 0 && a.n >= MIN_UNITS_PER_ARM && b.n >= MIN_UNITS_PER_ARM) {
        const l = look(m, a, b);
        if (l.variance > 0 && Math.abs(l.diff / Math.sqrt(l.variance)) > zCrit) naiveHit = true;
        if (l.variance > 0 && !state?.reject) {
          state = sequentialStep(l, cfg.tau2, alpha, state);
          if (state.reject) stoppedAt = i;
        }
      }
    }
    const final = m.kind === 'proportion' ? diffProportions({ conversions: a.sum, units: a.n }, { conversions: b.sum, units: b.n }, alpha) : diffMeans(stats(a), stats(b), alpha);
    if (final.p < alpha) fixed++;
    if (naiveHit || final.p < alpha) naive++;
    if (state?.reject) {
      seq++;
      stopSum += stoppedAt;
    }
    if (srmCheck([a.n, b.n], [BUCKETS - tw, tw], SRM_ALPHA).blocked) srm++;
  }
  return { runs: cfg.runs, fixedRejectRate: fixed / cfg.runs, sequentialRejectRate: seq / cfg.runs, naivePeekRejectRate: naive / cfg.runs, srmRate: srm / cfg.runs, meanStopUnits: seq ? stopSum / seq : NaN };
}
