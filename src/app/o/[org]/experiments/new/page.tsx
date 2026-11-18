import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { addExperiment } from '../actions';
import { DesignFields, EMPTY } from '../design-fields';

export const metadata = { title: 'New experiment · Holdout' };

// New.dc.html: the design on the left, the planned sample computed live on the right.
export default async function NewExperiment({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  return (
    <main className="ho-main">
      <div className="ho-title">
        <h1 className="ho-h1">New experiment</h1>
        <p className="ho-lead">Pick a metric and the smallest lift worth detecting; the planned sample size is fixed before any traffic arrives. Saved as a draft.</p>
      </div>
      <ActionForm action={addExperiment.bind(null, ctx.slug)}>
        <DesignFields d={EMPTY} submitLabel="Create draft and get the snippet" />
      </ActionForm>
    </main>
  );
}
