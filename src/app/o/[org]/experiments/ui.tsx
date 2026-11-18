import type { DecisionState, Kind } from '@/lib/holdout/readout';

// Display helpers shared by the experiment pages (design artboards in docs/design/). Every status is a word, a glyph and a
// tone (States.dc.html); the glyph is decoration (aria-hidden), so the word carries the meaning alone.

export type Tone = 'good' | 'hold' | 'stop' | 'neutral';

/** D-32's states in the artboard's look. Headlines and details come from the readout itself (stored with a stop, HO-05). */
export const STATE: Record<DecisionState | 'draft', { tone: Tone; glyph: string }> = {
  srm: { tone: 'stop', glyph: '✕' },
  not_enough_data: { tone: 'neutral', glyph: '○' },
  ship: { tone: 'good', glyph: '✓' },
  guardrail: { tone: 'hold', glyph: '◐' },
  srm_unchecked: { tone: 'hold', glyph: '◐' },
  worse: { tone: 'stop', glyph: '✕' },
  inconclusive: { tone: 'neutral', glyph: '–' },
  no_effect: { tone: 'neutral', glyph: '–' },
  keep_running: { tone: 'neutral', glyph: '●' },
  draft: { tone: 'neutral', glyph: '–' },
};

export function Glyph({ g }: { g: string }) {
  return <span aria-hidden="true">{g} </span>;
}

/** Word + glyph + colour, for statuses inside cards. */
export function Status({ tone, glyph, children }: { tone: Tone; glyph: string; children: React.ReactNode }) {
  return (
    <span className={`ho-st ho-st-${tone}`}>
      <Glyph g={glyph} />
      {children}
    </span>
  );
}

export const n = (x: number) => x.toLocaleString('en-US');
export const pctBps = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
export const p4 = (x: number) => (x < 0.0001 ? '< 0.0001' : x.toFixed(4));
const sign = (x: number) => (x >= 0 ? '+' : '−');

/** A metric level: a rate (1 decimal, the artboard's) or a mean. */
export const level = (kind: Kind, x: number | null, digits = 1) =>
  x === null ? '—' : kind === 'proportion' ? `${(x * 100).toFixed(digits)}%` : Number(x.toPrecision(6)).toString();

/** An effect on the metric's own scale: percentage points for a rate. `open` is shown for an open interval end. */
export const effect = (kind: Kind, x: number | null, open = '—', digits = 1) =>
  x === null ? open : kind === 'proportion' ? `${sign(x)}${Math.abs(x * 100).toFixed(digits)} pts` : `${sign(x)}${Number(Math.abs(x).toPrecision(4))}`;

export const interval = (kind: Kind, lo: number | null, hi: number | null, digits = 1) =>
  `${effect(kind, lo, '−∞', digits)} to ${effect(kind, hi, '+∞', digits)}`;

export const utc = (d: Date | string) => `${(typeof d === 'string' ? d : d.toISOString()).slice(0, 16).replace('T', ' ')} UTC`;

const DAY = 86_400_000;
/** "Running for 3 days", "Started today", "Stopped after 14 days", "Draft". */
export function runLabel(status: string, startedAt: Date | null, stoppedAt: Date | null, nowMs: number) {
  if (status === 'draft' || !startedAt) return 'Draft';
  const end = status === 'stopped' && stoppedAt ? stoppedAt.getTime() : nowMs;
  const days = Math.floor((end - startedAt.getTime()) / DAY);
  const d = `${days} ${days === 1 ? 'day' : 'days'}`;
  if (status === 'stopped') return days < 1 ? 'Stopped the day it started' : `Stopped after ${d}`;
  return days < 1 ? 'Running · started today' : `Running for ${d}`;
}

export const ACTIONS: Record<string, string> = {
  'experiment.created': 'Created',
  'experiment.updated': 'Draft edited',
  'experiment.renamed': 'Renamed',
  'experiment.deleted': 'Deleted',
  'experiment.started': 'Started',
  'experiment.stopped': 'Stopped',
};
