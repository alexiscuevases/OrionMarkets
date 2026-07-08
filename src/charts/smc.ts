import type Highcharts from 'highcharts/highstock';
import { ORION } from './orionTheme';
import type { Candle } from '../data/market';

/* Capa Smart Money Concepts sobre el gráfico:

   - Zona institucional (order block): la última vela contraria antes de un
     impulso fuerte; ahí quedaron órdenes institucionales sin ejecutar que
     suelen defender el precio cuando lo retestea. Solo zonas sin mitigar
     (ningún cierre posterior las atravesó) y por delante del precio.
   - Liquidez: máximos/mínimos iguales (2+ toques) aún no barridos; imanes
     de precio donde se acumulan los stops.
   - Movimiento probable: proyección desde el último cierre hacia la
     liquidez/zona más cercana en la dirección dominante (la de la señal en
     foco, o la de las EMAs 20/50 si no hay señal).

   Todo es determinista sobre las velas cargadas. El dibujo usa el renderer
   de Highcharts en el evento `render`, así sobrevive a zoom y navegación. */

export interface SmcZone {
  kind: 'demand' | 'supply';
  from: number; // ts de la vela origen
  low: number;
  high: number;
}

export interface LiquidityLevel {
  side: 'buy' | 'sell'; // buy-side: sobre máximos iguales; sell-side: bajo mínimos
  price: number;
  touches: number;
  from: number;
}

export interface SmcProjection {
  direction: 'up' | 'down';
  from: number;  // ts del último cierre
  price: number; // último cierre
  target: number;
  pips: number;
}

export interface SmcAnalysis {
  zones: SmcZone[];
  liquidity: LiquidityLevel[];
  projection: SmcProjection | null;
}

const LOOKBACK = 240;      // velas analizadas
const IMPULSE_ATR = 1.6;   // movimiento mínimo (en ATR) para considerar impulso
const ZONE_MAX_ATR = 1.5;  // alto máximo de una zona (en ATR)
const CLUSTER_TOL_ATR = 0.3; // tolerancia para considerar máximos/mínimos "iguales"

export function computeSmc(
  candles: Candle[],
  pip: number,
  bias: 'buy' | 'sell' | null = null,
): SmcAnalysis {
  const empty: SmcAnalysis = { zones: [], liquidity: [], projection: null };
  if (candles.length < 40) return empty;

  const win = candles.slice(-Math.min(LOOKBACK, candles.length));
  const close = win[win.length - 1][4];

  // ATR medio de la ventana: dimensiona zonas, tolerancias e impulsos
  let trSum = 0;
  for (let i = 1; i < win.length; i++) {
    const prevClose = win[i - 1][4];
    trSum += Math.max(
      win[i][2] - win[i][3],
      Math.abs(win[i][2] - prevClose),
      Math.abs(win[i][3] - prevClose),
    );
  }
  const atr = trSum / (win.length - 1);
  if (atr <= 0) return empty;

  const zones = findOrderBlocks(win, atr, close);
  const liquidity = findLiquidity(win, atr, close);
  const projection = buildProjection(win, pip, bias, zones, liquidity);
  return { zones, liquidity, projection };
}

/* ---------- zonas institucionales (order blocks) ---------- */

function findOrderBlocks(win: Candle[], atr: number, close: number): SmcZone[] {
  const raw: SmcZone[] = [];
  for (let i = 0; i < win.length - 3; i++) {
    const [ts, open, high, low, c] = win[i];
    const move = win[i + 3][4] - c;

    if (c < open && move >= IMPULSE_ATR * atr) {
      // vela bajista + impulso alcista → zona de demanda (low..open)
      const zHigh = Math.min(open, low + ZONE_MAX_ATR * atr);
      raw.push({ kind: 'demand', from: ts, low, high: zHigh });
    } else if (c > open && -move >= IMPULSE_ATR * atr) {
      // vela alcista + impulso bajista → zona de oferta (open..high)
      const zLow = Math.max(open, high - ZONE_MAX_ATR * atr);
      raw.push({ kind: 'supply', from: ts, low: zLow, high });
    }
  }

  // sin mitigar (ningún cierre posterior la atravesó) y por delante del precio
  const valid = raw.filter((z) => {
    for (const c2 of win) {
      if (c2[0] <= z.from) continue;
      if (z.kind === 'demand' && c2[4] < z.low) return false;
      if (z.kind === 'supply' && c2[4] > z.high) return false;
    }
    return z.kind === 'demand' ? z.high <= close : z.low >= close;
  });

  // por lado, las 2 más cercanas al precio y sin solaparse entre sí
  const nearest = (kind: SmcZone['kind']): SmcZone[] => {
    const sorted = valid
      .filter((z) => z.kind === kind)
      .sort((a, b) => (kind === 'demand' ? b.high - a.high : a.low - b.low));
    const picked: SmcZone[] = [];
    for (const z of sorted) {
      if (picked.length >= 2) break;
      if (picked.some((p) => z.low <= p.high && z.high >= p.low)) continue;
      picked.push(z);
    }
    return picked;
  };

  return [...nearest('demand'), ...nearest('supply')];
}

/* ---------- liquidez (máximos/mínimos iguales sin barrer) ---------- */

function findLiquidity(win: Candle[], atr: number, close: number): LiquidityLevel[] {
  const tol = CLUSTER_TOL_ATR * atr;
  const wing = 3;

  const pivots = (idx: 2 | 3): { price: number; ts: number }[] => {
    const out: { price: number; ts: number }[] = [];
    for (let i = wing; i < win.length - wing; i++) {
      let extreme = true;
      for (let j = i - wing; j <= i + wing && extreme; j++) {
        if (j === i) continue;
        if (idx === 2 ? win[j][2] >= win[i][2] : win[j][3] <= win[i][3]) extreme = false;
      }
      if (extreme) out.push({ price: win[i][idx], ts: win[i][0] });
    }
    return out;
  };

  const cluster = (
    points: { price: number; ts: number }[],
    side: LiquidityLevel['side'],
  ): LiquidityLevel[] => {
    const sorted = [...points].sort((a, b) => a.price - b.price);
    const out: LiquidityLevel[] = [];
    let group: { price: number; ts: number }[] = [];

    const flush = () => {
      if (group.length < 2) { group = []; return; }
      const level = side === 'buy'
        ? Math.max(...group.map((p) => p.price))
        : Math.min(...group.map((p) => p.price));
      const lastTouch = Math.max(...group.map((p) => p.ts));
      // barrida si un extremo posterior al último toque superó el nivel
      const swept = win.some((c) =>
        c[0] > lastTouch && (side === 'buy' ? c[2] > level : c[3] < level));
      // solo liquidez por delante del precio
      const ahead = side === 'buy' ? level > close : level < close;
      if (!swept && ahead) {
        out.push({ side, price: level, touches: group.length, from: Math.min(...group.map((p) => p.ts)) });
      }
      group = [];
    };

    for (const p of sorted) {
      if (group.length === 0 || p.price - group[group.length - 1].price <= tol) group.push(p);
      else { flush(); group = [p]; }
    }
    flush();

    // las 2 más cercanas al precio por lado
    return out
      .sort((a, b) => Math.abs(a.price - close) - Math.abs(b.price - close))
      .slice(0, 2);
  };

  return [...cluster(pivots(2), 'buy'), ...cluster(pivots(3), 'sell')];
}

/* ---------- movimiento probable ---------- */

function buildProjection(
  win: Candle[],
  pip: number,
  bias: 'buy' | 'sell' | null,
  zones: SmcZone[],
  liquidity: LiquidityLevel[],
): SmcProjection | null {
  const last = win[win.length - 1];
  const close = last[4];

  let dir: 'up' | 'down';
  if (bias) {
    dir = bias === 'buy' ? 'up' : 'down';
  } else {
    const closes = win.map((c) => c[4]);
    dir = emaLast(closes, 20) >= emaLast(closes, 50) ? 'up' : 'down';
  }

  // objetivo: la liquidez más cercana en la dirección; si no hay, el borde
  // de la zona contraria más cercana (el precio busca donde hay órdenes)
  const targets: number[] = [];
  if (dir === 'up') {
    targets.push(...liquidity.filter((l) => l.side === 'buy').map((l) => l.price));
    targets.push(...zones.filter((z) => z.kind === 'supply').map((z) => z.low));
  } else {
    targets.push(...liquidity.filter((l) => l.side === 'sell').map((l) => l.price));
    targets.push(...zones.filter((z) => z.kind === 'demand').map((z) => z.high));
  }
  const ahead = targets.filter((t) => (dir === 'up' ? t > close : t < close));
  if (ahead.length === 0) return null;

  const target = dir === 'up' ? Math.min(...ahead) : Math.max(...ahead);
  const pips = Math.round(Math.abs(target - close) / pip);
  if (pips < 1) return null;

  return { direction: dir, from: last[0], price: close, target, pips };
}

function emaLast(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1];
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

/* ---------- dibujo con el renderer ---------- */

const FILLS = {
  demand: 'rgba(43, 171, 99, 0.10)',
  supply: 'rgba(229, 72, 77, 0.10)',
};
const EDGES = {
  demand: 'rgba(43, 171, 99, 0.45)',
  supply: 'rgba(229, 72, 77, 0.45)',
};
const LIQ_FILL = 'rgba(240, 180, 41, 0.14)';

interface SmcLayer { under: Highcharts.SVGElement; over: Highcharts.SVGElement; }
const layers = new WeakMap<Highcharts.Chart, SmcLayer>();

/** Redibuja la capa SMC; llamar en el evento `render` del gráfico. */
export function drawSmc(
  chart: Highcharts.Chart,
  analysis: SmcAnalysis | null,
  stepMs: number,
): void {
  const prev = layers.get(chart);
  if (prev) {
    prev.under.destroy();
    prev.over.destroy();
    layers.delete(chart);
  }
  if (!analysis) return;

  const xAxis = chart.xAxis[0];
  const yAxis = chart.yAxis[0];
  const r = chart.renderer;
  const left = chart.plotLeft;
  const right = chart.plotLeft + chart.plotWidth;
  const top = yAxis.toPixels(yAxis.max ?? 0, false);
  const bottom = yAxis.toPixels(yAxis.min ?? 0, false);
  const clampY = (y: number) => Math.max(top, Math.min(bottom, y));

  // zonas y bandas por debajo de las velas; trazos y textos por encima
  const under = r.g('smc-under').attr({ zIndex: 2 }).add();
  const over = r.g('smc-over').attr({ zIndex: 6 }).add();
  layers.set(chart, { under, over });

  const label = (text: string, x: number, y: number, color: string) =>
    r.text(text, x, y)
      .css({ color, fontSize: '8px', fontFamily: ORION.fontData, letterSpacing: '0.08em' })
      .add(over);

  for (const z of analysis.zones) {
    const x = Math.max(xAxis.toPixels(z.from, false), left);
    if (x >= right) continue;
    const y1 = clampY(yAxis.toPixels(z.high, false));
    const y2 = clampY(yAxis.toPixels(z.low, false));
    if (y2 - y1 < 1) continue;

    r.rect(x, y1, right - x, y2 - y1)
      .attr({ fill: FILLS[z.kind], zIndex: 2 })
      .add(under);
    r.path([['M', x, y1], ['L', x, y2]] as unknown as Highcharts.SVGPathArray)
      .attr({ stroke: EDGES[z.kind], 'stroke-width': 2 })
      .add(over);
    if (right - x > 96 && y2 - y1 > 11) {
      label('ZONA INSTITUCIONAL', x + 6, y1 + 11, z.kind === 'demand' ? ORION.buyInk : ORION.sellInk);
    }
  }

  for (const l of analysis.liquidity) {
    const y = yAxis.toPixels(l.price, false);
    if (y < top || y > bottom) continue;
    const x = Math.max(xAxis.toPixels(l.from, false), left);
    if (x >= right) continue;

    r.rect(x, y - 2, right - x, 4).attr({ fill: LIQ_FILL }).add(under);
    r.path([['M', x, y], ['L', right, y]] as unknown as Highcharts.SVGPathArray)
      .attr({ stroke: ORION.star, 'stroke-width': 1, dashstyle: 'ShortDot', opacity: 0.7 })
      .add(over);
    if (right - x > 70) {
      label(`LIQUIDEZ ×${l.touches}`, x + 6, y - 5, ORION.star);
    }
  }

  const p = analysis.projection;
  if (p) {
    const x1 = xAxis.toPixels(p.from, false);
    const x2 = Math.min(xAxis.toPixels(p.from + stepMs * 4, false), right - 6);
    const y1 = clampY(yAxis.toPixels(p.price, false));
    const y2 = clampY(yAxis.toPixels(p.target, false));
    if (x2 > x1 && x1 < right && Math.abs(y2 - y1) >= 4) {
      r.path([['M', x1, y1], ['L', x2, y2]] as unknown as Highcharts.SVGPathArray)
        .attr({ stroke: ORION.nebula, 'stroke-width': 1.5, dashstyle: 'ShortDash' })
        .add(over);
      // punta de flecha orientada según el sentido del tramo
      const up = y2 < y1;
      r.path([
        ['M', x2, y2],
        ['L', x2 - 4, up ? y2 + 6 : y2 - 6],
        ['L', x2 + 4, up ? y2 + 6 : y2 - 6],
        ['Z'],
      ] as unknown as Highcharts.SVGPathArray)
        .attr({ fill: ORION.nebula })
        .add(over);
      r.label(`${up ? '↑' : '↓'} ${p.pips} pips`, Math.min(x2 + 6, right - 64), y2 - 9)
        .attr({ fill: ORION.raised, stroke: ORION.nebula, 'stroke-width': 1, r: 4, padding: 4 })
        .css({ color: '#b9affb', fontSize: '9px', fontFamily: ORION.fontData })
        .add(over);
    }
  }
}
