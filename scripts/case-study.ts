import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { advanceClock, now } from '@/core/clock';
import type { OrgCtx } from '@/core/authz/guards';
import { db } from '@/core/db'; // the app client: refuses a cloud database (INV-18, INV-27); org rows only through withOrg (INV-32)
import { withOrg } from '@/core/db/rls';
import { mulberry32 } from '@/lib/exp';
import { createExperiment, getReadout, startExperiment, stopExperiment } from '@/lib/holdout/experiments';
import type { DecisionState } from '@/lib/holdout/readout';
import { createKey } from '@/modules/apikeys/keys';
import * as configRoute from '@/app/api/v1/experiments/route';
import * as ingestRoute from '@/app/api/v1/ingest/route';
import { HoldoutServer } from '../src/sdk/server';

// Holdout Phase 4 case study (README "Case study"). `npm run case-study` (test database) writes
// docs/holdout/case-study.json and prints the tables the README quotes; tests/sdk/case-study.test.ts reruns it and requires
// the same JSON, so the README's numbers are reproducible output, not prose.
//
// Three experiments on the demo shop's buy button, 14 simulated days each, 1 200 visitors a day, in a fresh org:
//   real-effect   purchase 10% → 12% (the PRD's MDE), refunds 2% in both arms; stopped on the first "ship"
//   a-a           purchase 10% in both arms; runs all 14 days
//   broken-client purchase 10% → 12%, but 8% of treatment visitors' exposures never arrive (a client bug)
// Visitors are assigned by the server SDK's variant() (the same function as the snippet) and every event goes through
// the real POST /api/v1/ingest route with a real API key; config comes from GET /api/v1/experiments. The clock is moved
// day by day (the experiments start 15 days ago), and at the end of each day the real readout (getReadout) is read.
// Salts and traffic are seeded, so every run gives the same numbers.

const DAY = 86_400_000;
export const DAYS = 14;
export const VISITORS_PER_DAY = 1200;

export type Scenario = { key: string; label: string; rates: [number, number]; refunds: [number, number]; dropTreatmentExposures: number; stopOnShip: boolean; seed: number };

export const SCENARIOS: Scenario[] = [
  { key: 'real-effect', label: 'Real effect: 10% → 12%', rates: [0.1, 0.12], refunds: [0.02, 0.02], dropTreatmentExposures: 0, stopOnShip: true, seed: 2801 },
  { key: 'a-a', label: 'A/A: 10% in both arms', rates: [0.1, 0.1], refunds: [0.02, 0.02], dropTreatmentExposures: 0, stopOnShip: false, seed: 2802 },
  { key: 'broken-client', label: 'Broken client: 8% of treatment exposures lost', rates: [0.1, 0.12], refunds: [0.02, 0.02], dropTreatmentExposures: 0.08, stopOnShip: false, seed: 2803 },
];

export type DayRow = {
  day: number;
  units: number[];
  rates: (number | null)[];
  diff: number | null;
  seqP: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  fixedP: number | null;
  srmP: number;
  state: DecisionState;
  headline: string;
};
export type ScenarioResult = {
  key: string;
  label: string;
  plannedUnitsPerArm: number;
  sent: { exposures: number; conversions: number; accepted: number; duplicates: number; rejected: number };
  days: DayRow[];
  firstDecisive: { day: number; state: DecisionState } | null;
  stopped: { day: number; recordedState: DecisionState; auditEvents: number } | null;
};

const r6 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6);

async function freshOrg(slug: string): Promise<OrgCtx> {
  const org = await db.org.create({ data: { slug, name: 'Northwind Roasters (case study)' } });
  const t = now();
  const user = await db.user.create({ data: { email: `owner@${slug}.test`, totpEnrolledAt: t } });
  await withOrg({ orgId: org.id }, (tx) => tx.membership.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } }));
  return { userId: user.id, orgId: org.id, slug, role: 'owner', session: { hash: 'case-study', userId: user.id, email: user.email, authAt: t, mfaAt: t, mfaOrgId: null } as OrgCtx['session'] };
}

/** fetch that dispatches to Holdout's route handlers in-process. */
const inProcess = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const req = new Request(String(input), init);
  const path = new URL(req.url).pathname;
  if (req.method === 'GET' && path === '/api/v1/experiments') return configRoute.GET(req, { params: Promise.resolve({}) });
  if (req.method === 'POST' && path === '/api/v1/ingest') return ingestRoute.POST(req);
  return new Response('not found', { status: 404 });
}) as typeof fetch;

const setClock = (t: number) => advanceClock(t - Date.now());

export async function runCaseStudy(opts: { slug?: string; days?: number; visitorsPerDay?: number; scenarios?: Scenario[] } = {}): Promise<{ days: number; visitorsPerDay: number; results: ScenarioResult[] }> {
  const days = opts.days ?? DAYS;
  const perDay = opts.visitorsPerDay ?? VISITORS_PER_DAY;
  const day0 = Math.floor((Date.now() - (days + 1) * DAY) / DAY) * DAY; // UTC midnight, days + 1 days ago
  const results: ScenarioResult[] = [];
  try {
    setClock(day0 + 3_600_000); // 01:00 on day 0
    const ctx = await freshOrg(opts.slug ?? `case-study-${Date.now().toString(36)}`);
    const apiKey = await createKey(ctx, { label: 'case study', scopes: ['read', 'ingest'] });
    const ids: Record<string, string> = {};
    for (const s of opts.scenarios ?? SCENARIOS) {
      const id = await createExperiment(ctx, {
        key: s.key,
        name: s.label,
        description: 'Phase 4 case study (scripts/case-study.ts)',
        metricEvent: 'purchase',
        metricKind: 'proportion',
        baselineRate: 0.1,
        mde: 0.02,
        variants: [
          { key: 'control', name: 'Add to cart', weight: 5000 },
          { key: 'treatment', name: 'Buy now: free shipping', weight: 5000 },
        ],
        guardrails: [{ event: 'refund', kind: 'proportion' }],
      });
      // A fixed salt (allowed while draft, D-18) so every run assigns the same visitors the same way.
      await withOrg(ctx, (tx) => tx.experiment.update({ where: { id }, data: { salt: `case-study-${s.key}-${s.seed}` } }));
      await startExperiment(ctx, id);
      ids[s.key] = id;
    }

    for (const s of opts.scenarios ?? SCENARIOS) {
      const id = ids[s.key]!;
      // One event namespace per scenario: conversions are per org, and each experiment has its own visitors.
      const sdk = new HoldoutServer({ baseUrl: 'http://holdout.internal', apiKey, fetch: inProcess, now });
      setClock(day0 + 2 * 3_600_000);
      await sdk.refresh();
      const rand = mulberry32(s.seed);
      const res: ScenarioResult = { key: s.key, label: s.label, plannedUnitsPerArm: 0, sent: { exposures: 0, conversions: 0, accepted: 0, duplicates: 0, rejected: 0 }, days: [], firstDecisive: null, stopped: null };
      for (let d = 0; d < days; d++) {
        setClock(day0 + d * DAY + 12 * 3_600_000);
        for (let i = 0; i < perDay; i++) {
          const unit = `${s.key}-v${d}-${i}`;
          const lost = rand() < s.dropTreatmentExposures;
          const peek = sdk.variant(s.key, unit, { log: false })!;
          const arm = peek === 'control' ? 0 : 1;
          if (!(arm === 1 && lost)) {
            sdk.variant(s.key, unit);
            res.sent.exposures++;
          }
          if (rand() < s.rates[arm]!) {
            sdk.track('purchase', unit);
            res.sent.conversions++;
          }
          if (rand() < s.refunds[arm]!) {
            sdk.track('refund', unit);
            res.sent.conversions++;
          }
        }
        const f = await sdk.flush();
        if (f.failed || sdk.pending()) throw new Error(`ingest failed for ${f.failed} events on day ${d}`);
        res.sent.accepted += f.accepted;
        res.sent.duplicates += f.duplicates;
        res.sent.rejected += f.rejected.length;

        setClock(day0 + (d + 1) * DAY - 1000); // 23:59:59 on day d
        const r = (await getReadout(ctx, id))!.readout;
        res.plannedUnitsPerArm = r.plannedUnitsPerArm;
        const c = r.comparisons?.[0];
        res.days.push({
          day: d + 1,
          units: r.arms.map((a) => a.units),
          rates: r.arms.map((a) => r6(a.level)),
          diff: r6(c?.diff),
          seqP: r6(c?.sequential.p),
          ciLow: r6(c?.sequential.ciLow),
          ciHigh: r6(c?.sequential.ciHigh),
          fixedP: r6(c?.fixed?.p),
          srmP: r6(r.srm.p)!,
          state: r.decision.state,
          headline: r.decision.headline,
        });
        if (!res.firstDecisive && ['ship', 'guardrail', 'worse', 'srm', 'no_effect'].includes(r.decision.state)) res.firstDecisive = { day: d + 1, state: r.decision.state };
        if (s.stopOnShip && r.decision.state === 'ship') {
          const stored = await stopExperiment(ctx, id, `case study: shipped on day ${d + 1}`);
          const auditEvents = await withOrg(ctx, (tx) => tx.auditEvent.count({ where: { orgId: ctx.orgId, action: 'experiment.stopped', targetId: id } }));
          res.stopped = { day: d + 1, recordedState: stored.decision.state, auditEvents };
          break;
        }
      }
      results.push(res);
    }
  } finally {
    advanceClock(0);
  }
  return { days, visitorsPerDay: perDay, results };
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(2)}%`);
const pts = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(2)}`);
const p4 = (x: number | null) => (x === null ? '—' : x < 0.0001 ? '< 0.0001' : x.toFixed(4));

export function table(r: ScenarioResult): string {
  const lines = [
    `### ${r.label}`,
    '',
    '| Day | Units (control / treatment) | Purchase rate (control / treatment) | Diff (pts) | Always-valid p | 95% confidence sequence (pts) | Fixed-horizon p | SRM p | Decision |',
    '|---|---|---|---|---|---|---|---|---|',
    ...r.days.map(
      (d) =>
        `| ${d.day} | ${d.units.map((u) => u.toLocaleString('en-US')).join(' / ')} | ${d.rates.map(pct).join(' / ')} | ${pts(d.diff)} | ${p4(d.seqP)} | ${d.ciLow === null && d.ciHigh === null ? '—' : `${pts(d.ciLow)} to ${pts(d.ciHigh)}`} | ${p4(d.fixedP)} | ${p4(d.srmP)} | ${d.headline} |`,
    ),
  ];
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const t0 = Date.now();
  const out = await runCaseStudy();
  const json = `${JSON.stringify(out, null, 1)}\n`;
  if (!process.argv.includes('--no-write')) writeFileSync('docs/holdout/case-study.json', json);
  for (const r of out.results) {
    console.log(`\n${table(r)}\n`);
    console.log(`planned ${r.plannedUnitsPerArm}/arm; sent ${JSON.stringify(r.sent)}; first decisive ${JSON.stringify(r.firstDecisive)}; stopped ${JSON.stringify(r.stopped)}`);
  }
  console.log(`\n${out.results.length} scenarios × ${out.days} days × ${out.visitorsPerDay} visitors/day in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await db.$disconnect();
}
