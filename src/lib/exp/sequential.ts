// Always-valid inference for continuous monitoring (PRD "sequential testing", D-02, D-10).
//
// Method: mixture sequential probability ratio test (mSPRT) with a normal mixing distribution N(0, τ²) over the
// effect, applied to the difference estimate θ̂ with (plug-in) variance V:
//
//   Λ = √(V / (V + τ²)) · exp( τ² θ̂² / (2 V (V + τ²)) )
//
// Rejecting H0: θ = 0 the first time Λ ≥ 1/α keeps the type I error ≤ α however often the results are checked
// (Ville's inequality on the mixture martingale). The always-valid p-value is the running minimum of min(1, 1/Λ),
// and inverting the same test gives the confidence sequence
//
//   θ̂ ± √( V (V + τ²) / τ² · (2 ln(1/α) + ln((V + τ²) / V)) ).
//
// References:
//   R. Johari, P. Koomen, L. Pekelis, D. Walsh, "Always Valid Inference: Continuous Monitoring of A/B Tests",
//     Operations Research 70(3):1806–1821, 2022 (arXiv:1512.04922) — the mSPRT for two-sample A/B tests, §4.
//   S. R. Howard, A. Ramdas, J. McAuliffe, J. Sekhon, "Time-uniform, nonparametric, nonasymptotic confidence
//     sequences", Annals of Statistics 49(2):1055–1080, 2021 — the normal-mixture boundary used for the
//     confidence sequence below.
//   I. Waudby-Smith, D. Arbour, R. Sinha, E. H. Kennedy, A. Ramdas, "Time-uniform central limit theory and
//     asymptotic confidence sequences", Annals of Statistics, 2024 — why the plug-in variance is valid
//     asymptotically; hence monitoring starts at MIN_UNITS_PER_ARM rather than at the first unit.
//
// τ² = mde² by default (D-10): the mixture puts its mass at effects of the size the experiment was planned to
// detect, so power is spent where it matters.

/** Below this many units in either arm the sequential readout (D-10) and `diffMeans` (D-15) say "not enough data". */
export const MIN_UNITS_PER_ARM = 100;

export interface SequentialLook {
  /** B − A estimate at this look. */
  diff: number;
  /** Variance of `diff` at this look (e.g. pA(1−pA)/nA + pB(1−pB)/nB, or vA/nA + vB/nB). */
  variance: number;
}

export interface SequentialResult {
  logLambda: number;
  /** min(1, 1/Λ) at this look alone. */
  pLook: number;
  /** Running minimum over all looks so far: the always-valid p-value. */
  p: number;
  ciLow: number;
  ciHigh: number;
  /** Λ ≥ 1/α at this or any earlier look. */
  reject: boolean;
}

export function logLambda(diff: number, variance: number, tau2: number): number {
  if (!(variance > 0) || !(tau2 > 0)) throw new RangeError('variance and tau² must be positive');
  return 0.5 * Math.log(variance / (variance + tau2)) + (tau2 * diff * diff) / (2 * variance * (variance + tau2));
}

/** Half-width of the (1 − α) confidence sequence at a look. */
export function csHalfWidth(variance: number, tau2: number, alpha = 0.05): number {
  if (!(variance > 0) || !(tau2 > 0)) throw new RangeError('variance and tau² must be positive');
  return Math.sqrt(((variance * (variance + tau2)) / tau2) * (2 * Math.log(1 / alpha) + Math.log((variance + tau2) / variance)));
}

/** One look, given the running state of the previous ones (p and the running CS intersection). */
export function sequentialStep(look: SequentialLook, tau2: number, alpha = 0.05, prev?: SequentialResult): SequentialResult {
  const ll = logLambda(look.diff, look.variance, tau2);
  const pLook = Math.min(1, Math.exp(-ll));
  const p = prev ? Math.min(prev.p, pLook) : pLook;
  const h = csHalfWidth(look.variance, tau2, alpha);
  // A confidence sequence may be intersected across looks and stays valid; it can only narrow.
  const ciLow = prev ? Math.max(prev.ciLow, look.diff - h) : look.diff - h;
  const ciHigh = prev ? Math.min(prev.ciHigh, look.diff + h) : look.diff + h;
  return { logLambda: ll, pLook, p, ciLow, ciHigh, reject: (prev?.reject ?? false) || ll >= Math.log(1 / alpha) };
}

/** Run every look in order; returns the state after each. */
export function sequentialPath(looks: readonly SequentialLook[], tau2: number, alpha = 0.05): SequentialResult[] {
  const out: SequentialResult[] = [];
  for (const look of looks) out.push(sequentialStep(look, tau2, alpha, out.at(-1)));
  return out;
}
