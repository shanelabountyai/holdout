import { writeFileSync } from 'node:fs';
import { now } from '@/core/clock';
import { db } from '@/core/db'; // the app client: refuses a cloud database (INV-18, INV-27); org rows only through withOrg (INV-32)
import { withOrg } from '@/core/db/rls';
import type { OrgCtx } from '@/core/authz/guards';
import { createExperiment, startExperiment } from '@/lib/holdout/experiments';
import { createKey } from '@/modules/apikeys/keys';

// Holdout Phase 4: prepares the local demo site (demo-site/, port 8101) against a local Holdout database.
// Run after `npm run seed:demo`. In the demo org "acme" (as its owner) it creates and starts the buy-button experiment
// (PRD conversion example: 10% → 12%, 50/50, refund guardrail), creates an API key with the read and ingest scopes, and
// writes HOLDOUT_API_KEY and DEMO_EXPERIMENT to an env file (default .env.demo-site, git-ignored). The key is never
// printed. `events <orgSlug> <experimentId> <unitId>` prints what Holdout stored for one visitor (used by e2e/demo-site.spec.ts).
//
//   npm run demo:setup                       # dev database (.env.local), writes .env.demo-site
//   npm run demo:site                        # reads .env.demo-site
//   tsx scripts/demo-site-setup.ts --out .env.demo-site.test --key demo-e2e-123

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function ownerCtx(slug: string): Promise<OrgCtx> {
  const org = await db.org.findUniqueOrThrow({ where: { slug } });
  const m = await withOrg({ orgId: org.id }, (tx) => tx.membership.findFirstOrThrow({ where: { orgId: org.id, role: 'owner' }, include: { user: true } }));
  const t = now();
  return { userId: m.userId, orgId: org.id, slug, role: 'owner', session: { hash: 'demo-site-setup', userId: m.userId, email: m.user.email, authAt: t, mfaAt: t, mfaOrgId: null } as OrgCtx['session'] };
}

async function setup() {
  const ctx = await ownerCtx(arg('--org') ?? 'acme');
  const key = arg('--key') ?? 'checkout-button';
  const out = arg('--out') ?? '.env.demo-site';
  const find = () => withOrg(ctx, (tx) => tx.experiment.findFirst({ where: { orgId: ctx.orgId, key } }));
  let x = await find();
  if (!x) {
    const id = await createExperiment(ctx, {
      key,
      name: 'Northwind buy button',
      description: 'Demo site (localhost:8101): "Add to cart" vs "Buy now: free shipping".',
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
    x = (await find())!;
    if (x.id !== id) throw new Error('unexpected experiment');
  }
  if (x.status === 'draft') await startExperiment(ctx, x.id);
  else if (x.status === 'stopped') throw new Error(`experiment "${key}" is stopped; pass --key with a new key (a stopped experiment never restarts, D-18)`);
  const apiKey = await createKey(ctx, { label: `demo site ${now().toISOString().slice(0, 16)}`, scopes: ['read', 'ingest'] });
  writeFileSync(out, `# Written by scripts/demo-site-setup.ts. Local only; revoke the key in Settings → API keys when done.\nHOLDOUT_API_KEY=${apiKey}\nDEMO_EXPERIMENT=${key}\nDEMO_EXPERIMENT_ID=${x.id}\n`, { mode: 0o600 });
  console.log(`Experiment "${key}" is running in org "${ctx.slug}". API key (read + ingest) written to ${out}. Next: npm run demo:site`);
}

async function events(slug: string, experimentId: string, unitId: string) {
  const org = await db.org.findUniqueOrThrow({ where: { slug } });
  const { exposures, conversions } = await withOrg({ orgId: org.id }, async (tx) => ({
    exposures: await tx.exposure.findMany({ where: { orgId: org.id, experimentId, unitId }, include: { variant: true } }),
    conversions: await tx.conversion.findMany({ where: { orgId: org.id, unitId }, orderBy: { occurredAt: 'asc' } }),
  }));
  console.log(JSON.stringify({ exposures: exposures.map((e) => ({ variant: e.variant.key, eventId: e.eventId })), conversions: conversions.map((c) => ({ event: c.event, eventId: c.eventId })) }));
}

try {
  if (process.argv[2] === 'events') await events(process.argv[3]!, process.argv[4]!, process.argv[5]!);
  else await setup();
} finally {
  await db.$disconnect();
}
