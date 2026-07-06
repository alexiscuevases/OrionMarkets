interface Props {
  data: number[];
  width?: number;
  height?: number;
  stroke: string;
  fill?: string;
}

/** Mini-gráfico de línea en SVG puro para watchlist y cards. */
export default function Sparkline({ data, width = 72, height = 24, stroke, fill }: Props) {
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = 2;

  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const line = `M${pts.join(' L')}`;
  const area = `${line} L${width - pad},${height - pad} L${pad},${height - pad} Z`;

  return (
    <svg width={width} height={height} aria-hidden="true">
      {fill && <path d={area} fill={fill} stroke="none" />}
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}
