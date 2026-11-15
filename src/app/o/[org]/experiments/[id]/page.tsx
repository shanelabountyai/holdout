import { z } from 'zod';
import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import { can } from '@/core/authz/permissions';
import { ActionForm } from '@/core/ui/action-form';
import { getExperiment } from '@/lib/holdout/experiments';
import { editExperiment, launchExperiment, removeExperiment, renameExperimentAction } from '../actions';
import { DesignFields, type DesignDefaults } from '../design-fields';

export const metadata = { title: 'Experiment' };

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
const n = (x: number) => x.toLocaleString('en-US');
const num = (x: number | null) => (x === null ? '' : String(Number(x.toPrecision(12))));

export default async function ExperimentPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const x = await getExperiment(ctx, id);
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  const proportion = x.metricKind === 'proportion';
  const draft = x.status === 'draft';
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

  return (
    <main>
      <h1>{x.name}</h1>
      <p>
        Key <code>{x.key}</code> · status <strong>{x.status}</strong>
        {x.startedAt && <> · started {x.startedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</>}
      </p>
      {x.description && <p>{x.description}</p>}
      {!draft && <p>The design is frozen: variants, weights, their order, metrics and the plan cannot change while units are being assigned (HO-01).</p>}

      <h2>Planned sample size</h2>
      <ul>
        <li>
          Primary metric <code>{x.metricEvent}</code>, {proportion ? 'conversion rate' : 'mean value per unit'}:{' '}
          {proportion
            ? <>baseline {num((x.baselineRate ?? 0) * 100)}%, minimum detectable effect {num(x.mde * 100)} percentage points</>
            : <>{x.baselineMean !== null && <>baseline mean {num(x.baselineMean)}, </>}standard deviation {num(x.baselineSd)}, minimum detectable effect {num(x.mde)}</>}
          {' '}(power {num(x.power * 100)}%, α {num(x.alpha * 100)}%)
        </li>
        <li>Fixed-horizon test: {n(x.fixedUnitsPerArm)} units per arm</li>
        <li><strong>Planned for the sequential readout: {n(x.plannedUnitsPerArm)} units per arm</strong> (2× the fixed-horizon n, D-16)</li>
        <li>Planned total: {n(x.plannedTotalUnits)} units across all variants, so the smallest arm reaches its planned n</li>
      </ul>

      <h2>Variants</h2>
      <table>
        <thead><tr><th>Order</th><th>Key</th><th>Name</th><th>Weight</th></tr></thead>
        <tbody>
          {x.variants.map((v) => (
            <tr key={v.id}><td>{v.position + 1}</td><td><code>{v.key}</code></td><td>{v.name}</td><td>{pct(v.weight)}</td></tr>
          ))}
        </tbody>
      </table>

      <h2>Guardrail metrics</h2>
      {x.guardrails.length ? (
        <ul>{x.guardrails.map((g) => <li key={g.id}><code>{g.event}</code> ({g.kind === 'proportion' ? 'conversion rate' : 'mean value'})</li>)}</ul>
      ) : <p>None.</p>}

      <h2>Ingest so far</h2>
      <p>
        {n(x._count.exposures)} units exposed. Events received for <code>{x.metricEvent}</code>: {n(x.conversions[x.metricEvent] ?? 0)}
        {x.guardrails.map((g) => <span key={g.id}>; <code>{g.event}</code>: {n(x.conversions[g.event] ?? 0)}</span>)}.
        {' '}Results and the readout arrive in Phase 3.
      </p>

      {draft && can(ctx.role, 'org.update') && (
        <>
          <h2>Start</h2>
          <p>Starting freezes the design and begins accepting exposures.</p>
          <ActionForm action={bind(launchExperiment)}>
            <input type="hidden" name="id" value={x.id} />
            <button type="submit">Start experiment</button>
          </ActionForm>
        </>
      )}
      {draft && !can(ctx.role, 'org.update') && <p>An owner or admin starts the experiment.</p>}

      {draft ? (
        <>
          <h2>Edit draft</h2>
          <ActionForm action={bind(editExperiment)}>
            <input type="hidden" name="id" value={x.id} />
            <DesignFields d={defaults} />
            <button type="submit">Save draft</button>
          </ActionForm>
          <h2>Delete draft</h2>
          <ActionForm action={bind(removeExperiment)}>
            <input type="hidden" name="id" value={x.id} />
            <button type="submit">Delete draft</button>
          </ActionForm>
        </>
      ) : (
        <>
          <h2>Rename</h2>
          <ActionForm action={bind(renameExperimentAction)}>
            <input type="hidden" name="id" value={x.id} />
            <p><label>Name <input name="name" required maxLength={120} defaultValue={x.name} /></label></p>
            <p><label>Description <textarea name="description" maxLength={2000} defaultValue={x.description} /></label></p>
            <button type="submit">Save</button>
          </ActionForm>
        </>
      )}
    </main>
  );
}
