// Distribution functions for the analysis engine, written out so the engine has no dependencies and agrees with
// scipy to 1e-9 (HO-02). Accuracy targets: ~1e-15 absolute for the normal CDF, ~1e-14 for the gamma family.

const SQRT2 = Math.SQRT2;
const SQRT_PI = Math.sqrt(Math.PI);
const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** erfc for x >= 0. Series (all terms positive, no cancellation) below 2.5, Lentz continued fraction above. */
function erfcPos(x: number): number {
  if (x < 2.5) {
    // erf(x) = 2/√π · e^{-x²} · Σ 2^n x^{2n+1} / (1·3·…·(2n+1))
    let term = x;
    let sum = x;
    for (let n = 1; n < 500; n++) {
      term *= (2 * x * x) / (2 * n + 1);
      sum += term;
      if (term < sum * 1e-17) break;
    }
    return 1 - ((2 / SQRT_PI) * Math.exp(-x * x) * sum);
  }
  // erfc(x) = e^{-x²}/√π · 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + …)))), modified Lentz.
  const tiny = 1e-300;
  let f = x;
  let C = x;
  let D = 0;
  for (let n = 1; n < 10_000; n++) {
    const a = n / 2;
    D = x + a * D;
    D = D === 0 ? tiny : D;
    C = x + a / C;
    C = C === 0 ? tiny : C;
    D = 1 / D;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x * x) / (SQRT_PI * f);
}

export function erfc(x: number): number {
  return x >= 0 ? erfcPos(x) : 2 - erfcPos(-x);
}

/** Standard normal CDF Φ(z). */
export function normCdf(z: number): number {
  return z < 0 ? 0.5 * erfcPos(-z / SQRT2) : 1 - 0.5 * erfcPos(z / SQRT2);
}

/** Standard normal survival 1 − Φ(z), accurate in the upper tail. */
export function normSf(z: number): number {
  return normCdf(-z);
}

export function normPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / SQRT_2PI;
}

/** Two-sided p-value for a z statistic: 2·(1 − Φ(|z|)) = erfc(|z|/√2). */
export function twoSidedP(z: number): number {
  return erfcPos(Math.abs(z) / SQRT2);
}

/** Standard normal quantile Φ⁻¹(p): Acklam's rational start, then Halley steps against normCdf. */
export function normPpf(p: number): number {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    throw new RangeError(`normPpf: p must be in [0, 1], got ${p}`);
  }
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  let x: number;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= 1 - lo) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  for (let i = 0; i < 3; i++) {
    // Work in the smaller tail so the residual keeps its relative precision.
    const e = p < 0.5 ? normCdf(x) - p : -(normSf(x) - (1 - p));
    const u = e * SQRT_2PI * Math.exp(0.5 * x * x);
    x -= u / (1 + (x * u) / 2);
  }
  return x;
}

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  const z = x - 1;
  let s = LANCZOS[0]!;
  for (let i = 1; i < 9; i++) s += LANCZOS[i]! / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(s);
}

/** Regularized upper incomplete gamma Q(a, x) = Γ(a, x) / Γ(a). */
export function gammaQ(a: number, x: number): number {
  if (x < 0 || a <= 0) throw new RangeError('gammaQ: need a > 0, x >= 0');
  if (x === 0) return 1;
  const lnPre = -x + a * Math.log(x) - lnGamma(a);
  if (x < a + 1) {
    let ap = a;
    let del = 1 / a;
    let sum = del;
    for (let n = 0; n < 10_000; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-17) break;
    }
    return 1 - sum * Math.exp(lnPre);
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 10_000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.exp(lnPre) * h;
}

/** Chi-square survival function P(X ≥ x), X ~ χ²(df). */
export function chi2Sf(x: number, df: number): number {
  if (df === 1) return erfc(Math.sqrt(Math.max(x, 0) / 2));
  return gammaQ(df / 2, Math.max(x, 0) / 2);
}
