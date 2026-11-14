import { createKey } from '@/modules/apikeys/keys';
import type { DesignInput } from '@/lib/holdout/experiments';
import { actAs, addMember, makeOrg } from '../helpers/org';

/** The PRD's conversion example: 10% → 12% (MDE +2 points), two arms 50/50, one guardrail. */
export const conversionDesign = (over: Partial<DesignInput> = {}): DesignInput => ({
  key: 'checkout-button',
  name: 'Checkout button',
  description: '',
  metricEvent: 'purchase',
  metricKind: 'proportion',
  baselineRate: 0.1,
  mde: 0.02,
  variants: [
    { key: 'control', name: 'Control', weight: 5000 },
    { key: 'treatment', name: 'Treatment', weight: 5000 },
  ],
  guardrails: [{ event: 'refund', kind: 'proportion' }],
  ...over,
});

/** The PRD's means example: 10 ± 5 → 10.5. */
export const meanDesign = (over: Partial<DesignInput> = {}): DesignInput =>
  conversionDesign({ key: 'order-value', metricEvent: 'order', metricKind: 'mean', baselineRate: null, baselineMean: 10, baselineSd: 5, mde: 0.5, guardrails: [], ...over });

export async function org(slug: string) {
  const o = await makeOrg(slug);
  const owner = await addMember(o.id, 'owner', `owner@${slug}.test`);
  return { orgId: o.id, slug, ownerId: owner.id, owner: await actAs(owner.id, slug) };
}

export const ingestKey = (ctx: Awaited<ReturnType<typeof org>>['owner'], scopes = ['ingest', 'read']) => createKey(ctx, { label: 'sdk', scopes });

export const req = (path: string, key: string | null, init: RequestInit = {}) =>
  new Request(`http://app.test/api/v1${path}`, { ...init, headers: { ...(key && { authorization: `Bearer ${key}` }), 'content-type': 'application/json' } });
