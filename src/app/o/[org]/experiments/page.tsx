import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { listExperiments } from '@/lib/holdout/experiments';

export const metadata = { title: 'Experiments' };

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;

// Phase 2: configuration and ingest health only. The readout (decisions, SRM, sequential results) is Phase 3.
export default async function Experiments({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const rows = await listExperiments(ctx);
  const base = `/o/${ctx.slug}/experiments`;
  return (
    <main>
      <h1>Experiments</h1>
      <p><Link href={`${base}/new`}>New experiment</Link></p>
      {rows.length === 0 ? (
        <p>No experiments yet.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Name</th><th>Key</th><th>Status</th><th>Variants</th><th>Planned units</th><th>Exposures</th></tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.id}>
                <td><Link href={`${base}/${x.id}`}>{x.name}</Link></td>
                <td><code>{x.key}</code></td>
                <td>{x.status}</td>
                <td>{x.variants.map((v) => `${v.key} ${pct(v.weight)}`).join(' · ')}</td>
                <td>{x.plannedTotalUnits.toLocaleString('en-US')}</td>
                <td>{x._count.exposures.toLocaleString('en-US')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
