import { Prisma } from '@/generated/prisma/client';
import type { Tx } from '@/core/db/rls';
import { analyze, type ArmAgg, type Kind, type Look, type Readout, type ReadoutDesign } from './readout';

// Builds the readout's looks from Exposure and Conversion, as of a moment (D-28, D-29).
//
// Looks: one at the end of every UTC day since the start, and one at `asOf`. A look contains what the server had
// *received* by then (receivedAt), so a past look never changes when late events arrive: the sequential test sees the same
// path a person watching the page would have seen. A conversion counts for a unit when it occurred at or after the unit's
// first exposure (occurredAt). Proportion: the unit converted at least once. Mean: the sum of `value` over its events
// (an event without a value adds 0); a unit with no event is 0.

const DAY = 86_400_000;

export type ExperimentForReadout = {
  id: string;
  orgId: string;
  startedAt: Date;
  metricEvent: string;
  metricKind: Kind;
  mde: number;
  alpha: number;
  plannedUnitsPerArm: number;
  variants: { id: string; key: string; name: string; weight: number; position: number }[];
  guardrails: { event: string; kind: Kind; position: number }[];
};

export async function computeReadout(tx: Tx, x: ExperimentForReadout, asOf: Date): Promise<Readout> {
  const { design, looks } = await computeLooks(tx, x, asOf);
  return analyze(design, looks);
}

/** The design and the looks computeReadout analyses; split out so the readout page can chart every look (D-42). */
export async function computeLooks(tx: Tx, x: ExperimentForReadout, asOf: Date): Promise<{ design: ReadoutDesign; looks: Look[] }> {
  const variants = [...x.variants].sort((a, b) => a.position - b.position);
  const guardrails = [...x.guardrails].sort((a, b) => a.position - b.position);
  const day0 = new Date(Math.floor(x.startedAt.getTime() / DAY) * DAY);
  const last = Math.max(0, Math.floor((asOf.getTime() - day0.getTime()) / DAY));
  const nLooks = last + 1;
  const kinds = new Map<string, Kind>([[x.metricEvent, x.metricKind], ...guardrails.map((g) => [g.event, g.kind] as const)]);
  const events = [...kinds.keys()];
  const pos = new Map(variants.map((v, i) => [v.id, i]));
  const dayOf = (col: Prisma.Sql) => Prisma.sql`GREATEST(0, LEAST(${last}::int, FLOOR(EXTRACT(EPOCH FROM (${col} - ${day0}::timestamptz)) / 86400)::int))`;

  const exposures = await tx.$queryRaw<{ variantId: string; d: number; n: bigint }[]>`
    SELECT e."variantId", ${dayOf(Prisma.sql`e."receivedAt"`)} AS d, COUNT(*) AS n
    FROM "Exposure" e
    WHERE e."experimentId" = ${x.id}::uuid AND e."orgId" = ${x.orgId}::uuid AND e."receivedAt" <= ${asOf}
    GROUP BY 1, 2`;
  const rows = await tx.$queryRaw<{ variantId: string; xid: string; event: string; d: number; s: number }[]>`
    SELECT e."variantId", e."id"::text AS xid, c."event", GREATEST(${dayOf(Prisma.sql`e."receivedAt"`)}, ${dayOf(Prisma.sql`c."receivedAt"`)}) AS d,
           SUM(COALESCE(c."value", 0))::float8 AS s
    FROM "Exposure" e
    JOIN "Conversion" c ON c."orgId" = e."orgId" AND c."unitId" = e."unitId" AND c."event" = ANY(${events}::text[])
      AND c."occurredAt" >= e."occurredAt" AND c."receivedAt" <= ${asOf}
    WHERE e."experimentId" = ${x.id}::uuid AND e."orgId" = ${x.orgId}::uuid AND e."receivedAt" <= ${asOf}
    GROUP BY 1, 2, 3, 4
    ORDER BY 2, 3, 4`;

  // Per-day increments, then prefix sums: unitsDelta[arm][day], sumDelta/sqDelta[arm][event][day].
  const zeros = () => new Float64Array(nLooks);
  const add = (a: Float64Array, i: number, v: number) => void (a[i] = a[i]! + v);
  const unitsDelta = variants.map(zeros);
  const sumDelta = variants.map(() => new Map(events.map((e) => [e, zeros()])));
  const sqDelta = variants.map(() => new Map(events.map((e) => [e, zeros()])));
  for (const r of exposures) add(unitsDelta[pos.get(r.variantId)!]!, r.d, Number(r.n));

  // rows arrive grouped by (exposure, event) in day order; walk each group once.
  let key = '';
  let y = 0;
  let converted = false;
  for (const r of rows) {
    const k = `${r.xid}|${r.event}`;
    if (k !== key) {
      key = k;
      y = 0;
      converted = false;
    }
    const arm = pos.get(r.variantId)!;
    const sd = sumDelta[arm]!.get(r.event)!;
    const qd = sqDelta[arm]!.get(r.event)!;
    if (kinds.get(r.event) === 'proportion') {
      if (!converted) {
        converted = true;
        add(sd, r.d, 1);
        add(qd, r.d, 1);
      }
    } else {
      const next = y + Number(r.s);
      add(sd, r.d, next - y);
      add(qd, r.d, next * next - y * y);
      y = next;
    }
  }

  const looks: Look[] = [];
  const run = variants.map(() => ({ units: 0, sums: new Map(events.map((e) => [e, { sum: 0, sumSq: 0 }])) }));
  for (let d = 0; d < nLooks; d++) {
    const arms: ArmAgg[] = run.map((acc, i) => {
      acc.units += unitsDelta[i]![d]!;
      const metrics: ArmAgg['metrics'] = {};
      for (const e of events) {
        const m = acc.sums.get(e)!;
        m.sum += sumDelta[i]!.get(e)![d]!;
        m.sumSq += sqDelta[i]!.get(e)![d]!;
        metrics[e] = { sum: m.sum, sumSq: m.sumSq };
      }
      return { units: acc.units, metrics };
    });
    const end = Math.min(day0.getTime() + (d + 1) * DAY, asOf.getTime());
    looks.push({ at: new Date(end).toISOString(), arms });
  }

  return {
    design: {
      metricEvent: x.metricEvent,
      metricKind: x.metricKind,
      mde: x.mde,
      alpha: x.alpha,
      plannedUnitsPerArm: x.plannedUnitsPerArm,
      variants: variants.map((v) => ({ key: v.key, name: v.name, weight: v.weight })),
      guardrails: guardrails.map((g) => ({ event: g.event, kind: g.kind })),
    },
    looks,
  };
}
