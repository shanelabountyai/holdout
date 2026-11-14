'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import type { OrgCtx } from '@/core/authz/guards';
import { createExperiment, deleteDraft, renameExperiment, startExperiment, updateDraft } from '@/lib/holdout/experiments';
import { design, toDesign } from '@/lib/holdout/form';

// Experiments UI (Phase 2). Any member drafts; starting, which freezes the design and goes live, needs org.update
// (owner or admin), D-21. Every id is ref('experiment'), so the INV-01..04 harness scopes it.

const page = (ctx: OrgCtx, id?: string) => `/o/${ctx.slug}/experiments${id ? `/${id}` : ''}`;

export const addExperiment = orgAction(null, design, async (ctx, i) => {
  const id = await createExperiment(ctx, toDesign(i));
  redirect(page(ctx, id));
});

export const editExperiment = orgAction(null, design.extend({ id: ref('experiment') }), async (ctx, i) => {
  await updateDraft(ctx, i.id, () => toDesign(i));
  redirect(page(ctx, i.id));
});

export const renameExperimentAction = orgAction(
  null,
  z.object({ id: ref('experiment'), name: z.string().max(120), description: z.string().max(2000).default('') }),
  async (ctx, i) => {
    await renameExperiment(ctx, i.id, i.name, i.description);
    redirect(page(ctx, i.id));
  },
);

export const removeExperiment = orgAction(null, z.object({ id: ref('experiment') }), async (ctx, i) => {
  await deleteDraft(ctx, i.id);
  redirect(page(ctx));
});

export const launchExperiment = orgAction('org.update', z.object({ id: ref('experiment') }), async (ctx, i) => {
  await startExperiment(ctx, i.id);
  redirect(page(ctx, i.id));
});
