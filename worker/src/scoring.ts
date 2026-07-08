import type { AiVerdict, CalibrationBucket, ScoreBreakdown, SignalContext } from './types';

/* Paso 4 — sistema de scoring.
   Cada dimensión se puntúa 0-5. Las computables salen del dossier
   determinista; noticias y sentimiento las aporta la IA (o neutral 3).
   El overall pondera las dimensiones y ajusta ±10 con la confianza IA. */

const WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  trend: 1.5,
  momentum: 1.2,
  volume: 0.8,
  volatility: 1.0,
  macro: 1.0,
  news: 0.8,
  sentiment: 0.8,
  institutional: 1.0,
  riskReward: 1.4,
  history: 1.3,
};

/** Tramo de calibración aplicable a una confianza IA declarada. */
export function calibrationFor(
  confidence: number,
  buckets: CalibrationBucket[],
): CalibrationBucket | null {
  const key =
    confidence < 50 ? 'lt50' : confidence < 65 ? '50-64' : confidence < 80 ? '65-79' : '80plus';
  return buckets.find((b) => b.bucket === key) ?? null;
}

export function scoreSignal(
  ctx: SignalContext,
  ai: AiVerdict,
  calib: CalibrationBucket | null = null,
): {
  breakdown: ScoreBreakdown;
  overall: number;
} {
  const withTrend =
    (ctx.direction === 'buy' && ctx.trendHigherTf === 'alcista') ||
    (ctx.direction === 'sell' && ctx.trendHigherTf === 'bajista');
  const withEma =
    (ctx.direction === 'buy') === (ctx.ema200 === 'precio por encima');
  const emaSlopeAligned =
    (ctx.direction === 'buy' && ctx.ema200Slope === 'ascendente') ||
    (ctx.direction === 'sell' && ctx.ema200Slope === 'descendente');

  // Trend: confluencia de marco superior + EMA200 + pendiente
  const trend = clamp5(1 + (withTrend ? 2 : 0) + (withEma ? 1 : 0) + (emaSlopeAligned ? 1 : 0));

  // Momentum: RSI en zona útil para la dirección (ni agotado ni plano)
  const rsiEdge =
    ctx.direction === 'buy'
      ? ctx.rsi14 >= 45 && ctx.rsi14 <= 65 ? 2 : ctx.rsi14 > 65 && ctx.rsi14 <= 75 ? 1 : ctx.rsi14 < 30 ? 1 : 0
      : ctx.rsi14 <= 55 && ctx.rsi14 >= 35 ? 2 : ctx.rsi14 < 35 && ctx.rsi14 >= 25 ? 1 : ctx.rsi14 > 70 ? 1 : 0;
  const momentum = clamp5(2 + rsiEdge + (ctx.volumeTrend === 'creciente' ? 1 : 0));

  // Volume
  const volume = clamp5(
    ctx.volumeTrend === 'creciente' ? 4 : ctx.volumeTrend === 'estable' ? 3 : 2,
  );

  // Volatility: ATR% moderado es lo óptimo (ni muerto ni caótico)
  const volatility = clamp5(
    ctx.atrPct >= 0.05 && ctx.atrPct <= 0.25 ? 5
    : ctx.atrPct > 0.25 && ctx.atrPct <= 0.4 ? 3
    : ctx.atrPct < 0.05 ? 2 : 1,
  );

  // Macro: proxy por correlaciones — diversificación del riesgo direccional
  const corrs = Object.values(ctx.correlations).map(Math.abs);
  const avgCorr = corrs.length ? corrs.reduce((a, b) => a + b, 0) / corrs.length : 0.5;
  const macro = clamp5(avgCorr < 0.35 ? 4 : avgCorr < 0.65 ? 3 : 2);

  // News / Sentiment: valoración cualitativa de la IA (neutral si no hay datos)
  const news = clamp5(ai.newsScore);
  const sentiment = clamp5(ai.sentimentScore);

  // Institucional: estructura Smart Money real (order blocks + liquidez).
  // 'apoya' con liquidez-imán por delante → 5; sin estructura calculable se
  // cae al proxy antiguo (distancia a extremos recientes)
  let institutional: number;
  if (ctx.smc) {
    const magnet =
      ctx.direction === 'buy' ? ctx.smc.buySideLiquidity : ctx.smc.sellSideLiquidity;
    institutional = clamp5(
      ctx.smc.structuralBias === 'apoya' ? (magnet ? 5 : 4)
      : ctx.smc.structuralBias === 'neutral' ? 3
      : 1,
    );
  } else {
    const room = ctx.direction === 'buy' ? ctx.distanceToRecentHigh : ctx.distanceToRecentLow;
    institutional = clamp5(room > 0.6 ? 4 : room > 0.3 ? 3 : 2);
  }

  // Risk/Reward
  const riskReward = clamp5(
    ctx.riskReward >= 3 ? 5 : ctx.riskReward >= 2 ? 4 : ctx.riskReward >= 1.5 ? 3 : 2,
  );

  // Historia: expectancia real del patrón en este símbolo+intervalo
  // (tpRate·avgRr − (1 − tpRate), en múltiplos de R). Neutral sin muestra.
  const mine = ctx.recentOutcomes.find((o) => o.pattern === ctx.pattern);
  let history = 3;
  if (mine && mine.total >= 10) {
    const exp = mine.tpRate * (mine.avgRr || ctx.riskReward) - (1 - mine.tpRate);
    history = exp > 0.5 ? 5 : exp > 0.15 ? 4 : exp > -0.1 ? 3 : exp > -0.4 ? 2 : 1;
  }

  const breakdown: ScoreBreakdown = {
    trend, momentum, volume, volatility, macro, news, sentiment, institutional, riskReward, history,
  };

  // Media ponderada 0-5 → 0-100, con ajuste IA de ±10 puntos.
  // El ajuste declarado por la IA se corrige con su calibración empírica:
  // acierto real de sus veredictos pasados en el mismo tramo de confianza.
  // El peso de la corrección crece con la muestra (total a partir de 60).
  const totalWeight = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const weighted = (Object.keys(breakdown) as (keyof ScoreBreakdown)[])
    .reduce((sum, k) => sum + breakdown[k] * WEIGHTS[k], 0) / totalWeight;
  const base = (weighted / 5) * 100;
  let aiAdjust = ai.action === 'skip' ? -10 : ((ai.confidence - 50) / 50) * 10;
  if (calib && calib.n >= 20 && ai.action !== 'skip') {
    const empirical = Math.max(-10, Math.min(10, calib.expectancy * 12));
    const w = Math.min(1, calib.n / 60);
    aiAdjust = aiAdjust * (1 - w) + empirical * w;
  }

  return {
    breakdown,
    overall: Math.max(0, Math.min(100, Math.round(base + aiAdjust))),
  };
}

function clamp5(v: number): number {
  return Math.max(0, Math.min(5, Math.round(v)));
}
