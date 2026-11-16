// Holdout server SDK (PRD "Assignment": "a JS snippet and a server SDK (TypeScript) both use the same function"; D-23).
//
// Loads the running experiments from GET /api/v1/experiments, assigns with the engine's own assign() (imported from
// src/lib/exp/hash.ts, never copied, D-11), queues exposures and conversions, and posts them to POST /api/v1/ingest in
// batches. It runs on a server: the API key it holds must never reach a browser (D-35). No Node-only APIs, so it also runs
// in edge runtimes; `fetch` and `crypto.randomUUID` come from the platform unless passed in.
import { assign, type Variant } from '../lib/exp/hash';

export type ExperimentConfig = { key: string; salt: string; variants: Variant[] };

export type ExposureEvent = { type: 'exposure'; id: string; experiment: string; unitId: string; variant?: string; timestamp?: string };
export type ConversionEvent = { type: 'conversion'; id: string; event: string; unitId: string; value?: number; timestamp?: string };
export type HoldoutEvent = ExposureEvent | ConversionEvent;

export type Rejected = { event: HoldoutEvent; code: string; detail: string };
export type FlushResult = { sent: number; accepted: number; duplicates: number; rejected: Rejected[]; failed: number };

export type HoldoutServerOptions = {
  /** Holdout's origin, e.g. http://localhost:8100 */
  baseUrl: string;
  /** An API key with the `read` scope (config) and the `ingest` scope (events). Server-side only. */
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
  newId?: () => string;
  /** Events per POST; the ingest accepts 1–500 (D-17). */
  maxBatch?: number;
};

export const MAX_BATCH = 500;
/** Exposures remembered per process to avoid re-sending; the server keeps the first one per unit anyway (D-19). */
export const SEEN_LIMIT = 100_000;

export class HoldoutError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HoldoutError';
  }
}

export class HoldoutServer {
  private readonly base: string;
  private readonly key: string;
  private readonly http: typeof fetch;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly batch: number;
  private config = new Map<string, ExperimentConfig>();
  private queue: HoldoutEvent[] = [];
  private seen = new Set<string>();

  constructor(o: HoldoutServerOptions) {
    if (!o.apiKey) throw new HoldoutError('apiKey is required');
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.key = o.apiKey;
    this.http = o.fetch ?? ((...a) => fetch(...a));
    this.now = o.now ?? (() => new Date());
    this.newId = o.newId ?? (() => crypto.randomUUID());
    this.batch = Math.max(1, Math.min(MAX_BATCH, o.maxBatch ?? MAX_BATCH));
  }

  private headers(json = false): Record<string, string> {
    return { authorization: `Bearer ${this.key}`, accept: 'application/json', ...(json && { 'content-type': 'application/json' }) };
  }

  /** Reloads the running experiments (every page). Experiments that stopped disappear, so variant() returns null for them. */
  async refresh(): Promise<ExperimentConfig[]> {
    const next = new Map<string, ExperimentConfig>();
    let cursor: string | null = null;
    for (let pages = 0; pages < 1000; pages++) {
      const url = `${this.base}/api/v1/experiments?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await this.http(url, { headers: this.headers() });
      if (!res.ok) throw new HoldoutError(`GET /api/v1/experiments answered ${res.status}`, res.status);
      const body = (await res.json()) as { data: ExperimentConfig[]; nextCursor: string | null };
      for (const x of body.data) next.set(x.key, { key: x.key, salt: x.salt, variants: x.variants.map((v) => ({ key: v.key, weight: v.weight })) });
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    this.config = next;
    return this.experiments();
  }

  /** Uses a config the caller already has (tests, or a cache), instead of fetching it. */
  load(experiments: readonly ExperimentConfig[]): void {
    this.config = new Map(experiments.map((x) => [x.key, { key: x.key, salt: x.salt, variants: x.variants.map((v) => ({ key: v.key, weight: v.weight })) }]));
  }

  experiments(): ExperimentConfig[] {
    return [...this.config.values()];
  }

  /**
   * The variant `unitId` sees in a running experiment, or null if the experiment is not running (render the default).
   * Queues one exposure per (experiment, unit) per process unless `log` is false (e.g. a page that only peeks).
   */
  variant(experiment: string, unitId: string, opts: { log?: boolean } = {}): string | null {
    const x = this.config.get(experiment);
    if (!x) return null;
    const v = assign(x.salt, unitId, x.variants);
    if (opts.log !== false) {
      const k = `${experiment}\n${unitId}`;
      if (!this.seen.has(k)) {
        if (this.seen.size >= SEEN_LIMIT) this.seen.clear();
        this.seen.add(k);
        this.queue.push({ type: 'exposure', id: this.newId(), experiment, unitId, variant: v, timestamp: this.now().toISOString() });
      }
    }
    return v;
  }

  /** Queues a conversion (a metric or guardrail event) for `unitId`. `value` is for mean metrics (D-29). */
  track(event: string, unitId: string, value?: number): void {
    this.queue.push({ type: 'conversion', id: this.newId(), event, unitId, ...(value !== undefined && { value }), timestamp: this.now().toISOString() });
  }

  /** Queues events built elsewhere (the demo site's relay). Each must already carry its own id. */
  enqueue(events: readonly HoldoutEvent[]): void {
    this.queue.push(...events);
  }

  pending(): number {
    return this.queue.length;
  }

  /**
   * Sends everything queued, in batches. An event the ingest rejected is returned in `rejected` and dropped (resending
   * cannot fix it). A batch that failed in transport or with a 5xx/429 stays queued, with the same ids, for the next flush,
   * so a retry is answered with duplicates, never double counts (D-17).
   */
  async flush(): Promise<FlushResult> {
    const out: FlushResult = { sent: 0, accepted: 0, duplicates: 0, rejected: [], failed: 0 };
    const todo = this.queue;
    this.queue = [];
    const keep: HoldoutEvent[] = [];
    for (let i = 0; i < todo.length; i += this.batch) {
      const chunk = todo.slice(i, i + this.batch);
      let res: Response;
      try {
        res = await this.http(`${this.base}/api/v1/ingest`, { method: 'POST', headers: this.headers(true), body: JSON.stringify({ events: chunk }) });
      } catch {
        keep.push(...chunk);
        out.failed += chunk.length;
        continue;
      }
      if (res.status >= 500 || res.status === 429) {
        keep.push(...chunk);
        out.failed += chunk.length;
        continue;
      }
      if (!res.ok) {
        // 401/403 (key revoked or missing a scope): keep everything, with the same ids, and tell the caller.
        this.queue = [...keep, ...todo.slice(i), ...this.queue];
        throw new HoldoutError(`POST /api/v1/ingest answered ${res.status}`, res.status);
      }
      const body = (await res.json()) as { accepted: number; duplicates: number; rejected: { index: number; code: string; detail: string }[] };
      out.sent += chunk.length;
      out.accepted += body.accepted;
      out.duplicates += body.duplicates;
      for (const r of body.rejected) out.rejected.push({ event: chunk[r.index]!, code: r.code, detail: r.detail });
    }
    this.queue = [...keep, ...this.queue];
    return out;
  }
}
