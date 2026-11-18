import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { firstClear, lookSeries } from '@/lib/holdout/look-series';
import { planFor as planForServer } from '@/lib/holdout/experiments';
import { planFor } from '@/lib/holdout/plan';
import { toDesign } from '@/lib/holdout/form';
import { analyze, type ArmAgg, type DecisionState, type Look, type ReadoutDesign } from '@/lib/holdout/readout';
import { DecisionBanner, ReadoutView, SrmView } from '@/app/o/[org]/experiments/readout-view';
import { STATE } from '@/app/o/[org]/experiments/ui';

// Design pass (D-42..D-46): the display layer reads the engine and never decides. The chart's series is the unchanged
// analyze() after each look; the live plan is the server's planFor; every decision state has a word, a glyph and a tone;
// under SRM no rate, effect or interval reaches the page (HO-04, D-33).

const design = (over: Partial<ReadoutDesign> = {}): ReadoutDesign => ({
  metricEvent: 'purchase',
  metricKind: 'proportion',
  mde: 0.02,
  alpha: 0.05,
  plannedUnitsPerArm: 7682,
  variants: [
    { key: 'control', name: 'Control', weight: 5000 },
    { key: 'treatment', name: 'Treatment', weight: 5000 },
  ],
  guardrails: [{ event: 'refund', kind: 'proportion' }],
  ...over,
});
const arm = (n: number, c: number, r = 0): ArmAgg => ({ units: n, metrics: { purchase: { sum: c, sumSq: c }, refund: { sum: r, sumSq: r } } });
/** Cumulative daily looks of a 10% → 13% test, 600 units per arm a day. */
const looks = (days: number, a = 0.1, b = 0.13): Look[] =>
  Array.from({ length: days }, (_, d) => {
    const n = 600 * (d + 1);
    return { at: `2026-11-${String(d + 2).padStart(2, '0')}T00:00:00.000Z`, arms: [arm(n, Math.round(n * a), Math.round(n * 0.02)), arm(n, Math.round(n * b), Math.round(n * 0.02))] };
  });

describe('look series (the daily-looks chart)', () => {
  it('is analyze() after each look, and its last point is the readout itself', () => {
    const ls = looks(10);
    const [s] = lookSeries(design(), ls);
    expect(s!.points).toHaveLength(10);
    for (const p of s!.points) {
      const c = analyze(design(), ls.slice(0, p.look)).comparisons![0]!;
      expect([p.diff, p.ciLow, p.ciHigh, p.reject]).toEqual([c.diff, c.sequential.ciLow, c.sequential.ciHigh, c.sequential.reject]);
    }
    const r = analyze(design(), ls).comparisons![0]!;
    expect(s!.points.at(-1)!.ciLow).toBe(r.sequential.ciLow);
    expect(firstClear(s!.points)?.look).toBe(s!.points.find((p) => p.ciLow !== null && p.ciLow > 0)?.look);
  });

  it('skips looks with fewer than 100 units in an arm (nothing was reported then)', () => {
    const ls: Look[] = [{ at: '2026-11-02T00:00:00.000Z', arms: [arm(50, 5), arm(50, 6)] }, ...looks(3)];
    const [s] = lookSeries(design(), ls);
    expect(s!.points.map((p) => p.look)).toEqual([2, 3, 4]);
  });

  it('has one series per treatment, each at the Bonferroni α', () => {
    const d = design({ variants: [{ key: 'a', name: 'A', weight: 3400 }, { key: 'b', name: 'B', weight: 3300 }, { key: 'c', name: 'C', weight: 3300 }] });
    const ls = looks(2).map((l) => ({ ...l, arms: [...l.arms, l.arms[1]!] }));
    const ss = lookSeries(d, ls);
    expect(ss.map((s) => [s.variant, s.alpha])).toEqual([['b', 0.025], ['c', 0.025]]);
  });
});

describe('live planned sample (New.dc.html)', () => {
  it('runs the same planFor the server stores, on the same form conversion', () => {
    expect(planFor).toBe(planForServer);
    const d = toDesign({ key: '', name: '', description: '', metricEvent: '', metricKind: 'proportion', baseline: '10', sd: '', mde: '2', variantKeys: ['control', 'treatment'], variantNames: ['', ''], variantWeights: ['50', '50'], guardrailEvents: [], guardrailKinds: [] });
    expect(planFor(d)).toEqual({ fixedUnitsPerArm: 3841, plannedUnitsPerArm: 7682, plannedTotalUnits: 15364 }); // README, D-16, D-20
  });
});

describe('decision banner and readout markup', () => {
  const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

  it('gives every decision state a glyph and a tone, and the glyph is hidden from assistive tech', () => {
    const states: DecisionState[] = ['srm', 'not_enough_data', 'ship', 'srm_unchecked', 'guardrail', 'worse', 'inconclusive', 'no_effect', 'keep_running'];
    for (const s of states) {
      expect(STATE[s].glyph).not.toBe('');
      expect(['good', 'hold', 'stop', 'neutral']).toContain(STATE[s].tone);
    }
    const r = analyze(design(), looks(14));
    const out = html(createElement(DecisionBanner, { r, stored: false }));
    expect(out).toContain(`<span aria-hidden="true">${STATE[r.decision.state].glyph} </span>`);
    expect(out).toContain(`data-decision="${r.decision.state}">${r.decision.headline}</span>`);
  });

  it('shows no rate, effect or interval under SRM, only the units (HO-04, D-33)', () => {
    const ls = looks(14).map((l) => ({ ...l, arms: [l.arms[0]!, { ...l.arms[1]!, units: Math.round(l.arms[1]!.units * 0.85) }] }));
    const r = analyze(design(), ls);
    expect(r.decision.state).toBe('srm');
    const out = html(createElement(SrmView, { r }));
    expect(out).toContain('What we can still show');
    expect(out).toContain('Hidden while the split is broken');
    expect(out).not.toMatch(/pts|%<\/td>/);
  });

  it('keeps the D-40 reference label and the D-41 "not yet checkable" wording', () => {
    const early = analyze(design(), looks(3));
    expect(early.srm.checkable).toBe(false);
    const out = html(createElement(ReadoutView, { r: early, series: lookSeries(design(), looks(3)), guardrailEvents: ['refund'] }));
    expect(out).toContain(`SRM not yet checkable: ${(3600).toLocaleString('en-US')} of 9,835 units`);
    expect(out).toContain('Fixed-horizon p (reference only, not a decision)');
    expect(out).toContain('role="img"');
  });
});
