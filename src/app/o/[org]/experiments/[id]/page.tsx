import Link from 'next/link';
import { z } from 'zod';
import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import { can } from '@/core/authz/permissions';
import { ActionForm } from '@/core/ui/action-form';
import { actorEmails } from '@/core/audit';
import { now } from '@/core/clock';
import { experimentHistory, getExperiment, getLookSeries, getReadout, MAX_STOP_REASON } from '@/lib/holdout/experiments';
import { editExperiment, haltExperiment, launchExperiment, removeExperiment, renameExperimentAction } from '../actions';
import { DesignFields, type DesignDefaults } from '../design-fields';
import { ConfirmButton } from '../confirm-button';
import { DecisionBanner, ReadoutView, SrmView } from '../readout-view';
import { ACTIONS, Glyph, n, pctBps, runLabel, STATE, utc } from '../ui';

export const metadata = { title: 'Experiment · Holdout' };

const num = (x: number | null) => (x === null ? '' : String(Number(x.toPrecision(12))));

// One page per experiment. Draft: Draft.dc.html (plan, start, design, edit, delete). Running or stopped: the readout
// (Main.dc.html, Srm.dc.html), then the same plan, design and history cards.
export default async function ExperimentPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const x = await getExperiment(ctx, id);
  const [ro, series, history] = await Promise.all([getReadout(ctx, id), getLookSeries(ctx, id), experimentHistory(ctx, id)]);
  const emails = await actorEmails(history.map((h) => h.actorUserId));
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  const proportion = x.metricKind === 'proportion';
  const draft = x.status === 'draft';
  const admin = can(ctx.role, 'org.update');
  const defaults: DesignDefaults = {
    key: x.key,
    name: x.name,
    description: x.description,
    metricEvent: x.metricEvent,
    metricKind: x.metricKind,
    baseline: proportion ? num(x.baselineRate === null ? null : x.baselineRate * 100) : num(x.baselineMean),
    sd: num(x.baselineSd),
    mde: num(proportion ? x.mde * 100 : x.mde),
    variants: x.variants.map((v) => ({ key: v.key, name: v.name, weight: num(v.weight / 100) })),
    guardrails: x.guardrails.map((g) => ({ event: g.event, kind: g.kind })),
  };
  const by = (uid: string | null) => (uid ? (emails.get(uid) ?? 'a deleted user') : 'the system');
  const stopEvent = history.find((h) => h.action === 'experiment.stopped');
  const stopReason = (stopEvent?.data as { reason?: string } | null | undefined)?.reason || undefined;
  const tone = ro ? STATE[ro.readout.decision.state].tone : 'neutral';
  const srm = ro?.readout.decision.state === 'srm';
  const unequal = new Set(x.variants.map((v) => v.weight)).size > 1;

  const stopForm =
    x.status === 'running' &&
    (admin ? (
      <div className="ho-stop-form">
        <ActionForm action={bind(haltExperiment)}>
          <input type="hidden" name="id" value={x.id} />
          <div className="ho-stop-form">
            <label htmlFor="stop-reason">Reason (optional)</label>
            <textarea id="stop-reason" name="reason" maxLength={MAX_STOP_REASON} rows={2} aria-describedby="stop-help" />
            <ConfirmButton className={tone === 'good' ? 'ho-btn' : 'ho-btn ho-btn-ghost'} question="Stop this experiment for good? No more exposures will be accepted, and this readout is recorded as the final one.">
              Stop and store this readout
            </ConfirmButton>
            <span id="stop-help" style={{ fontSize: 13 }}>Ends the experiment for good: no more exposures are accepted, and this readout is recorded in the audit log as it stands now.</span>
          </div>
        </ActionForm>
      </div>
    ) : (
      <p style={{ margin: 0, fontSize: 14, flex: '0 1 280px' }}>An owner or admin can stop the experiment and store this readout.</p>
    ));

  return (
    <main className="ho-main">
      <div className="ho-title">
        <span className="ho-meta">
          <code>{x.key}</code> · {runLabel(x.status, x.startedAt, x.stoppedAt, now().getTime())} · {x.variants.length} arms
          {x.startedAt && <> · from {utc(x.startedAt)}</>}
          {x.stoppedAt && <> to {utc(x.stoppedAt)}</>}
        </span>
        <h1 className="ho-h1">{x.name}</h1>
        {x.description && <p className="ho-lead">{x.description}</p>}
      </div>

      {draft ? (
        <section aria-labelledby="status" className="ho-banner ho-tone-neutral" data-tone="neutral">
          <div className="ho-banner-text">
            <h2 id="status" className="ho-eyebrow" style={{ margin: 0 }}>Status</h2>
            <p className="ho-headline"><Glyph g={STATE.draft.glyph} />Draft: not started</p>
            <p>Nothing receives traffic until an owner or admin starts it. Starting freezes the variants, weights, their order, the metrics and the plan.</p>
          </div>
          {admin ? (
            <ActionForm action={bind(launchExperiment)}>
              <input type="hidden" name="id" value={x.id} />
              <ConfirmButton className="ho-btn" question="Start this experiment? Its variants, weights, metrics and plan freeze, and it begins accepting traffic.">
                Start experiment
              </ConfirmButton>
            </ActionForm>
          ) : (
            <p style={{ margin: 0, fontSize: 14 }}>An owner or admin starts the experiment.</p>
          )}
        </section>
      ) : (
        ro && <DecisionBanner r={ro.readout} stored={ro.stored} reason={stopReason} action={stopForm || undefined} />
      )}

      {ro && (ro.readout.decision.state === 'srm' ? <SrmView r={ro.readout} /> : <ReadoutView r={ro.readout} series={series} guardrailEvents={x.guardrails.map((g) => g.event)} />)}

      <div className="ho-row">
        <section aria-labelledby="plan" className="ho-dark">
          <h2 id="plan" className="ho-eyebrow">Planned sample</h2>
          <span className="ho-big">{n(x.plannedUnitsPerArm)}</span>
          <span>units per arm · {n(x.plannedTotalUnits)} in total</span>
          <span className="ho-dim" style={{ fontSize: 14 }}>
            2× the fixed-horizon size ({n(x.fixedUnitsPerArm)} per arm), so you can check daily without inflating false wins. Primary metric <code>{x.metricEvent}</code>,{' '}
            {proportion
              ? <>baseline {num((x.baselineRate ?? 0) * 100)}%, smallest lift {x.mde >= 0 ? '+' : '−'}{num(Math.abs(x.mde) * 100)} pts</>
              : <>{x.baselineMean !== null && <>baseline mean {num(x.baselineMean)}, </>}standard deviation {num(x.baselineSd)}, smallest change {num(x.mde)}</>}
            , {num((1 - x.alpha) * 100)}% confidence, {num(x.power * 100)}% power.{unequal && ' With an unequal split, the total is what the smallest arm needs.'}
          </span>
        </section>

        <section aria-labelledby="design" className="ho-card">
          <h2 id="design">Design</h2>
          <table className="ho-table ho-table-compact" style={{ fontSize: 14 }}>
            <thead><tr><th scope="col">Order</th><th scope="col">Variant</th><th scope="col" className="num">Weight</th></tr></thead>
            <tbody>
              {x.variants.map((v) => (
                <tr key={v.id}><td>{v.position + 1}</td><td>{v.name} <code>{v.key}</code></td><td className="num">{pctBps(v.weight)}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="ho-pills" style={{ alignItems: 'center' }}>
            <span style={{ fontWeight: 600 }}>Guardrails</span>
            {x.guardrails.length ? (
              x.guardrails.map((g) => <span key={g.id} style={{ border: '1px solid var(--ho-field)', borderRadius: 999, padding: '4px 12px' }}><code>{g.event}</code> · {g.kind === 'proportion' ? 'rate' : 'mean'}</span>)
            ) : <span className="ho-small">none</span>}
          </div>
          <p className="ho-small">
            Ingest so far: {n(x._count.exposures)} units exposed to this experiment.
            {!srm && (
              <> Events received in this org (all experiments): <code>{x.metricEvent}</code> {n(x.conversions[x.metricEvent] ?? 0)}
                {x.guardrails.map((g) => <span key={g.id}>, <code>{g.event}</code> {n(x.conversions[g.event] ?? 0)}</span>)}.</>
            )}
          </p>
          {x.status !== 'stopped' && (
            <p className="ho-small">
              Send traffic with the key <code>{x.key}</code>{draft && ' once it is started'}: <Link href={`/o/${ctx.slug}/install?key=${encodeURIComponent(x.key)}`}>install the snippet</Link>.
            </p>
          )}
          {draft ? (
            <a className="ho-link-btn" href="#edit">Edit draft below</a>
          ) : (
            <p className="ho-small">The design is frozen: variants, weights, their order, metrics and the plan cannot change while units are being assigned.</p>
          )}
        </section>
      </div>

      {draft ? (
        <section aria-labelledby="edit" className="ho-card">
          <h2 id="edit">Edit draft</h2>
          <ActionForm action={bind(editExperiment)}>
            <input type="hidden" name="id" value={x.id} />
            <DesignFields d={defaults} submitLabel="Save draft" embedded />
          </ActionForm>
        </section>
      ) : (
        <details className="ho-details ho-card">
          <summary>Rename or edit the description</summary>
          <ActionForm action={bind(renameExperimentAction)}>
            <input type="hidden" name="id" value={x.id} />
            <div className="ho-form" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="ho-field"><label htmlFor="rn-name">Name</label><input id="rn-name" name="name" required maxLength={120} defaultValue={x.name} /></div>
              <div className="ho-field"><label htmlFor="rn-desc">Description</label><textarea id="rn-desc" name="description" maxLength={2000} defaultValue={x.description} /></div>
              <button type="submit" className="ho-btn ho-btn-ghost" style={{ alignSelf: 'flex-start' }}>Save</button>
            </div>
          </ActionForm>
        </details>
      )}

      <section aria-labelledby="hist" className="ho-card">
        <h2 id="hist">History</h2>
        {history.length ? (
          <ol className="ho-history">
            {history.map((h) => (
              <li key={String(h.id)}>
                <time dateTime={h.at.toISOString()}>{utc(h.at)}</time> · {ACTIONS[h.action] ?? h.action} by {by(h.actorUserId)}
                {h.action === 'experiment.stopped' && (h.data as { reason?: string } | null)?.reason ? <> — “{(h.data as { reason: string }).reason}”</> : null}
              </li>
            ))}
          </ol>
        ) : <p className="ho-small">No events.</p>}
      </section>

      {draft && (
        <section aria-labelledby="danger" className="ho-card" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '10px 16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <h2 id="danger">Delete draft</h2>
            <p className="ho-small">Only drafts can be deleted. A started experiment stays on record.</p>
          </div>
          <ActionForm action={bind(removeExperiment)}>
            <input type="hidden" name="id" value={x.id} />
            <ConfirmButton className="ho-btn ho-btn-danger" question="Delete this draft? This cannot be undone.">Delete draft</ConfirmButton>
          </ActionForm>
        </section>
      )}
    </main>
  );
}
