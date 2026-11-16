// Holdout JS snippet (PRD "Assignment": the browser half of "a JS snippet and a server SDK (TypeScript) both use the same
// function"). Bundled by `npm run sdk:build` into sdk/holdout.js, an IIFE that defines `window.Holdout`.
//
// It never holds an API key (D-35). The page's server gives it the running experiments (from the server SDK) and a unit
// id, and it sends events to a first-party endpoint on the same site (the demo site's /collect), which relays them to
// Holdout's ingest with the server-side key. assign() is the engine's own function compiled in, not a copy (D-11).
import { assign, type Variant } from '../lib/exp/hash';

export type SnippetExperiment = { key: string; salt: string; variants: Variant[] };
export type SnippetConfig = {
  experiments: SnippetExperiment[];
  unitId: string;
  /** Same-site URL that accepts { events: [...] } (the demo site's /collect). */
  endpoint: string;
  /** Debounce before a batch is sent, in ms. 0 sends on the next tick. */
  flushMs?: number;
};

type Ev = Record<string, unknown> & { type: 'exposure' | 'conversion'; id: string };

export const MAX_BATCH = 500;
export const VERSION = '1';

let cfg: SnippetConfig | null = null;
let byKey = new Map<string, SnippetExperiment>();
let queue: Ev[] = [];
let logged = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function schedule(): void {
  if (!cfg || timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, cfg.flushMs ?? 1000);
}

/** Starts the snippet with the experiments and unit id the page's server rendered. Calling it again resets state. */
export function init(c: SnippetConfig): void {
  if (!c || !Array.isArray(c.experiments) || typeof c.unitId !== 'string' || !c.unitId || typeof c.endpoint !== 'string') {
    throw new Error('Holdout.init: { experiments, unitId, endpoint } are required');
  }
  cfg = c;
  byKey = new Map(c.experiments.map((x) => [x.key, x]));
  queue = [];
  logged = new Set();
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const w = globalThis as { addEventListener?: (t: string, f: () => void) => void; document?: { visibilityState?: string } };
  if (typeof w.addEventListener === 'function') {
    // A page being left: send what is queued (fetch keepalive outlives the page).
    w.addEventListener('pagehide', () => void flush());
    w.addEventListener('visibilitychange', () => {
      if (w.document?.visibilityState === 'hidden') void flush();
    });
  }
}

/** The variant this page's unit sees, or null when the experiment is not running. Logs one exposure per experiment per page. */
export function variant(experiment: string): string | null {
  if (!cfg) throw new Error('Holdout.variant: call Holdout.init first');
  const x = byKey.get(experiment);
  if (!x) return null;
  const v = assign(x.salt, cfg.unitId, x.variants);
  if (!logged.has(experiment)) {
    logged.add(experiment);
    queue.push({ type: 'exposure', id: newId(), experiment, unitId: cfg.unitId, variant: v, timestamp: new Date().toISOString() });
    schedule();
  }
  return v;
}

/** Records a metric or guardrail event for this page's unit. `value` is for mean metrics. */
export function track(event: string, value?: number): void {
  if (!cfg) throw new Error('Holdout.track: call Holdout.init first');
  const e: Ev = { type: 'conversion', id: newId(), event, unitId: cfg.unitId, timestamp: new Date().toISOString() };
  if (typeof value === 'number' && Number.isFinite(value)) e.value = value;
  queue.push(e);
  schedule();
}

/** Sends the queue now. Events that could not be sent stay queued with the same ids (the server deduplicates retries). */
export async function flush(): Promise<void> {
  if (!cfg || queue.length === 0) return;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const batch = queue.slice(0, MAX_BATCH);
  queue = queue.slice(MAX_BATCH);
  let ok = false;
  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
      credentials: 'same-origin',
    });
    ok = res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429);
  } catch {
    ok = false;
  }
  if (!ok) queue = batch.concat(queue);
  if (queue.length && ok) await flush();
}

/** Events waiting to be sent (for tests and debugging). */
export function pending(): number {
  return queue.length;
}

export { assign };
