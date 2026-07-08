import { atr, correlation, ema, returns, rsi, slopePct } from './indicators';
import { getPatternStats, loadCandles } from './db';
import { SYMBOLS, type Candle, type SignalContext, type SignalRow } from './types';

/* Paso 3a — dossier determinista de una señal.
   Equivale al bloque "Contexto / Noticias / Correlación" del diseño:
   todo lo computable se calcula aquí; noticias y sentimiento quedan
   como null hasta conectar un proveedor. */

export async function buildContext(
  db: D1Database,
  signal: SignalRow,
  candles: Candle[],
): Promise<SignalContext> {
  // solo información disponible en el momento de la señal (sin look-ahead)
  const upto = candles.filter((c) => c.ts <= signal.ts);
  if (upto.length === 0) upto.push(...candles.slice(0, 1));
  const closes = upto.map((c) => c.close);

  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(upto, 14);
  const last = closes.length - 1;

  const price = closes[last];
  const e200 = ema200[last];
  const e200Slope = slopePct(ema200, last, 40);

  // tendencia de marco superior: pendiente de EMA50 sobre la serie 1h.
  // Se corta en signal.ts: usar velas posteriores era look-ahead y sesgaba
  // la validación IA de señales pasadas
  const higherTf = (await loadCandles(db, signal.symbol, '1h', 400))
    .filter((c) => c.ts <= signal.ts);
  const hCloses = higherTf.map((c) => c.close);
  const hEma50 = ema(hCloses, 50);
  const hSlope = slopePct(hEma50, hCloses.length - 1, 30);
  const trendHigherTf = hSlope > 0.01 ? 'alcista' : hSlope < -0.01 ? 'bajista' : 'lateral';

  // volumen: media de los últimos 20 vs los 20 anteriores
  const vols = upto.map((c) => c.volume);
  const vNow = avg(vols.slice(-20));
  const vPrev = avg(vols.slice(-40, -20));
  const volumeTrend =
    vPrev === 0 ? 'estable' : vNow > vPrev * 1.15 ? 'creciente' : vNow < vPrev * 0.85 ? 'decreciente' : 'estable';

  // extremos recientes
  const win = upto.slice(-120);
  const hh = Math.max(...win.map((c) => c.high));
  const ll = Math.min(...win.map((c) => c.low));

  // correlaciones con el resto del universo (retornos 1h)
  const correlations: Record<string, number> = {};
  const baseRet = returns(hCloses.slice(-200));
  for (const other of SYMBOLS) {
    if (other === signal.symbol) continue;
    const oc = (await loadCandles(db, other, '1h', 200))
      .filter((c) => c.ts <= signal.ts);
    const r = correlation(baseRet, returns(oc.map((c) => c.close)));
    correlations[other] = Math.round(r * 100) / 100;
  }

  // rendimiento histórico de los patrones en este mercado (auto-referencia)
  const stats = await getPatternStats(db, signal.symbol, signal.interval);

  return {
    symbol: signal.symbol,
    interval: signal.interval,
    detectedAt: new Date(signal.ts).toISOString(),
    pattern: signal.pattern,
    direction: signal.direction,
    entry: signal.entry,
    stop: signal.stop,
    target: signal.target,
    riskReward: signal.rr,
    trendHigherTf,
    ema200: price > e200 ? 'precio por encima' : 'precio por debajo',
    ema200Slope: e200Slope > 0.005 ? 'ascendente' : e200Slope < -0.005 ? 'descendente' : 'plana',
    rsi14: Math.round(rsi14[last] ?? 50),
    atrPct: Math.round(((atr14[last] ?? 0) / price) * 10000) / 100,
    volumeTrend,
    distanceToRecentHigh: Math.round(((hh - price) / price) * 10000) / 100,
    distanceToRecentLow: Math.round(((price - ll) / price) * 10000) / 100,
    correlations,
    recentOutcomes: stats.map((s) => ({
      pattern: s.pattern, total: s.total, tpRate: s.tpRate, avgRr: s.avgRr,
    })),
    news: null,
    sentiment: null,
  };
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
