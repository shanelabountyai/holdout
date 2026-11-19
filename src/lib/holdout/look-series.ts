import { analyze, type Look, type ReadoutDesign } from './readout';

// The readout page's "interval, every day you looked" chart (design artboard Main.dc.html; D-42). Display only: for every
// look it reads the primary comparison of the readout as it stood after that look, by running the unchanged analyze() on
// the looks up to it. Nothing here decides anything; the decision is analyze() on all the looks.

export type SeriesPoint = {
  /** 1-based look number (one look per UTC day, the last one at the readout time; D-28). */
  look: number;
  at: string;
  diff: number;
  /** The always-valid confidence sequence after this look; null is an open end (−∞ / +∞). */
  ciLow: number | null;
  ciHigh: number | null;
  reject: boolean;
};

export type Series = { variant: string; name: string; alpha: number; points: SeriesPoint[] };

/** One series per treatment (variants after control), with a point for every look at which a comparison was reported. */
export function lookSeries(design: ReadoutDesign, looks: Look[]): Series[] {
  const out: Series[] = design.variants.slice(1).map((v) => ({ variant: v.key, name: v.name, alpha: design.alpha / (design.variants.length - 1), points: [] }));
  for (let i = 0; i < looks.length; i++) {
    const r = analyze(design, looks.slice(0, i + 1));
    if (!r.comparisons) continue; // not enough data, or the split was broken at that look: nothing was reported
    r.comparisons.forEach((c, j) => {
      out[j]!.points.push({ look: i + 1, at: looks[i]!.at, diff: c.diff, ciLow: c.sequential.ciLow, ciHigh: c.sequential.ciHigh, reject: c.sequential.reject });
    });
  }
  return out;
}

/** The first look whose whole interval excludes zero, or null. */
export function firstClear(points: SeriesPoint[]): SeriesPoint | null {
  return points.find((p) => (p.ciLow !== null && p.ciLow > 0) || (p.ciHigh !== null && p.ciHigh < 0)) ?? null;
}
