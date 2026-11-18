import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { getReadout, listExperiments } from '@/lib/holdout/experiments';
import { Glyph, n, runLabel, STATE, type Tone } from './ui';

export const metadata = { title: 'Experiments · Holdout' };

const STATUS = { draft: 'Draft', running: 'Running', stopped: 'Stopped' } as const;
const CHIP: Record<Tone, React.CSSProperties> = {
  good: { background: 'var(--ho-good-bg)', color: 'var(--ho-good-fg)', border: '1px solid var(--ho-good-line)' },
  hold: { background: 'var(--ho-hold-bg)', color: 'var(--ho-hold-fg)', border: '1px solid var(--ho-hold-line)' },
  stop: { background: 'var(--ho-stop-bg)', color: 'var(--ho-stop-fg)', border: '2px solid var(--ho-stop-line)' },
  neutral: { background: 'var(--ho-surface)', color: 'var(--ho-ink)', border: '1px solid var(--ho-field)' },
};

// List.dc.html: every experiment with its status, its decision (the readout's, computed now for a running experiment and
// the recorded one for a stopped experiment), days and progress to plan.
export default async function Experiments({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const rows = await listExperiments(ctx);
  const readouts = await Promise.all(rows.map((x) => (x.status === 'draft' ? null : getReadout(ctx, x.id))));
  const base = `/o/${ctx.slug}/experiments`;
  const at = now().getTime();
  return (
    <main className="ho-main">
      <div className="ho-titlebar">
        <div className="ho-title">
          <span className="ho-meta">{rows.length} {rows.length === 1 ? 'experiment' : 'experiments'}</span>
          <h1 className="ho-h1">Experiments</h1>
        </div>
        <Link className="ho-btn" href={`${base}/new`}>New experiment</Link>
      </div>

      {rows.length === 0 ? (
        <section aria-labelledby="empty" className="ho-card ho-card-dashed">
          <h2 id="empty">No experiments yet</h2>
          <p className="ho-small">Draft one: pick a metric and the smallest lift worth detecting, and Holdout plans the sample size before any traffic arrives.</p>
          <Link className="ho-link-btn" href={`${base}/new`}>Draft your first experiment</Link>
        </section>
      ) : (
        <>
          <section aria-labelledby="list" className="ho-card ho-card-flush" tabIndex={0}>
            <h2 id="list">Newest first</h2>
            <table className="ho-table ho-list-table" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th scope="col">Experiment</th>
                  <th scope="col">Status</th>
                  <th scope="col">Decision</th>
                  <th scope="col" className="num">Days</th>
                  <th scope="col">Progress to plan (smallest arm)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x, i) => {
                  const r = readouts[i]?.readout;
                  const st = STATE[r ? r.decision.state : 'draft'];
                  const days = x.startedAt ? Math.floor(((x.status === 'stopped' && x.stoppedAt ? x.stoppedAt.getTime() : at) - x.startedAt.getTime()) / 86_400_000) : null;
                  const pct = r ? Math.min(100, Math.floor((100 * r.minArmUnits) / x.plannedUnitsPerArm)) : 0;
                  return (
                    <tr key={x.id} data-key={x.key}>
                      <td>
                        <Link href={`${base}/${x.id}`} style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>{x.name}</Link>
                        <br />
                        <code className="ho-help" style={{ whiteSpace: 'nowrap' }}>{x.key}</code>
                      </td>
                      <td data-label="Status"><span aria-hidden="true">{STATUS[x.status]}</span><span className="ho-sr-only">{runLabel(x.status, x.startedAt, x.stoppedAt, at)}</span></td>
                      <td data-label="Decision">
                        <span className="ho-chip" style={CHIP[st.tone]}>
                          <Glyph g={st.glyph} />
                          {r ? (x.status === 'stopped' ? `At the stop: ${r.decision.headline}` : r.decision.headline) : 'Not started'}
                        </span>
                      </td>
                      <td className="num" data-label="Days">{days === null ? '—' : n(days)}</td>
                      <td data-label="Progress">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
                          <span style={{ fontSize: 14 }}>
                            {r ? <>{n(r.minArmUnits)} of {n(x.plannedUnitsPerArm)} units ({pct}%)</> : <>Plan: {n(x.plannedUnitsPerArm)} units per arm</>}
                          </span>
                          <div className="ho-progress" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <p className="ho-note">
            Decision is the readout&apos;s: computed now for a running experiment, and the one recorded at the stop for a stopped experiment. A draft has no readout yet.
          </p>
        </>
      )}
    </main>
  );
}
