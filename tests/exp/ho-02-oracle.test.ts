// HO-02: the TypeScript engine and the Python oracle (scipy / statsmodels) agree to 1e-9 on every shared vector.
// Vectors: tools/oracle/vectors.json, produced by tools/oracle/oracle.py (CI job `oracle` checks it is fresh).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chi2Sf, diffMeans, diffProportions, gammaQ, lnGamma, normCdf, normPpf, plannedUnitsPerArm, sampleSizeMeans, sampleSizeProportions, sequentialPath, srmCheck, twoSidedP } from '@/lib/exp';

const V = JSON.parse(readFileSync('tools/oracle/vectors.json', 'utf8'));
const TOL = 1e-9;
expect(V.tolerance).toBe(TOL);

function agree(ts: number, py: number, what: string) {
  const err = Math.abs(ts - py);
  const bound = TOL * Math.max(1, Math.abs(py));
  if (!(err <= bound)) throw new Error(`${what}: ts ${ts} vs oracle ${py} (|Δ| ${err.toExponential(2)} > ${bound.toExponential(2)})`);
}

describe('HO-02 oracle agreement (1e-9)', () => {
  it('normal CDF, two-sided p, quantile', () => {
    for (const c of V.normal.cdf) agree(normCdf(c.z), c.v, `cdf(${c.z})`);
    for (const c of V.normal.twoSided) agree(twoSidedP(c.z), c.v, `twoSided(${c.z})`);
    for (const c of V.normal.ppf) agree(normPpf(c.p), c.v, `ppf(${c.p})`);
  });
  it('log-gamma, upper regularized gamma, chi-square survival', () => {
    for (const c of V.gamma.lnGamma) agree(lnGamma(c.x), c.v, `lnGamma(${c.x})`);
    for (const c of V.gamma.gammaQ) agree(gammaQ(c.a, c.x), c.v, `gammaQ(${c.a}, ${c.x})`);
    for (const c of V.gamma.chi2Sf) agree(chi2Sf(c.x, c.df), c.v, `chi2Sf(${c.x}, ${c.df})`);
  });
  it(`difference in proportions (${V.proportions.length} cases; statsmodels proportions_ztest + Wald CI)`, () => {
    for (const [i, c] of V.proportions.entries()) {
      const r = diffProportions(c.input.a, c.input.b, c.input.alpha);
      for (const k of ['diff', 'z', 'p', 'ciLow', 'ciHigh'] as const) agree(r[k], c.output[k], `proportions[${i}].${k}`);
    }
  });
  it(`difference in means (${V.means.length} cases)`, () => {
    for (const [i, c] of V.means.entries()) {
      const r = diffMeans(c.input.a, c.input.b, c.input.alpha);
      if (c.output.notEnoughData) {
        expect(r, `means[${i}]`).toEqual(c.output); // D-15: both sides refuse below MIN_UNITS_PER_ARM
        continue;
      }
      if ('notEnoughData' in r) throw new Error(`means[${i}]: ts says not enough data, oracle has a result`);
      for (const k of ['diff', 'se', 'z', 'p', 'ciLow', 'ciHigh'] as const) agree(r[k], c.output[k], `means[${i}].${k}`);
    }
  });
  it(`SRM chi-square (${V.srm.length} cases; scipy chisquare)`, () => {
    for (const [i, c] of V.srm.entries()) {
      const r = srmCheck(c.input.observed, c.input.weights);
      agree(r.chi2, c.output.chi2, `srm[${i}].chi2`);
      agree(r.p, c.output.p, `srm[${i}].p`);
      expect(r.blocked, `srm[${i}].blocked`).toBe(c.output.blocked);
    }
  });
  it(`sequential mSPRT paths (${V.sequential.length} paths)`, () => {
    for (const [i, c] of V.sequential.entries()) {
      const path = sequentialPath(c.input.looks, c.input.tau2, c.input.alpha);
      for (const [t, o] of c.output.entries()) {
        for (const k of ['logLambda', 'p', 'ciLow', 'ciHigh'] as const) agree(path[t]![k], o[k], `sequential[${i}][${t}].${k}`);
        expect(path[t]!.reject, `sequential[${i}][${t}].reject`).toBe(o.reject);
      }
    }
  });
  it('planned sample size', () => {
    for (const c of V.sampleSize.proportions) agree(sampleSizeProportions(c.baseline, c.mde, c.alpha, c.power), c.v, `n_prop(${c.baseline}, ${c.mde})`);
    for (const c of V.sampleSize.means) agree(sampleSizeMeans(c.sd, c.mde, c.alpha, c.power), c.v, `n_mean(${c.sd}, ${c.mde})`);
  });
  it('planned units per arm: fixed and sequential (2×, D-16) match the oracle exactly', () => {
    const cases = [
      ...V.sampleSize.proportions.map((c: { baseline: number; mde: number; alpha: number; power: number; planned: unknown }) => ({ n: sampleSizeProportions(c.baseline, c.mde, c.alpha, c.power), planned: c.planned })),
      ...V.sampleSize.means.map((c: { sd: number; mde: number; alpha: number; power: number; planned: unknown }) => ({ n: sampleSizeMeans(c.sd, c.mde, c.alpha, c.power), planned: c.planned })),
    ];
    expect(cases.length).toBe(7);
    for (const c of cases) expect({ fixed: plannedUnitsPerArm(c.n, 'fixed'), sequential: plannedUnitsPerArm(c.n, 'sequential') }).toEqual(c.planned);
  });
});
