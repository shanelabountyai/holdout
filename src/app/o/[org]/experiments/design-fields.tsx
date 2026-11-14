import { LIMITS } from '@/lib/holdout/experiments';

// The design fields shared by "new" and "edit draft". Units are the ones people type: percent for weights and conversion
// rates, percentage points for a conversion MDE, metric units for a mean. Empty variant and guardrail rows are ignored.

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

export function DesignFields({ d }: { d: DesignDefaults }) {
  const rows = Array.from({ length: LIMITS.maxVariants }, (_, i) => d.variants[i] ?? { key: '', name: '', weight: '' });
  const guards = Array.from({ length: LIMITS.maxGuardrails }, (_, i) => d.guardrails[i] ?? { event: '', kind: 'proportion' as const });
  return (
    <>
      <p><label>Name <input name="name" required maxLength={120} defaultValue={d.name} /></label></p>
      <p>
        <label>Key <input name="key" required maxLength={64} pattern="[a-z0-9][a-z0-9_\-]*" defaultValue={d.key} aria-describedby="key-help" /></label>{' '}
        <small id="key-help">what your code sends at ingest, e.g. <code>checkout-button</code></small>
      </p>
      <p><label>Description <textarea name="description" maxLength={2000} defaultValue={d.description} /></label></p>

      <fieldset>
        <legend>Primary metric</legend>
        <p><label>Event name <input name="metricEvent" required maxLength={100} defaultValue={d.metricEvent} /></label></p>
        <p>
          <label>
            Kind{' '}
            <select name="metricKind" defaultValue={d.metricKind}>
              <option value="proportion">Conversion rate (did the unit fire the event)</option>
              <option value="mean">Mean value per unit (sum of the event&apos;s value)</option>
            </select>
          </label>
        </p>
        <p><label>Baseline (conversion rate in %, or the current mean) <input name="baseline" inputMode="decimal" defaultValue={d.baseline} /></label></p>
        <p><label>Standard deviation per unit (mean metrics only) <input name="sd" inputMode="decimal" defaultValue={d.sd} /></label></p>
        <p><label>Minimum detectable effect (percentage points, or metric units for a mean) <input name="mde" required inputMode="decimal" defaultValue={d.mde} /></label></p>
        <p><small>Planned at power 80% and α 5%, then doubled for the sequential readout (D-16).</small></p>
      </fieldset>

      <fieldset>
        <legend>Variants ({LIMITS.minVariants} to {LIMITS.maxVariants}; weights in %, adding up to 100)</legend>
        {rows.map((v, i) => (
          <p key={i}>
            <label>Key <input name="variantKeys[]" maxLength={64} defaultValue={v.key} aria-label={`Variant ${i + 1} key`} /></label>{' '}
            <label>Name <input name="variantNames[]" maxLength={80} defaultValue={v.name} aria-label={`Variant ${i + 1} name`} /></label>{' '}
            <label>Weight % <input name="variantWeights[]" inputMode="decimal" size={6} defaultValue={v.weight} aria-label={`Variant ${i + 1} weight`} /></label>
          </p>
        ))}
        <p><small>The order here is the order units are bucketed in. Weights and order freeze when the experiment starts.</small></p>
      </fieldset>

      <fieldset>
        <legend>Guardrail metrics (optional, up to {LIMITS.maxGuardrails})</legend>
        {guards.map((g, i) => (
          <p key={i}>
            <label>Event <input name="guardrailEvents[]" maxLength={100} defaultValue={g.event} aria-label={`Guardrail ${i + 1} event`} /></label>{' '}
            <select name="guardrailKinds[]" defaultValue={g.kind} aria-label={`Guardrail ${i + 1} kind`}>
              <option value="proportion">Conversion rate</option>
              <option value="mean">Mean value</option>
            </select>
          </p>
        ))}
      </fieldset>
    </>
  );
}
