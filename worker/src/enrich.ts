import { atr, correlation, ema, returns, rsi, slopePct } from './indicators';
import { getPatternRegimeStats, getPatternStats, loadCandles } from './db';
import { computePatternHealth, HEALTH_THRESHOLDS } from './health';
import { getMarketContext } from './marketContext';
import { describeRegime, regimeAt } from './regime';
import { smcSummary } from './smc';
import {
  SYMBOLS, type Candle, type PatternWalkForward, type SignalContext, type SignalRow,
} from './types';

/* Sesiones de mercado (horas UTC); espejo de SESSIONS del frontend. */
const SESSIONS: { name: string; openUtc: number; closeUtc: number }[] = [
  { name: 'Sídney', openUtc: 21, closeUtc: 6 },
  { name: 'Tokio', openUtc: 0, closeUtc: 9 },
  { name: 'Londres', openUtc: 7, closeUtc: 16 },
  { name: 'Nueva York', openUtc: 12, closeUtc: 21 },
];

function openSessions(ts: number): string {
  const h = new Date(ts).getUTCHours();
  const open = SESSIONS.filter((s) =>
    s.openUtc < s.closeUtc ? h >= s.openUtc && h < s.closeUtc : h >= s.openUtc || h < s.closeUtc,
  ).map((s) => s.name);
  return open.length > 0 ? open.join(' + ') : 'fuera de horario';
}

/* Paso 3a — dossier determinista de una señal.
   Equivale al bloque "Contexto / Noticias / Correlación" del diseño:
   todo lo computable se calcula aquí; noticias y sentimiento quedan
   como null hasta conectar un proveedor. */

export async function buildContext(
  db: D1Database,
  signal: SignalRow,
  candles: Candle[],
  asOf: number = signal.ts,
): Promise<SignalContext> {
  // solo información disponible hasta el corte: en la evaluación inicial es
  // el momento de la señal (sin look-ahead); en re-evaluaciones, el presente
  const upto = candles.filter((c) => c.ts <= asOf);
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
  // Se corta en asOf: usar velas posteriores al corte era look-ahead y
  // sesgaba la validación IA de señales pasadas
  const higherTf = (await loadCandles(db, signal.symbol, '1h', 400))
    .filter((c) => c.ts <= asOf);
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
      .filter((c) => c.ts <= asOf);
    const r = correlation(baseRet, returns(oc.map((c) => c.close)));
    correlations[other] = Math.round(r * 100) / 100;
  }

  // rendimiento histórico de los patrones en este mercado (auto-referencia)
  const stats = await getPatternStats(db, signal.symbol, signal.interval);

  // régimen de mercado en el corte (regime.ts, mismas velas del dossier).
  // En re-evaluaciones se recalcula al presente: el régimen puede haber
  // cambiado desde la detección y eso es exactamente lo que la IA debe ver
  const regimeInfo = regimeAt(upto, upto.length - 1);

  // jurisprudencia condicionada: rendimiento real del patrón bajo este
  // régimen en este mercado (muestra mínima la aplica el consumidor)
  const patternRegime = regimeInfo
    ? await getPatternRegimeStats(db, signal.symbol, signal.interval, signal.pattern, regimeInfo.regime)
    : null;

  // walk-forward del patrón de la señal: histórico completo vs. ventana
  // reciente; la degradación reduce la dimensión history y alerta a la IA
  const sinceRecent = asOf - HEALTH_THRESHOLDS.recentWindowDays * 86_400_000;
  const recentStats = await getPatternStats(db, signal.symbol, signal.interval, sinceRecent);
  const full = stats.find((s) => s.pattern === signal.pattern);
  const recent = recentStats.find((s) => s.pattern === signal.pattern);
  let patternWalkForward: PatternWalkForward | null = null;
  if (full && full.total > 0) {
    const h = computePatternHealth(
      { symbol: signal.symbol, interval: signal.interval, pattern: signal.pattern },
      { total: full.total, tpRate: full.tpRate, avgRr: full.avgRr },
      recent
        ? { total: recent.total, tpRate: recent.tpRate, avgRr: recent.avgRr }
        : { total: 0, tpRate: 0, avgRr: 0 },
    );
    patternWalkForward = {
      totalTrades: h.totalTrades,
      winRate: h.winRate,
      avgRR: h.avgRR,
      expectancy: h.expectancy,
      recentTrades: h.recentTrades,
      recentWinRate: h.recentWinRate,
      recentExpectancy: h.recentExpectancy,
      degradationScore: h.degradationScore,
      status: h.status,
    };
  }

  // calendario económico (capa de contexto, Fase 5): eventos ya publicados
  // en el calendario en el momento del corte — conocidos con antelación,
  // no información futura. Sin proveedor conectado queda null (neutral).
  const market = await getMarketContext(db, signal.symbol, asOf);

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
    similarCases: null, // lo rellena el workflow con la memoria vectorial
    news: market.newsSummary,
    sentiment: null,
    marketWarnings: market.warnings.length > 0 ? market.warnings : null,
    session: openSessions(asOf),
    smc: smcSummary(upto, signal.direction),
    marketRegime: regimeInfo?.regime ?? null,
    regimeNote: regimeInfo
      ? describeRegime(regimeInfo, signal.direction, patternRegime)
      : null,
    patternWalkForward,
    patternRegimeStats: patternRegime,
  };
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
