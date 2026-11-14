import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { addExperiment } from '../actions';
import { DesignFields, EMPTY } from '../design-fields';

export const metadata = { title: 'New experiment' };

export default async function NewExperiment({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  return (
    <main>
      <h1>New experiment</h1>
      <p>Saved as a draft. The planned sample size is computed when you save; nothing receives traffic until it is started.</p>
      <ActionForm action={addExperiment.bind(null, ctx.slug)}>
        <DesignFields d={EMPTY} />
        <button type="submit">Save draft</button>
      </ActionForm>
    </main>
  );
}
