import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { listExperiments } from '@/lib/holdout/experiments';

// The org's landing page after sign-in. An empty org keeps the foundation's "Nothing here yet" heading
// (e2e/onboarding.spec.ts checks it); an org with experiments says how many and links to them.
export default async function OrgHome({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const base = `/o/${ctx.slug}`;
  const rows = await listExperiments(ctx);
  const running = rows.filter((x) => x.status === 'running').length;
  const drafts = rows.filter((x) => x.status === 'draft').length;
  return (
    <main className="ho-main">
      <div className="ho-title">
        {rows.length ? (
          <>
            <h1 className="ho-h1">{rows.length} {rows.length === 1 ? 'experiment' : 'experiments'}, {running} running</h1>
            <p className="ho-lead">{drafts ? `${drafts} ${drafts === 1 ? 'draft is' : 'drafts are'} waiting to start. ` : ''}Every running experiment&apos;s decision is on the experiment list.</p>
          </>
        ) : (
          <>
            <h1 className="ho-h1">Nothing here yet</h1>
            <p className="ho-lead">This org is ready. Draft the first experiment, or <Link href={`${base}/settings/members`} style={{ display: 'inline-block', minHeight: 24 }}>invite your team</Link> to work on it together.</p>
          </>
        )}
      </div>
      <div className="ho-row">
        <section className="ho-card" aria-labelledby="start">
          <h2 id="start">{rows.length ? 'Read the decisions' : 'Run an experiment'}</h2>
          <p className="ho-small">{rows.length ? 'Each experiment shows its decision first, then the numbers behind it.' : 'Draft one, see its planned sample size, then start it and read the decision.'}</p>
          <Link className="ho-link-btn" href={`${base}/experiments`}>Go to experiments</Link>
        </section>
        <section className="ho-card" aria-labelledby="install">
          <h2 id="install">Send traffic</h2>
          <p className="ho-small">The snippet assigns visitors in the browser; your server holds the API key and relays events.</p>
          <Link className="ho-link-btn" href={`${base}/install`}>Install the snippet</Link>
        </section>
      </div>
    </main>
  );
}
