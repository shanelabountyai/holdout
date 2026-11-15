import type { Readout } from '@/lib/holdout/readout';

// The readout (PRD "Readout page", Phase 3): the decision in words first, then the numbers behind it.

const n = (x: number) => x.toLocaleString('en-US');
const level = (kind: Readout['metricKind'], x: number | null) => (x === null ? '—' : kind === 'proportion' ? `${(x * 100).toFixed(2)}%` : Number(x.toPrecision(6)).toString());
const eff = (kind: Readout['metricKind'], x: number | null, open: string) =>
  x === null ? open : kind === 'proportion' ? `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(2)} pts` : `${x >= 0 ? '+' : '−'}${Number(Math.abs(x).toPrecision(4))}`;
const p = (x: number) => (x < 0.0001 ? '< 0.0001' : x.toFixed(4));
const lift = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`);
const verdict = { better: 'better than control', worse: 'worse than control', undecided: 'no decision yet' } as const;

export function ReadoutView({ r, stored }: { r: Readout; stored: boolean }) {
  const name = (key: string) => r.arms.find((a) => a.key === key)?.name ?? key;
  return (
    <section aria-labelledby="readout">
      <h2 id="readout">Readout</h2>
      <p>
        {stored ? 'Final readout, recorded when the experiment stopped' : 'As of'} {r.asOf.slice(0, 16).replace('T', ' ')} UTC · {r.looks} {r.looks === 1 ? 'look' : 'looks'} (one per day)
      </p>
      <p role="status" data-decision={r.decision.state}>
        <strong>{r.decision.headline}</strong>
      </p>
      <p>{r.decision.detail}</p>

      <h3>Arms</h3>
      <table>
        <thead><tr><th>Variant</th><th>Weight</th><th>Units</th><th>Expected units</th><th>{r.metricKind === 'proportion' ? 'Conversion rate' : 'Mean per unit'} ({r.metricEvent})</th></tr></thead>
        <tbody>
          {r.arms.map((a, i) => (
            <tr key={a.key}><td>{a.name} <code>{a.key}</code></td><td>{(a.weight / 100).toFixed(a.weight % 100 ? 2 : 0)}%</td><td>{n(a.units)}</td><td>{n(Math.round(r.srm.expected[i] ?? 0))}</td><td>{level(r.metricKind, a.level)}</td></tr>
          ))}
        </tbody>
      </table>
      <p>
        Sample-ratio check: χ² = {r.srm.chi2.toFixed(2)}, df {r.srm.df}, p = {p(r.srm.p)} — {r.srm.blocked ? <strong>mismatch (p &lt; 0.001): the readout is blocked (HO-04)</strong> : 'split matches the weights'}.
        {' '}Planned: {n(r.plannedUnitsPerArm)} units per arm; smallest arm {n(r.minArmUnits)}.
      </p>

      {r.comparisons && (
        <>
          <h3>Primary metric: {r.metricEvent}</h3>
          <table>
            <thead><tr><th>Variant vs control</th><th>Difference</th><th>Relative</th><th>Always-valid confidence sequence</th><th>Always-valid p</th><th>Fixed-horizon 95% CI (for reference)</th><th>Fixed-horizon p</th><th>Verdict</th></tr></thead>
            <tbody>
              {r.comparisons.map((c) => (
                <tr key={c.variant}>
                  <td>{name(c.variant)}</td>
                  <td>{eff(r.metricKind, c.diff, '')}</td>
                  <td>{lift(c.relLift)}</td>
                  <td>{Math.round((1 - c.alpha) * 1000) / 10}%: {eff(r.metricKind, c.sequential.ciLow, '−∞')} to {eff(r.metricKind, c.sequential.ciHigh, '+∞')}</td>
                  <td>{p(c.sequential.p)}</td>
                  <td>{c.fixed ? <>{eff(r.metricKind, c.fixed.ciLow, '')} to {eff(r.metricKind, c.fixed.ciHigh, '')}</> : '—'}</td>
                  <td>{c.fixed ? p(c.fixed.p) : '—'}</td>
                  <td>{verdict[c.verdict]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            The decision uses the sequential test (mixture SPRT), which stays valid however often this page is checked. The fixed-horizon
            numbers are only valid once, at the planned sample size; they are shown for reference.
            {r.comparisons.length > 1 && <> With {r.comparisons.length} variants against control, each is tested at α / {r.comparisons.length} (Bonferroni).</>}
          </p>
        </>
      )}

      {r.guardrails && r.guardrails.length > 0 && (
        <>
          <h3>Guardrails</h3>
          <table>
            <thead><tr><th>Metric</th><th>Variant vs control</th><th>Control</th><th>Variant</th><th>Difference</th><th>Always-valid p</th><th>Status</th></tr></thead>
            <tbody>
              {r.guardrails.flatMap((g) =>
                g.comparisons.map((c) => (
                  <tr key={`${g.event}-${c.variant}`}>
                    <td><code>{g.event}</code></td>
                    <td>{name(c.variant)}</td>
                    <td>{level(g.kind, g.arms[0]?.level ?? null)}</td>
                    <td>{level(g.kind, g.arms.find((a) => a.variant === c.variant)?.level ?? null)}</td>
                    <td>{eff(g.kind, c.diff, '')}</td>
                    <td>{p(c.sequential.p)}</td>
                    <td>{c.moved ? <strong>moved {c.moved}</strong> : g.tau2 === null ? 'waiting for data' : 'no change detected'}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          <p>A guardrail that moves in either direction holds a ship until someone reviews it.</p>
        </>
      )}
    </section>
  );
}
