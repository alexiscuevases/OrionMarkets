import { useMemo } from 'react';

interface Props {
  points: { ts: number; value: number }[];
  /** Línea de referencia (balance inicial / 0R); si se da, colorea la serie. */
  baseline?: number;
  height?: number;
  formatValue?: (v: number) => string;
}

const W = 720;
const PAD = { top: 10, right: 8, bottom: 20, left: 56 };

/** Curva de equity en SVG puro, coherente con el resto del terminal:
    área + línea, referencia del balance inicial y etiquetas mín/máx. */
export default function EquityChart({ points, baseline, height = 180, formatValue }: Props) {
  const fmt = formatValue ?? ((v: number) => v.toLocaleString('es-ES', { maximumFractionDigits: 2 }));

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const values = points.map((p) => p.value);
    const lo = Math.min(...values, baseline ?? Infinity);
    const hi = Math.max(...values, baseline ?? -Infinity);
    const span = hi - lo || 1;
    const t0 = points[0].ts;
    const t1 = points[points.length - 1].ts;
    const tSpan = t1 - t0 || 1;

    const x = (ts: number) => PAD.left + ((ts - t0) / tSpan) * (W - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - (v - lo) / span) * (height - PAD.top - PAD.bottom);

    const pts = points.map((p) => `${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`);
    const line = `M${pts.join(' L')}`;
    const floor = height - PAD.bottom;
    const area = `${line} L${x(t1).toFixed(1)},${floor} L${x(t0).toFixed(1)},${floor} Z`;

    return { lo, hi, line, area, yBase: baseline !== undefined ? y(baseline) : null, t0, t1 };
  }, [points, baseline, height]);

  if (!geo) {
    return <div className="equity-chart equity-chart--empty">Sin datos suficientes para la curva</div>;
  }

  const last = points[points.length - 1].value;
  const up = baseline === undefined || last >= baseline;
  const stroke = up ? 'var(--buy-ink)' : 'var(--sell-ink)';
  const fill = up ? 'var(--buy-glow)' : 'var(--sell-glow)';

  return (
    <div className="equity-chart">
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        {[0.25, 0.5, 0.75].map((f) => {
          const gy = PAD.top + f * (height - PAD.top - PAD.bottom);
          return <line key={f} x1={PAD.left} x2={W - PAD.right} y1={gy} y2={gy} stroke="var(--line-grid)" strokeWidth="1" />;
        })}
        {geo.yBase !== null && (
          <line
            x1={PAD.left} x2={W - PAD.right} y1={geo.yBase} y2={geo.yBase}
            stroke="var(--line-strong)" strokeWidth="1" strokeDasharray="4 4"
          />
        )}
        <path d={geo.area} fill={fill} stroke="none" />
        <path d={geo.line} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="equity-chart__hi num">{fmt(geo.hi)}</span>
      <span className="equity-chart__lo num">{fmt(geo.lo)}</span>
      <span className="equity-chart__t0 num">{new Date(geo.t0).toLocaleDateString('es-ES')}</span>
      <span className="equity-chart__t1 num">{new Date(geo.t1).toLocaleDateString('es-ES')}</span>
    </div>
  );
}
