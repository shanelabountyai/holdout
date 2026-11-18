import type { Readout } from '@/lib/holdout/readout';
import type { Series } from '@/lib/holdout/look-series';
import { LookChart } from './look-chart';
import { effect, Glyph, interval, level, n, p4, pctBps, STATE, Status, utc } from './ui';

// The readout (PRD "Readout page", Phase 3) in the design's layout: the decision in words first (Main.dc.html, States.dc.html),
// then the numbers behind it. Under SRM only the split is shown (Srm.dc.html; HO-04, D-33). Headlines and details are the
// readout's own words, so a stored readout (HO-05) reads exactly as it did when the experiment stopped.

const verdict = { better: 'better than control', worse: 'worse than control', undecided: 'no decision yet' } as const;

export function DecisionBanner({ r, stored, action }: { r: Readout; stored: boolean; action?: React.ReactNode }) {
  const s = STATE[r.decision.state];
  const srm = r.decision.state === 'srm';
  return (
    <section aria-labelledby="decision" className={`ho-banner ho-tone-${s.tone}`} data-tone={s.tone}>
      <div className="ho-banner-text">
        <h2 id="decision" className="ho-eyebrow" style={{ margin: 0 }}>Decision</h2>
        <p className="ho-headline">
          <Glyph g={s.glyph} />
          <span role={srm ? 'alert' : 'status'} data-decision={r.decision.state}>{r.decision.headline}</span>
        </p>
        <p>{r.decision.detail}</p>
        <p style={{ fontSize: 13 }}>
          {stored ? 'Final readout, recorded when the experiment stopped' : 'As of'} {utc(r.asOf)} · {r.looks} {r.looks === 1 ? 'look' : 'looks'} (one per day)
        </p>
      </div>
      {action}
    </section>
  );
}

function armLabel(r: Readout, i: number) {
  const a = r.arms[i]!;
  const role = i === 0 ? 'Control' : r.arms.length > 2 ? `Treatment ${i}` : 'Treatment';
  return <>{role}: {a.name} <code className="ho-help">{a.key}</code></>;
}

/** Srm.dc.html: what can still be shown while the split is broken. */
export function SrmView({ r }: { r: Readout }) {
  const split = r.arms.map((a) => pctBps(a.weight).replace('%', '')).join('/');
  return (
    <>
      <section aria-labelledby="units" className="ho-card ho-card-flush">
        <h2 id="units">What we can still show</h2>
        <table className="ho-table" style={{ minWidth: 520 }}>
          <thead><tr><th scope="col">Arm</th><th scope="col" className="num">Units seen</th><th scope="col" className="num">Units expected</th><th scope="col" className="num">Difference</th></tr></thead>
          <tbody>
            {r.arms.map((a, i) => {
              const e = Math.round(r.srm.expected[i] ?? 0);
              const d = a.units - e;
              return (
                <tr key={a.key}>
                  <td className="arm">{armLabel(r, i)}</td>
                  <td className="num">{n(a.units)}</td>
                  <td className="num">{n(e)}</td>
                  <td className="num">{d >= 0 ? '+' : '−'}{n(Math.abs(d))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p>χ² test for a {split} split: χ² = {r.srm.chi2.toFixed(2)}, df {r.srm.df}, p = {p4(r.srm.p)}, below the 0.001 stop line (HO-04).</p>
      </section>
      <section aria-labelledby="hidden" className="ho-card ho-card-dashed">
        <h2 id="hidden" style={{ fontSize: 15 }}>Hidden while the split is broken</h2>
        <p className="ho-small">Conversion rates · effect and interval · guardrails · daily looks</p>
      </section>
    </>
  );
}

function SrmCard({ r }: { r: Readout }) {
  const total = r.arms.reduce((s, a) => s + a.units, 0);
  const planned = r.arms.map((a) => pctBps(a.weight).replace('%', '')).join(' / ');
  const observed = total ? r.arms.map((a) => ((100 * a.units) / total).toFixed(1)).join(' / ') : null;
  return (
    <section aria-labelledby="srm" className="ho-card">
      <h2 id="srm">Sample-ratio check</h2>
      <div className="ho-kv">
        <span>Split {planned}{observed ? <>, observed {observed}</> : ', no units yet'}</span>
        {r.srm.checkable === false ? (
          <Status tone="hold" glyph="◐">Not yet checkable</Status>
        ) : (
          <Status tone="good" glyph="✓">Passed</Status>
        )}
      </div>
      {r.srm.checkable === false ? (
        // `=== false`: readouts stored before D-41 have no `checkable` and keep their original wording.
        <p className="ho-small">
          SRM not yet checkable: {n(total)} of {n(r.srm.minTotalUnits)} units, the sample at which an 8% loss of one arm&apos;s exposures would be detected (p &lt; 0.001, 80% power; D-41). No variant ships until then.
        </p>
      ) : r.srm.minTotalUnits ? (
        <p className="ho-small">Checkable from {n(r.srm.minTotalUnits)} units (enough to catch an 8% exposure loss with 80% power). This test has {n(total)}.</p>
      ) : (
        <p className="ho-small">The split matches the weights.</p>
      )}
      <p className="ho-note">χ² = {r.srm.chi2.toFixed(2)}, df {r.srm.df}, p = {p4(r.srm.p)}; the readout stops below p 0.001 (HO-04).</p>
    </section>
  );
}

function GuardrailCard({ r, events }: { r: Readout; events: string[] }) {
  const name = (key: string) => r.arms.find((a) => a.key === key)?.name ?? key;
  const many = r.arms.length > 2;
  return (
    <section aria-labelledby="gr" className="ho-card">
      <h2 id="gr">Guardrails</h2>
      {!events.length ? (
        <p className="ho-small">None for this experiment.</p>
      ) : !r.guardrails ? (
        <>
          {events.map((e) => (
            <div className="ho-kv" key={e}><code>{e}</code><Status tone="neutral" glyph="○">Waiting for data</Status></div>
          ))}
          <p className="ho-note">Checked once every arm has 100 units.</p>
        </>
      ) : (
        <>
          {r.guardrails.flatMap((g) =>
            g.comparisons.map((c) => {
              const v = level(g.kind, g.arms.find((a) => a.variant === c.variant)?.level ?? null);
              const ctl = level(g.kind, g.arms[0]?.level ?? null);
              return (
                <div className="ho-kv" key={`${g.event}-${c.variant}`} data-guardrail={g.event}>
                  <span><code>{g.event}</code>{many && <> · {name(c.variant)}</>}</span>
                  {c.moved ? (
                    <Status tone="hold" glyph="◐">Moved {c.moved} · {v} vs {ctl} control</Status>
                  ) : g.tau2 === null ? (
                    <Status tone="neutral" glyph="○">Waiting for data</Status>
                  ) : (
                    <Status tone="good" glyph="✓">Held · {v} vs {ctl} control</Status>
                  )}
                </div>
              );
            }),
          )}
          <p className="ho-note">A guardrail that moves either way holds a ship until someone reviews it (D-31).</p>
        </>
      )}
    </section>
  );
}

export function ReadoutView({ r, series, guardrailEvents }: { r: Readout; series: Series[]; guardrailEvents: string[] }) {
  const name = (key: string) => r.arms.find((a) => a.key === key)?.name ?? key;
  const kind = r.metricKind;
  const cmp = new Map((r.comparisons ?? []).map((c) => [c.variant, c]));
  const conf = r.comparisons?.[0] ? Math.round((1 - r.comparisons[0].alpha) * 1000) / 10 : Math.round((1 - r.alpha / Math.max(1, r.arms.length - 1)) * 1000) / 10;
  const charted = series.filter((s) => s.points.length);
  return (
    <>
      {r.decision.state === 'inconclusive' && r.comparisons && (
        <p className="ho-small" data-reference="fixed-horizon" style={{ margin: 0 }}>
          {r.comparisons.filter((c) => c.fixed).map((c) => `${name(c.variant)}: fixed-horizon p = ${p4(c.fixed!.p)}`).join('; ')}{' '}
          — <strong>reference only, not a decision</strong>. The decision is the sequential test&apos;s.
        </p>
      )}

      <section aria-labelledby="arms" className="ho-card ho-card-flush">
        <h2 id="arms">Primary metric: <code>{r.metricEvent}</code> ({kind === 'proportion' ? 'conversion' : 'mean per unit'})</h2>
        <table className="ho-table" style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th scope="col">Arm</th>
              <th scope="col" className="num">Units</th>
              {kind === 'proportion' && <th scope="col" className="num">Conversions</th>}
              <th scope="col" className="num">{kind === 'proportion' ? 'Rate' : 'Mean per unit'}</th>
              <th scope="col" className="num">Effect vs control</th>
              <th scope="col">Always-valid {conf}% interval</th>
            </tr>
          </thead>
          <tbody>
            {r.arms.map((a, i) => {
              const c = i ? cmp.get(a.key) : undefined;
              return (
                <tr key={a.key}>
                  <td className="arm">{armLabel(r, i)}</td>
                  <td className="num">{n(a.units)}</td>
                  {kind === 'proportion' && <td className="num">{a.level === null ? '—' : n(Math.round(a.level * a.units))}</td>}
                  <td className="num">{level(kind, a.level)}</td>
                  <td className="num" style={c?.verdict === 'better' ? { fontWeight: 600, color: 'var(--ho-good-fg)' } : c?.verdict === 'worse' ? { fontWeight: 600, color: 'var(--ho-stop-fg)' } : undefined}>
                    {c ? <>{effect(kind, c.diff)}{c.verdict !== 'undecided' && <span className="ho-sr-only"> ({verdict[c.verdict]})</span>}</> : '—'}
                  </td>
                  <td>{c ? interval(kind, c.sequential.ciLow, c.sequential.ciHigh) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!r.comparisons && <p>Rates and effects are shown once every arm has 100 units.</p>}
      </section>

      <section aria-labelledby="looks" className="ho-card">
        <h2 id="looks">The interval, every day you looked</h2>
        <p className="ho-small">
          The band is the always-valid interval for the effect. It narrows as data arrives. The test calls a winner only once the whole band clears zero, so checking daily never inflates false wins.
        </p>
        {charted.length ? (
          charted.map((s, i) => <LookChart key={s.variant} id={`chart-${i}`} s={s} kind={kind} looks={r.looks} control={r.arms[0]!.name} />)
        ) : (
          <p className="ho-small"><Status tone="neutral" glyph="○">Nothing to draw yet</Status>: the first point appears at the first daily look where every arm has 100 units.</p>
        )}
      </section>

      <div className="ho-row">
        <GuardrailCard r={r} events={guardrailEvents} />
        <SrmCard r={r} />
      </div>

      <p className="ho-note">
        Fixed-horizon p (reference only, not a decision):{' '}
        {r.comparisons?.some((c) => c.fixed) ? r.comparisons.filter((c) => c.fixed).map((c) => `${r.comparisons!.length > 1 ? `${name(c.variant)} ` : ''}${p4(c.fixed!.p)}`).join('; ') : 'not available yet'}.
        {' '}Planned sample: {n(r.plannedUnitsPerArm)} units per arm, 2× the fixed-horizon size (D-16); smallest arm {n(r.minArmUnits)}.
        {r.comparisons && r.comparisons.length > 1 && <> With {r.comparisons.length} variants against control, each is tested at α / {r.comparisons.length} (Bonferroni).</>}
      </p>

      <details className="ho-details ho-card">
        <summary>All the numbers behind the decision</summary>
        <div style={{ overflowX: 'auto' }}>
          <table className="ho-table ho-table-compact" style={{ minWidth: 560 }}>
            <caption className="ho-sr-only">Arms</caption>
            <thead><tr><th scope="col">Variant</th><th scope="col" className="num">Weight</th><th scope="col" className="num">Units</th><th scope="col" className="num">Expected units</th><th scope="col" className="num">{kind === 'proportion' ? 'Conversion rate' : 'Mean per unit'}</th></tr></thead>
            <tbody>
              {r.arms.map((a, i) => (
                <tr key={a.key}><td>{a.name} <code>{a.key}</code></td><td className="num">{pctBps(a.weight)}</td><td className="num">{n(a.units)}</td><td className="num">{n(Math.round(r.srm.expected[i] ?? 0))}</td><td className="num">{level(kind, a.level, 2)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {r.comparisons && (
          <div style={{ overflowX: 'auto' }}>
            <table className="ho-table ho-table-compact" style={{ minWidth: 900 }}>
              <caption className="ho-sr-only">Each variant against control</caption>
              <thead><tr><th scope="col">Variant vs control</th><th scope="col" className="num">Difference</th><th scope="col" className="num">Relative</th><th scope="col">Always-valid confidence sequence</th><th scope="col" className="num">Always-valid p</th><th scope="col">Fixed-horizon 95% CI (for reference)</th><th scope="col" className="num">Fixed-horizon p (reference only, not a decision)</th><th scope="col">Verdict</th></tr></thead>
              <tbody>
                {r.comparisons.map((c) => (
                  <tr key={c.variant}>
                    <td>{name(c.variant)}</td>
                    <td className="num">{effect(kind, c.diff, '', 2)}</td>
                    <td className="num">{c.relLift === null ? '—' : `${c.relLift >= 0 ? '+' : '−'}${Math.abs(c.relLift * 100).toFixed(1)}%`}</td>
                    <td>{Math.round((1 - c.alpha) * 1000) / 10}%: {interval(kind, c.sequential.ciLow, c.sequential.ciHigh, 2)}</td>
                    <td className="num">{p4(c.sequential.p)}</td>
                    <td>{c.fixed ? <>{effect(kind, c.fixed.ciLow, '', 2)} to {effect(kind, c.fixed.ciHigh, '', 2)}</> : '—'}</td>
                    <td className="num">{c.fixed ? p4(c.fixed.p) : '—'}</td>
                    <td>{verdict[c.verdict]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {r.guardrails && r.guardrails.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="ho-table ho-table-compact" style={{ minWidth: 720 }}>
              <caption className="ho-sr-only">Guardrails</caption>
              <thead><tr><th scope="col">Metric</th><th scope="col">Variant vs control</th><th scope="col" className="num">Control</th><th scope="col" className="num">Variant</th><th scope="col" className="num">Difference</th><th scope="col" className="num">Always-valid p</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {r.guardrails.flatMap((g) =>
                  g.comparisons.map((c) => (
                    <tr key={`${g.event}-${c.variant}`}>
                      <td><code>{g.event}</code></td>
                      <td>{name(c.variant)}</td>
                      <td className="num">{level(g.kind, g.arms[0]?.level ?? null, 2)}</td>
                      <td className="num">{level(g.kind, g.arms.find((a) => a.variant === c.variant)?.level ?? null, 2)}</td>
                      <td className="num">{effect(g.kind, c.diff, '', 2)}</td>
                      <td className="num">{p4(c.sequential.p)}</td>
                      <td>{c.moved ? <strong>moved {c.moved}</strong> : g.tau2 === null ? 'waiting for data' : 'no change detected'}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="ho-small">
          The decision uses the sequential test (mixture SPRT), which stays valid however often this page is checked. The fixed-horizon numbers are only valid once, at the planned sample size; they are shown for reference.
        </p>
      </details>
    </>
  );
}
