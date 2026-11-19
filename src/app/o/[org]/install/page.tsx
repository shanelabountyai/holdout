import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { can } from '@/core/authz/permissions';
import { env } from '@/core/env';
import { listExperiments } from '@/lib/holdout/experiments';
import { pctBps } from '../experiments/ui';

export const metadata = { title: 'Install snippet · Holdout' };

// Install.dc.html (gap design): how a site sends traffic. The browser never holds an API key: the site's server loads the
// config with the server SDK, renders it into the page, and relays the snippet's events (D-35, D-36, D-37). The local demo
// site (D-38) does exactly this. Nothing on this page writes anything.
export default async function Install({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ key?: string | string[] }> }) {
  const ctx = await requireOrg((await params).org);
  const all = await listExperiments(ctx);
  const running = all.filter((x) => x.status === 'running');
  const asked = (await searchParams).key;
  const chosen = typeof asked === 'string' ? all.find((x) => x.key === asked && x.status !== 'stopped') : undefined;
  const keys = can(ctx.role, 'apikeys.manage');
  const first = chosen ?? running[0];
  const key = first?.key ?? 'your-experiment-key';
  const event = first?.metricEvent ?? 'purchase';
  const server = `import { HoldoutServer } from './holdout/server'; // src/sdk/server.ts
const holdout = new HoldoutServer({ baseUrl: '${env.APP_URL}', apiKey: process.env.HOLDOUT_KEY });
await holdout.refresh();                    // GET /api/v1/experiments (read)
const experiments = holdout.experiments();  // render into the page for the snippet
// In your relay route (same site as the page), with the visitor id from your own cookie:
holdout.enqueue(events);
await holdout.flush();                      // POST /api/v1/ingest (ingest), up to 500 events`;
  const page = `<script src="/holdout.js"></script>
<script>
  Holdout.init({ experiments /* rendered by your server */, unitId: visitorId, endpoint: '/collect' });
  const v = Holdout.variant('${key}');   // logs one exposure
  // when it happens: Holdout.track('${event}');
</script>`;
  return (
    <main className="ho-main">
      <div className="ho-title">
        <h1 className="ho-h1">Install the snippet</h1>
        <p className="ho-lead">
          Your site&apos;s server holds the API key; the browser never does. The server renders the running experiments into the page, the snippet assigns each visitor with the same function the server checks exposures with, and your server relays its events to Holdout.
        </p>
      </div>

      <ol className="ho-steps">
        <li className="ho-card">
          <h2><span className="ho-meta" style={{ fontSize: 'inherit' }}>1</span> · Create an API key with <code>read</code> and <code>ingest</code></h2>
          <p className="ho-small">Owners and admins do this in Settings → API keys. Keep the key on your server, never in a page.</p>
          {keys ? (
            <Link className="ho-link-btn" href={`/o/${ctx.slug}/settings/apikeys`}>Open API keys</Link>
          ) : (
            <p className="ho-small" style={{ background: 'var(--ho-thead)', borderRadius: 10, padding: '10px 12px' }}>An owner or admin creates API keys.</p>
          )}
        </li>
        <li className="ho-card">
          <h2><span className="ho-meta" style={{ fontSize: 'inherit' }}>2</span> · On your server: load the config, then relay events</h2>
          <pre className="ho-pre" tabIndex={0} role="region" aria-label="Server code"><code>{server}</code></pre>
        </li>
        <li className="ho-card">
          <h2><span className="ho-meta" style={{ fontSize: 'inherit' }}>3</span> · In the page: the snippet</h2>
          {chosen && chosen.status === 'draft' && <p className="ho-small">Shown for the draft <code>{chosen.key}</code>: it receives traffic once an owner or admin starts it.</p>}
          <pre className="ho-pre" tabIndex={0} role="region" aria-label="Page code"><code>{page}</code></pre>
          <p className="ho-note">
            <code>holdout.js</code> is <code>sdk/holdout.js</code> in the repository, built by <code>npm run sdk:build</code>; serve it from your own site. It retries with the same event ids, so a resend is counted once.
          </p>
        </li>
      </ol>

      <section aria-labelledby="running" className="ho-card ho-card-flush" tabIndex={0}>
        <h2 id="running">Keys to use: running experiments</h2>
        {running.length ? (
          <table className="ho-table" style={{ minWidth: 560 }}>
            <thead><tr><th scope="col">Experiment</th><th scope="col">Key</th><th scope="col">Variants, in bucket order</th><th scope="col">Metric event</th></tr></thead>
            <tbody>
              {running.map((x) => (
                <tr key={x.id}>
                  <td className="arm"><Link href={`/o/${ctx.slug}/experiments/${x.id}`} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>{x.name}</Link></td>
                  <td><code style={{ whiteSpace: 'nowrap' }}>{x.key}</code></td>
                  <td>{x.variants.map((v, i) => <span key={v.id}>{i > 0 && ' · '}<code>{v.key}</code> {pctBps(v.weight)}</span>)}</td>
                  <td><code>{x.metricEvent}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ borderTop: 0 }}>Nothing is running. Drafts are not served; start one from its page.</p>
        )}
      </section>

      <section aria-labelledby="demo" className="ho-card ho-card-dashed">
        <h2 id="demo">Try it on the local demo site</h2>
        <p className="ho-small">A fictional coffee shop on your machine, nothing deployed. After <code>npm run seed:demo</code>:</p>
        <pre className="ho-pre ho-pre-light" tabIndex={0} role="region" aria-label="Demo site commands"><code>{`npm run demo:setup   # starts checkout-button in the demo org, writes a key to .env.demo-site
npm run demo:site    # http://localhost:8101`}</code></pre>
      </section>
    </main>
  );
}
