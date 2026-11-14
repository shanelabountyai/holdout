import { z } from 'zod';
import { inOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { assign } from '@/lib/exp';

// Event ingest (PRD "Events", Phase 2, D-17/D-19/D-26). A batch of exposure and conversion events for the API key's org.
// Each event is accepted, a duplicate (already stored: safe to retry a whole batch), or rejected with a code; one bad
// event never sinks the rest. Exposures are bucketed by the server with assign() over the frozen variant order, so the
// stored variant is always the deterministic one (HO-01); a client that rendered a different variant is told so.

export const MAX_BATCH = 500;
export const FUTURE_SKEW_MS = 5 * 60_000;
export const MAX_AGE_MS = 7 * 24 * 3_600_000;

const id = z.string().min(1).max(100);
const unitId = z.string().min(1).max(200);
const timestamp = z.iso.datetime({ offset: true }).optional();

export const exposureEvent = z.object({ type: z.literal('exposure'), id, experiment: z.string().min(1).max(64), unitId, variant: z.string().min(1).max(64).optional(), timestamp }).strict();
export const conversionEvent = z.object({ type: z.literal('conversion'), id, event: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/), unitId, value: z.number().finite().optional(), timestamp }).strict();
const anyEvent = z.discriminatedUnion('type', [exposureEvent, conversionEvent]);

export const batchBody = z.object({ events: z.array(z.unknown()).min(1).max(MAX_BATCH) }).strict();

export type RejectCode =
  | 'invalid'
  | 'unknown_experiment'
  | 'experiment_not_running'
  | 'before_start'
  | 'variant_mismatch'
  | 'timestamp_in_future'
  | 'timestamp_too_old';
export type Rejection = { index: number; code: RejectCode; detail: string };
export type IngestResult = { accepted: number; duplicates: number; rejected: Rejection[] };

type Exp = z.infer<typeof exposureEvent>;
type Conv = z.infer<typeof conversionEvent>;

export async function ingest(ctx: { orgId: string }, events: unknown[], receivedAt: Date): Promise<IngestResult> {
  const rejected: Rejection[] = [];
  const reject = (index: number, code: RejectCode, detail: string) => rejected.push({ index, code, detail });
  const exposures: { index: number; e: Exp; at: Date }[] = [];
  const conversions: { index: number; e: Conv; at: Date }[] = [];

  events.forEach((raw, index) => {
    const r = anyEvent.safeParse(raw);
    if (!r.success) return reject(index, 'invalid', r.error.issues.map((i) => `${i.path.join('.') || '(event)'}: ${i.message}`).join('; '));
    const at = r.data.timestamp ? new Date(r.data.timestamp) : receivedAt;
    if (at.getTime() > receivedAt.getTime() + FUTURE_SKEW_MS) return reject(index, 'timestamp_in_future', 'timestamp is more than 5 minutes ahead of the server clock.');
    if (at.getTime() < receivedAt.getTime() - MAX_AGE_MS) return reject(index, 'timestamp_too_old', 'timestamp is more than 7 days old.');
    if (r.data.type === 'exposure') exposures.push({ index, e: r.data, at });
    else conversions.push({ index, e: r.data, at });
  });

  let accepted = 0;
  let duplicates = 0;
  await withOrg(ctx, async (tx) => {
    if (exposures.length) {
      const keys = [...new Set(exposures.map((x) => x.e.experiment))];
      // FOR SHARE: a concurrent start cannot change status under this batch (the freeze trigger would refuse it anyway).
      await tx.$queryRaw`SELECT 1 FROM "Experiment" WHERE "orgId" = ${ctx.orgId}::uuid AND "key" = ANY(${keys}::text[]) FOR SHARE`;
      const exps = await tx.experiment.findMany({
        where: { ...inOrg(ctx), key: { in: keys } },
        select: { id: true, key: true, salt: true, status: true, startedAt: true, variants: { orderBy: { position: 'asc' }, select: { id: true, key: true, weight: true } } },
      });
      const byKey = new Map(exps.map((x) => [x.key, x]));
      const rows: { index: number; data: { orgId: string; experimentId: string; variantId: string; unitId: string; eventId: string; occurredAt: Date; receivedAt: Date } }[] = [];
      for (const { index, e, at } of exposures) {
        const x = byKey.get(e.experiment);
        if (!x) {
          reject(index, 'unknown_experiment', `No experiment with key "${e.experiment}" in this org.`);
          continue;
        }
        if (x.status !== 'running') {
          reject(index, 'experiment_not_running', `Experiment "${e.experiment}" is ${x.status}; exposures are accepted only while it runs.`);
          continue;
        }
        if (at < x.startedAt!) {
          reject(index, 'before_start', `timestamp is before experiment "${e.experiment}" started.`);
          continue;
        }
        const key = assign(x.salt, e.unitId, x.variants);
        if (e.variant !== undefined && e.variant !== key) {
          reject(index, 'variant_mismatch', `Unit "${e.unitId}" is assigned to "${key}", not "${e.variant}". Assign with the experiment's salt and frozen variant order (GET /api/v1/experiments).`);
          continue;
        }
        const variantId = x.variants.find((v) => v.key === key)!.id;
        rows.push({ index, data: { orgId: ctx.orgId, experimentId: x.id, variantId, unitId: e.unitId, eventId: e.id, occurredAt: at, receivedAt } });
      }
      if (rows.length) {
        // First exposure wins (D-19): the unique (experimentId, unitId) skips repeats, in this batch or from earlier ones.
        const made = await tx.exposure.createManyAndReturn({ data: rows.map((r) => r.data), skipDuplicates: true, select: { experimentId: true, unitId: true } });
        const fresh = new Set(made.map((m) => `${m.experimentId}\n${m.unitId}`));
        for (const r of rows) {
          const k = `${r.data.experimentId}\n${r.data.unitId}`;
          if (fresh.delete(k)) accepted++;
          else duplicates++;
        }
      }
    }
    if (conversions.length) {
      const made = await tx.conversion.createManyAndReturn({
        data: conversions.map(({ e, at }) => ({ orgId: ctx.orgId, eventId: e.id, event: e.event, unitId: e.unitId, value: e.value ?? null, occurredAt: at, receivedAt })),
        skipDuplicates: true,
        select: { eventId: true },
      });
      const fresh = new Set(made.map((m) => m.eventId));
      for (const { e } of conversions) {
        if (fresh.delete(e.id)) accepted++;
        else duplicates++;
      }
    }
  });
  rejected.sort((a, b) => a.index - b.index);
  return { accepted, duplicates, rejected };
}

/** What a client needs to assign locally with the same function the server uses: running experiments only. */
export const runningConfig = (ctx: { orgId: string }, after: string | null, take: number) =>
  withOrg(
    ctx,
    (tx) =>
      tx.experiment.findMany({
        where: { ...inOrg(ctx), status: 'running', ...(after && { id: { gt: after } }) },
        orderBy: { id: 'asc' },
        take,
        select: { id: true, key: true, salt: true, startedAt: true, variants: { orderBy: { position: 'asc' }, select: { key: true, weight: true } } },
      }),
    { atomic: false },
  );
