'use client';
import { useId, useState } from 'react';
import { LIMITS, planFor, type Plan } from '@/lib/holdout/plan';
import { toDesign } from '@/lib/holdout/form';

// The design fields shared by "new" and "edit draft" (New.dc.html). Units are the ones people type: percent for weights and
// conversion rates, percentage points for a conversion MDE, metric units for a mean. The panel beside the form runs the
// server's own toDesign and planFor on what is typed, so the planned sample it shows is the one saving will store (D-42).

export type DesignDefaults = {
  key: string;
  name: string;
  description: string;
  metricEvent: string;
  metricKind: 'proportion' | 'mean';
  baseline: string;
  sd: string;
  mde: string;
  variants: { key: string; name: string; weight: string }[];
  guardrails: { event: string; kind: 'proportion' | 'mean' }[];
};

export const EMPTY: DesignDefaults = {
  key: '',
  name: '',
  description: '',
  metricEvent: '',
  metricKind: 'proportion',
  baseline: '',
  sd: '',
  mde: '',
  variants: [
    { key: 'control', name: 'Control', weight: '50' },
    { key: 'treatment', name: 'Treatment', weight: '50' },
  ],
  guardrails: [],
};

const BASELINES = ['2', '5', '10', '20'];
const MDES = ['0.5', '1', '2', '3'];
const fmt = (x: number) => x.toLocaleString('en-US');
const same = (a: string, b: string) => a.trim() !== '' && Number(a) === Number(b);

type Preview = { plan: Plan; baseline: number; target: number | null } | { error: string };

function preview(kind: DesignDefaults['metricKind'], baseline: string, sd: string, mde: string, variants: DesignDefaults['variants']): Preview {
  if (mde.trim() === '' || (kind === 'proportion' ? baseline.trim() === '' : sd.trim() === '')) {
    return { error: kind === 'proportion' ? 'Enter the baseline rate and the smallest lift to see the plan.' : 'Enter the standard deviation and the smallest change to see the plan.' };
  }
  try {
    const d = toDesign({
      key: '', name: '', description: '', metricEvent: '', metricKind: kind, baseline, sd, mde,
      variantKeys: variants.map((v, i) => v.key.trim() || (v.weight.trim() ? `v${i}` : '')),
      variantNames: variants.map((v) => v.name),
      variantWeights: variants.map((v) => v.weight),
      guardrailEvents: [], guardrailKinds: [],
    });
    if (d.variants.length < LIMITS.minVariants) return { error: `Add at least ${LIMITS.minVariants} variants with weights.` };
    const plan = planFor(d);
    return { plan, baseline: kind === 'proportion' ? d.baselineRate! : d.baselineMean ?? 0, target: kind === 'proportion' ? d.baselineRate! + d.mde : null };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function DesignFields({ d, submitLabel }: { d: DesignDefaults; submitLabel: string }) {
  const uid = useId();
  const f = (s: string) => `${uid}-${s}`;
  const [kind, setKind] = useState(d.metricKind);
  const [baseline, setBaseline] = useState(d.baseline);
  const [sd, setSd] = useState(d.sd);
  const [mde, setMde] = useState(d.mde);
  const [variants, setVariants] = useState(d.variants.length >= LIMITS.minVariants ? d.variants : EMPTY.variants);
  const [guards, setGuards] = useState(d.guardrails);
  const proportion = kind === 'proportion';
  const pv = preview(kind, baseline, sd, mde, variants);
  const sum = variants.reduce((s, v) => s + (Number(v.weight) || 0), 0);
  const setV = (i: number, k: 'key' | 'name' | 'weight', value: string) => setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, [k]: value } : v)));
  const setG = (i: number, k: 'event' | 'kind', value: string) => setGuards((gs) => gs.map((g, j) => (j === i ? { ...g, [k]: value as 'proportion' } : g)));

  return (
    <div className="ho-setup ho-form">
      <div className="ho-setup-form">
        <section className="ho-card" aria-labelledby={f('about')}>
          <h2 id={f('about')}>About</h2>
          <div className="ho-field">
            <label htmlFor={f('name')}>Name</label>
            <input id={f('name')} name="name" required maxLength={120} defaultValue={d.name} />
          </div>
          <div className="ho-field">
            <label htmlFor={f('key')}>Key</label>
            <input id={f('key')} name="key" required maxLength={64} pattern="[a-z0-9][a-z0-9_\-]*" defaultValue={d.key} aria-describedby={f('key-help')} autoCapitalize="off" spellCheck={false} />
            <span id={f('key-help')} className="ho-help">What your code sends at ingest, e.g. <code>checkout-button</code>: lowercase letters, digits, - and _.</span>
          </div>
          <div className="ho-field">
            <label htmlFor={f('desc')}>Description <span className="ho-help">(optional)</span></label>
            <textarea id={f('desc')} name="description" maxLength={2000} defaultValue={d.description} rows={2} />
          </div>
        </section>

        <section className="ho-card" aria-labelledby={f('vt')}>
          <h2 id={f('vt')}>Variants and traffic</h2>
          <div className="ho-variants">
            <span className="ho-grid-head ho-vkey" aria-hidden="true">Key</span>
            <span className="ho-grid-head" aria-hidden="true">Name</span>
            <span className="ho-grid-head" aria-hidden="true">Weight %</span>
            <span aria-hidden="true" />
            {variants.map((v, i) => (
              <VariantRow key={i} i={i} v={v} first={i === 0} canRemove={variants.length > LIMITS.minVariants} set={setV} remove={() => setVariants((vs) => vs.filter((_, j) => j !== i))} />
            ))}
          </div>
          <div className="ho-pills" style={{ alignItems: 'center' }}>
            <button type="button" className="ho-btn-add" disabled={variants.length >= LIMITS.maxVariants} onClick={() => setVariants((vs) => [...vs, { key: '', name: '', weight: '' }])}>
              + Add variant
            </button>
            <span className="ho-help" aria-live="polite">
              {Math.abs(sum - 100) < 1e-9 ? 'Weights add up to 100%.' : `Weights add up to ${Number(sum.toFixed(2))}%; they must add up to 100%.`}
            </span>
          </div>
          <p className="ho-help" style={{ margin: 0 }}>
            {LIMITS.minVariants} to {LIMITS.maxVariants} variants, each at least {LIMITS.minWeightBps / 100}%. The first is control. The order is the order units are bucketed in; weights and order freeze when the experiment starts. More than two arms are each compared with control, with a Bonferroni correction.
          </p>
        </section>

        <section className="ho-card" aria-labelledby={f('metric')}>
          <h2 id={f('metric')}>Primary metric</h2>
          <div className="ho-row" style={{ gap: 12 }}>
            <div className="ho-field" style={{ flexBasis: 220 }}>
              <label htmlFor={f('event')}>Event name</label>
              <input id={f('event')} name="metricEvent" required maxLength={100} defaultValue={d.metricEvent} placeholder="purchase" autoCapitalize="off" spellCheck={false} />
            </div>
            <div className="ho-field" style={{ flexBasis: 220 }}>
              <label htmlFor={f('kind')}>Kind</label>
              <select id={f('kind')} name="metricKind" value={kind} onChange={(e) => setKind(e.target.value as 'proportion' | 'mean')}>
                <option value="proportion">Conversion rate (did the unit fire the event)</option>
                <option value="mean">Mean value per unit (sum of the event&apos;s value)</option>
              </select>
            </div>
          </div>

          <div className="ho-field">
            <label htmlFor={f('base')}>{proportion ? "Baseline: today's conversion rate, in %" : 'Baseline mean per unit (optional, shown only)'}</label>
            <input id={f('base')} name="baseline" inputMode="decimal" value={baseline} onChange={(e) => setBaseline(e.target.value)} />
            {proportion && (
              <div className="ho-pills" role="group" aria-label="Common baselines">
                {BASELINES.map((b) => (
                  <button key={b} type="button" className="ho-pill" aria-pressed={same(baseline, b)} onClick={() => setBaseline(b)}>{b}%</button>
                ))}
              </div>
            )}
          </div>
          {!proportion && (
            <div className="ho-field">
              <label htmlFor={f('sd')}>Standard deviation per unit</label>
              <input id={f('sd')} name="sd" inputMode="decimal" value={sd} onChange={(e) => setSd(e.target.value)} required />
            </div>
          )}
          {proportion && <input type="hidden" name="sd" value="" />}
          <div className="ho-field">
            <label htmlFor={f('mde')}>{proportion ? 'Minimum detectable effect: the smallest lift worth detecting, in percentage points' : 'Minimum detectable effect: the smallest change worth detecting, in metric units'}</label>
            <input id={f('mde')} name="mde" required inputMode="decimal" value={mde} onChange={(e) => setMde(e.target.value)} aria-describedby={f('mde-help')} />
            {proportion && (
              <div className="ho-pills" role="group" aria-label="Common minimum detectable effects">
                {MDES.map((m) => (
                  <button key={m} type="button" className="ho-pill" aria-pressed={same(mde, m)} onClick={() => setMde(m)}>+{m} pts</button>
                ))}
              </div>
            )}
            <span id={f('mde-help')} className="ho-help">Negative when lower is better. Planned at 80% power and 95% confidence, then doubled for the sequential readout (D-16).</span>
          </div>
        </section>

        <section className="ho-card" aria-labelledby={f('guards')}>
          <h2 id={f('guards')}>Guardrails <span className="ho-help">(optional, up to {LIMITS.maxGuardrails})</span></h2>
          <p className="ho-help" style={{ margin: 0 }}>Metrics that must not move. If one moves either way for the winner, the readout holds the ship for a person to review.</p>
          {guards.length > 0 && (
            <div className="ho-guards">
              {guards.map((g, i) => (
                <GuardRow key={i} i={i} g={g} set={setG} remove={() => setGuards((gs) => gs.filter((_, j) => j !== i))} />
              ))}
            </div>
          )}
          <button type="button" className="ho-btn-add" style={{ alignSelf: 'flex-start' }} disabled={guards.length >= LIMITS.maxGuardrails} onClick={() => setGuards((gs) => [...gs, { event: '', kind: 'proportion' }])}>
            + Add guardrail
          </button>
        </section>
      </div>

      <aside className="ho-dark ho-aside" aria-labelledby={f('plan')}>
        <h2 id={f('plan')} className="ho-eyebrow">Planned sample</h2>
        {'plan' in pv ? (
          <>
            <span className="ho-big" data-testid="planned-per-arm">{fmt(pv.plan.plannedUnitsPerArm)}</span>
            <span>units per arm · {fmt(pv.plan.plannedTotalUnits)} in total</span>
            <span className="ho-dim" style={{ fontSize: 14 }}>
              That&apos;s 2× the fixed-horizon size ({fmt(pv.plan.fixedUnitsPerArm)} per arm), so you can check daily without inflating false wins.
              {pv.target !== null && <> At {Number((pv.baseline * 100).toFixed(4))}% → {Number((pv.target * 100).toFixed(4))}%,</>} 95% confidence, 80% power.
            </span>
          </>
        ) : (
          <>
            <span className="ho-big" aria-hidden="true">—</span>
            <span className="ho-dim" style={{ fontSize: 14 }}>{pv.error}</span>
          </>
        )}
        <span className="ho-sr-only" aria-live="polite" aria-atomic="true">
          {'plan' in pv ? `Planned sample: ${fmt(pv.plan.plannedUnitsPerArm)} units per arm, ${fmt(pv.plan.plannedTotalUnits)} in total.` : ''}
        </span>
        <button type="submit" className="ho-btn ho-btn-accent" style={{ marginTop: 6 }}>{submitLabel}</button>
        <span className="ho-dim" style={{ fontSize: 13 }}>Saved as a draft: nothing receives traffic until an owner or admin starts it.</span>
      </aside>
    </div>
  );
}

function VariantRow({ i, v, first, canRemove, set, remove }: { i: number; v: DesignDefaults['variants'][number]; first: boolean; canRemove: boolean; set: (i: number, k: 'key' | 'name' | 'weight', value: string) => void; remove: () => void }) {
  const label = `Variant ${i + 1}`;
  return (
    <>
      <input className="ho-input ho-vkey" name="variantKeys[]" maxLength={64} value={v.key} onChange={(e) => set(i, 'key', e.target.value)} aria-label={`${label} key${first ? ' (control)' : ''}`} placeholder={first ? 'control' : 'treatment'} autoCapitalize="off" spellCheck={false} />
      <input className="ho-input" name="variantNames[]" maxLength={80} value={v.name} onChange={(e) => set(i, 'name', e.target.value)} aria-label={`${label} name`} />
      <input className="ho-input" name="variantWeights[]" inputMode="decimal" value={v.weight} onChange={(e) => set(i, 'weight', e.target.value)} aria-label={`${label} weight`} />
      {canRemove ? (
        <button type="button" className="ho-btn-x" onClick={remove} aria-label={`Remove ${label.toLowerCase()}`}>×</button>
      ) : <span aria-hidden="true" />}
    </>
  );
}

function GuardRow({ i, g, set, remove }: { i: number; g: DesignDefaults['guardrails'][number]; set: (i: number, k: 'event' | 'kind', value: string) => void; remove: () => void }) {
  const label = `Guardrail ${i + 1}`;
  return (
    <>
      <input className="ho-input" name="guardrailEvents[]" maxLength={100} value={g.event} onChange={(e) => set(i, 'event', e.target.value)} aria-label={`${label} event`} placeholder="refund" autoCapitalize="off" spellCheck={false} />
      <select className="ho-input" name="guardrailKinds[]" value={g.kind} onChange={(e) => set(i, 'kind', e.target.value)} aria-label={`${label} kind`}>
        <option value="proportion">Conversion rate</option>
        <option value="mean">Mean value</option>
      </select>
      <button type="button" className="ho-btn-x" onClick={remove} aria-label={`Remove ${label.toLowerCase()}`}>×</button>
    </>
  );
}
