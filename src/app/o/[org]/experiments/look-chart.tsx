import type { Kind } from '@/lib/holdout/readout';
import { firstClear, type Series } from '@/lib/holdout/look-series';
import { effect, interval } from './ui';

// "The interval, every day you looked" (Main.dc.html): the always-valid confidence sequence after each daily look, drawn as
// a band around the observed difference, with the look where the whole band first clears zero marked. Server-rendered SVG;
// the same numbers are in a table under it, so nothing is only in the picture.

const W = 720;
const H = 240;
const X0 = 96;
const X1 = 700;
const Y0 = 24;
const Y1 = 216;

export function LookChart({ s, kind, looks, control, id, ships = false }: { s: Series; kind: Kind; looks: number; control: string; id: string; ships?: boolean }) {
  const scale = kind === 'proportion' ? 100 : 1;
  const pts = s.points;
  if (!pts.length) return null;
  const finite = pts.flatMap((p) => [p.diff, p.ciLow, p.ciHigh]).filter((v): v is number => v !== null).map((v) => v * scale);
  let lo = Math.min(0, ...finite);
  let hi = Math.max(0, ...finite);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const x = (look: number) => (looks <= 1 ? (X0 + X1) / 2 : X0 + ((look - 1) * (X1 - X0)) / (looks - 1));
  const y = (v: number | null, open: number) => {
    const c = v === null ? open : Math.min(hi, Math.max(lo, v * scale));
    return Y0 + ((hi - c) * (Y1 - Y0)) / (hi - lo);
  };
  const up = pts.map((p) => [x(p.look), y(p.ciHigh, hi)] as const);
  const dn = pts.map((p) => [x(p.look), y(p.ciLow, lo)] as const);
  const md = pts.map((p) => [x(p.look), y(p.diff, 0)] as const);
  const line = (a: readonly (readonly [number, number])[]) => a.map(([a1, b]) => `${a1.toFixed(1)},${b.toFixed(1)}`).join(' ');
  const zeroY = y(0, 0);
  const clear = firstClear(pts);
  const step = Math.max(1, Math.ceil(looks / 14));
  const ticks = Array.from({ length: looks }, (_, i) => i + 1).filter((d) => (d - 1) % step === 0 || d === looks);
  const unit = kind === 'proportion' ? ' pts' : '';
  const fmt = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(kind === 'proportion' ? 1 : 2)}${unit}`;
  const first = pts[0]!;
  const last = pts.at(-1)!;
  const label =
    `Effect of ${s.name} against ${control}, always-valid interval by day: ${interval(kind, first.ciLow, first.ciHigh)} on day ${first.look}` +
    (pts.length > 1 ? `, ${interval(kind, last.ciLow, last.ciHigh)} by day ${last.look}` : '') +
    (clear ? `; the whole interval first clears zero on day ${clear.look}.` : '; the interval has not cleared zero.');
  const clearX = clear ? x(clear.look) : 0;
  const textRight = clearX > X1 - 200;
  return (
    <figure style={{ margin: 0 }} aria-labelledby={`${id}-cap`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="ho-chart">
        <line x1={X0} y1={zeroY} x2={X1} y2={zeroY} stroke="#16181D" strokeWidth="1.5" />
        <text x={X0 - 8} y={zeroY + 4} textAnchor="end" fontSize="12" fill="#3E434D">0</text>
        <text x={X0 - 8} y={Y0 + 4} textAnchor="end" fontSize="12" fill="#3E434D">{fmt(hi)}</text>
        <text x={X0 - 8} y={Y1 + 4} textAnchor="end" fontSize="12" fill="#3E434D">{fmt(lo)}</text>
        {pts.length > 1 ? (
          <polygon points={line([...up, ...[...dn].reverse()])} fill="#1D4F91" fillOpacity="0.16" stroke="none" />
        ) : (
          <line x1={up[0]![0]} y1={up[0]![1]} x2={dn[0]![0]} y2={dn[0]![1]} stroke="#1D4F91" strokeOpacity="0.4" strokeWidth="10" />
        )}
        <polyline points={line(up)} fill="none" stroke="#1D4F91" strokeWidth="1.5" />
        <polyline points={line(dn)} fill="none" stroke="#1D4F91" strokeWidth="1.5" />
        <polyline points={line(md)} fill="none" stroke="#1D4F91" strokeWidth="2.5" />
        {md.map(([a, b], i) => <circle key={i} cx={a} cy={b} r="3" fill="#1D4F91" />)}
        {clear && (
          <>
            <line x1={clearX} y1={20} x2={clearX} y2={Y1} stroke="#565B66" strokeDasharray="4 4" />
            <text x={textRight ? clearX - 6 : clearX + 6} y={34} textAnchor={textRight ? 'end' : 'start'} fontSize="12" fill="#16181D">
              Day {clear.look}: band clears zero{ships ? ' → Ship' : ''}
            </text>
          </>
        )}
        {ticks.map((d, i) => (
          <text key={d} x={x(d)} y={236} textAnchor="middle" fontSize="11" fill="#3E434D" className={i === 0 || d === looks || i % 3 === 0 ? undefined : 'ho-minor'}>D{d}</text>
        ))}
      </svg>
      <figcaption id={`${id}-cap`} className="ho-note">
        {s.name} against {control}. Thick line: observed difference; band: always-valid {Math.round((1 - s.alpha) * 1000) / 10}% interval. An open end (no bound yet) is drawn to the edge.
      </figcaption>
      <details className="ho-details">
        <summary>The numbers by day</summary>
        <div className="ho-scroll" tabIndex={0} role="region" aria-label={`${s.name}: the numbers by day`}>
          <table className="ho-table ho-table-compact">
            <caption className="ho-sr-only">{s.name} against {control}, by daily look</caption>
            <thead><tr><th scope="col">Day</th><th scope="col" className="num">Difference</th><th scope="col">Always-valid interval</th><th scope="col">Clears zero</th></tr></thead>
            <tbody>
              {pts.map((p) => {
                const c = (p.ciLow !== null && p.ciLow > 0) || (p.ciHigh !== null && p.ciHigh < 0);
                return (
                  <tr key={p.look}>
                    <td>D{p.look}</td>
                    <td className="num">{effect(kind, p.diff, '—', 2)}</td>
                    <td>{interval(kind, p.ciLow, p.ciHigh, 2)}</td>
                    <td>{c ? 'Yes' : 'No'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
