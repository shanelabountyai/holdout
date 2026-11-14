// HO-03: simulated A/A tests at α 0.05 reject ≤ 6% over 2 000 runs, fixed-horizon and sequential (under continuous
// peeking) alike. The same harness measures power at the planned sample size and prints both for the PR body.
import { describe, expect, it } from 'vitest';
import { sampleSizeMeans, sampleSizeProportions, simulate, type Metric, type SimReport } from '@/lib/exp';

const RUNS = 2000;
const SEED = 28;
const PEEK_EVERY = 400; // a look every ~200 units per arm

const PROP = { baseline: 0.1, mde: 0.02 };
const MEAN = { baseline: 10, sd: 5, mde: 0.5 };
const nProp = Math.ceil(sampleSizeProportions(PROP.baseline, PROP.mde)); // per arm
const nMean = Math.ceil(sampleSizeMeans(MEAN.sd, MEAN.mde));

function run(metric: Metric, perArm: number, tau2: number): SimReport {
  return simulate({ metric, unitsPerRun: 2 * perArm, runs: RUNS, seed: SEED, peekEvery: PEEK_EVERY, tau2 });
}

const pct = (x: number) => `${(100 * x).toFixed(2)}%`;
function report(label: string, r: SimReport) {
  console.log(`[HO-03] ${label}: fixed ${pct(r.fixedRejectRate)} · sequential ${pct(r.sequentialRejectRate)} · naive peeking ${pct(r.naivePeekRejectRate)} · SRM flags ${pct(r.srmRate)} · mean stop ${Number.isNaN(r.meanStopUnits) ? '—' : Math.round(r.meanStopUnits)} units (${RUNS} runs)`);
}

describe('HO-03 false-positive rate and power by simulation', () => {
  it(`A/A, conversion ${PROP.baseline}, ${nProp}/arm: both methods reject ≤ 6%`, () => {
    const r = run({ kind: 'proportion', baseline: PROP.baseline, trueLift: 0 }, nProp, PROP.mde ** 2);
    report('A/A proportion', r);
    expect(r.fixedRejectRate).toBeLessThanOrEqual(0.06);
    expect(r.sequentialRejectRate).toBeLessThanOrEqual(0.06);
    expect(r.naivePeekRejectRate).toBeGreaterThan(0.1); // the problem the sequential method exists to solve
    expect(r.srmRate).toBeLessThanOrEqual(0.005);
  }, 120_000);

  it(`A/A, mean ${MEAN.baseline} ± ${MEAN.sd}, ${nMean}/arm: both methods reject ≤ 6%`, () => {
    const r = run({ kind: 'mean', baseline: MEAN.baseline, sd: MEAN.sd, trueLift: 0 }, nMean, MEAN.mde ** 2);
    report('A/A mean', r);
    expect(r.fixedRejectRate).toBeLessThanOrEqual(0.06);
    expect(r.sequentialRejectRate).toBeLessThanOrEqual(0.06);
    expect(r.naivePeekRejectRate).toBeGreaterThan(0.1);
    expect(r.srmRate).toBeLessThanOrEqual(0.005);
  }, 120_000);

  it('A/B at the MDE: fixed-horizon power ≈ the planned 0.8; sequential power reported', () => {
    const p = run({ kind: 'proportion', baseline: PROP.baseline, trueLift: PROP.mde }, nProp, PROP.mde ** 2);
    const m = run({ kind: 'mean', baseline: MEAN.baseline, sd: MEAN.sd, trueLift: MEAN.mde }, nMean, MEAN.mde ** 2);
    report('A/B proportion (lift = MDE)', p);
    report('A/B mean (lift = MDE)', m);
    for (const r of [p, m]) {
      expect(r.fixedRejectRate).toBeGreaterThan(0.76);
      expect(r.fixedRejectRate).toBeLessThan(0.84);
      expect(r.sequentialRejectRate).toBeGreaterThan(0.3);
    }
  }, 240_000);
});
