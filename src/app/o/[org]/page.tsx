import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';

// The org's landing page after sign-in. The heading stays the foundation's (e2e/onboarding.spec.ts checks it); the work
// starts on the experiment list.
export default async function OrgHome({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const base = `/o/${ctx.slug}`;
  return (
    <main className="ho-main">
      <div className="ho-title">
        <h1 className="ho-h1">Nothing here yet</h1>
        <p className="ho-lead">This org is ready. Experiments live on the experiment list; <Link href={`${base}/settings/members`}>invite your team</Link> to work on them together.</p>
      </div>
      <div className="ho-row">
        <section className="ho-card" aria-labelledby="start">
          <h2 id="start">Run an experiment</h2>
          <p className="ho-small">Draft one, see its planned sample size, then start it and read the decision.</p>
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
