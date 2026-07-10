import { expectancyOf } from './health';
import { regimeAligned } from './regime';
import type { AiVerdict, CalibrationBucket, ScoreBreakdown, SignalContext } from './types';

/* Paso 4 — sistema de scoring adaptativo.
   Cada dimensión se puntúa 0-5. Las computables salen del dossier
   determinista; noticias y sentimiento las aporta la IA (o neutral 3).
   El overall pondera las dimensiones y ajusta ±10 con la confianza IA.

   Los pesos ya no son fijos: DEFAULT_WEIGHTS es el punto de partida y
   evolveWeights() los ajusta periódicamente con los cierres reales
   (determinista, sin ML). La media ponderada se normaliza por la suma de
   pesos, así la escala 0-100 no se mueve aunque los pesos cambien —
   PAPER_MIN_SCORE y las comparaciones históricas siguen siendo válidas. */

export const DEFAULT_WEIGHTS: Record<keyof ScoreBreakdown, number> = {
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
  regime: 1.2,
};

export type ScoringWeights = Record<keyof ScoreBreakdown, number>;

/** Tramo de calibración aplicable a una confianza IA declarada. */
export function calibrationFor(
  confidence: number,
  buckets: CalibrationBucket[],
): CalibrationBucket | null {
  const key =
    confidence < 50 ? 'lt50' : confidence < 65 ? '50-64' : confidence < 80 ? '65-79' : '80plus';
  return buckets.find((b) => b.bucket === key) ?? null;
}

export interface ScoreOptions {
  /** Pesos vigentes (scoring_weights); ausente → DEFAULT_WEIGHTS. */
  weights?: ScoringWeights;
  /** Multiplicador de salud del patrón (pattern_health); 1 = sano. */
  healthMultiplier?: number;
  /** Rendimiento del patrón bajo el régimen actual (muestra >= 10). */
  patternRegimeStats?: { total: number; tpRate: number; avgRr: number } | null;
}

export function scoreSignal(
  ctx: SignalContext,
  ai: AiVerdict,
  calib: CalibrationBucket | null = null,
  opts: ScoreOptions = {},
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
  // (walk-forward si el dossier lo trae; si no, ventana completa). Neutral
  // sin muestra.
  let history = 3;
  const wf = ctx.patternWalkForward;
  if (wf && wf.totalTrades >= 10) {
    history = expectancyLadder(wf.expectancy);
    // walk-forward: el deterioro reciente recorta la dimensión aunque el
    // histórico completo siga siendo bueno
    if (wf.degradationScore >= 0.35 && history > 1) history -= 1;
  } else {
    const mine = ctx.recentOutcomes.find((o) => o.pattern === ctx.pattern);
    if (mine && mine.total >= 10) {
      history = expectancyLadder(expectancyOf(mine.tpRate, mine.avgRr || ctx.riskReward));
    }
  }

  // Régimen: encaje de la señal con el estado del mercado. Con muestra real
  // del patrón bajo este régimen manda la expectancia condicionada; sin
  // muestra, heurística de alineación
  let regime = 3;
  if (ctx.marketRegime) {
    const prs = opts.patternRegimeStats ?? ctx.patternRegimeStats;
    if (prs && prs.total >= 10) {
      regime = expectancyLadder(expectancyOf(prs.tpRate, prs.avgRr || ctx.riskReward));
    } else {
      const aligned = regimeAligned(ctx.marketRegime, ctx.direction);
      regime =
        aligned === true ? 4
        : aligned === false ? 1
        : ctx.marketRegime === 'HIGH_VOLATILITY' ? 2
        : ctx.marketRegime === 'LOW_VOLATILITY' ? 2
        : 3; // RANGE: neutral (los reversals viven ahí)
    }
  }

  const breakdown: ScoreBreakdown = {
    trend, momentum, volume, volatility, macro, news, sentiment, institutional,
    riskReward, history, regime: clamp5(regime),
  };

  // Media ponderada 0-5 → 0-100, con ajuste IA de ±10 puntos.
  // El ajuste declarado por la IA se corrige con su calibración empírica:
  // acierto real de sus veredictos pasados en el mismo tramo de confianza.
  // El peso de la corrección crece con la muestra (total a partir de 60).
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const dims = Object.keys(breakdown) as (keyof ScoreBreakdown)[];
  const totalWeight = dims.reduce((a, k) => a + (weights[k] ?? DEFAULT_WEIGHTS[k]), 0);
  const weighted = dims
    .reduce((sum, k) => sum + breakdown[k] * (weights[k] ?? DEFAULT_WEIGHTS[k]), 0) / totalWeight;
  const base = (weighted / 5) * 100;
  let aiAdjust = ai.action === 'skip' ? -10 : ((ai.confidence - 50) / 50) * 10;
  if (calib && calib.n >= 20 && ai.action !== 'skip') {
    const empirical = Math.max(-10, Math.min(10, calib.expectancy * 12));
    const w = Math.min(1, calib.n / 60);
    aiAdjust = aiAdjust * (1 - w) + empirical * w;
  }

  // Salud del patrón: multiplicador gradual (pattern_health). 1 = intacto;
  // un patrón en degradación pierde prioridad sin llegar al skip binario.
  const mult = opts.healthMultiplier ?? 1;

  return {
    breakdown,
    overall: Math.max(0, Math.min(100, Math.round((base + aiAdjust) * mult))),
  };
}

/** Escalera común expectancia (R) → puntuación 1-5. */
function expectancyLadder(exp: number): number {
  return exp > 0.5 ? 5 : exp > 0.15 ? 4 : exp > -0.1 ? 3 : exp > -0.4 ? 2 : 1;
}

function clamp5(v: number): number {
  return Math.max(0, Math.min(5, Math.round(v)));
}

/* ---------- evolución de pesos (Mejora 2) ----------
   Determinista y acotada: cada dimensión se compara entre cierres ganadores
   y perdedores; las dimensiones que separan bien (score alto en ganadores,
   bajo en perdedores) ganan peso y las ruidosas lo pierden. La suma total
   se renormaliza para conservar la escala del score. */

export interface DimensionPerformance {
  dimension: keyof ScoreBreakdown;
  avgWin: number;  // media 0-5 de la dimensión en cierres tp_hit
  avgLoss: number; // media 0-5 en cierres sl_hit
  nWin: number;
  nLoss: number;
}

export const WEIGHT_EVOLUTION = {
  learningRate: 0.15,
  minWeight: 0.5,
  maxWeight: 2.0,
  minSamplesPerSide: 10, // nWin y nLoss mínimos para mover una dimensión
} as const;

export function evolveWeights(
  current: ScoringWeights,
  performance: DimensionPerformance[],
): ScoringWeights {
  const cfg = WEIGHT_EVOLUTION;
  const targetSum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);

  const next: ScoringWeights = { ...DEFAULT_WEIGHTS, ...current };
  for (const p of performance) {
    if (!(p.dimension in next)) continue;
    if (p.nWin < cfg.minSamplesPerSide || p.nLoss < cfg.minSamplesPerSide) continue;
    // separación normalizada a [-1, 1]: cuánto distingue ganadores de perdedores
    const predictiveness = Math.max(-1, Math.min(1, (p.avgWin - p.avgLoss) / 5));
    const moved = next[p.dimension] * (1 + cfg.learningRate * predictiveness);
    next[p.dimension] = Math.max(cfg.minWeight, Math.min(cfg.maxWeight, moved));
  }

  // renormaliza a la suma de referencia → la escala 0-100 no se mueve
  const sum = Object.values(next).reduce((a, b) => a + b, 0);
  if (sum > 0) {
    for (const k of Object.keys(next) as (keyof ScoreBreakdown)[]) {
      next[k] = Math.round((next[k] * targetSum / sum) * 1000) / 1000;
    }
  }
  return next;
}

/**
 * Rendimiento por dimensión a partir de cierres reales: cada fila es el
 * scores_json de una evaluación (buy/sell, sin gates) con su outcome.
 */
export function computeDimensionPerformance(
  rows: { breakdown: Partial<ScoreBreakdown>; outcome: 'tp_hit' | 'sl_hit' }[],
): DimensionPerformance[] {
  const dims = Object.keys(DEFAULT_WEIGHTS) as (keyof ScoreBreakdown)[];
  return dims.map((dimension) => {
    let winSum = 0; let nWin = 0; let lossSum = 0; let nLoss = 0;
    for (const r of rows) {
      const v = r.breakdown[dimension];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (r.outcome === 'tp_hit') { winSum += v; nWin++; }
      else { lossSum += v; nLoss++; }
    }
    return {
      dimension,
      avgWin: nWin > 0 ? winSum / nWin : 0,
      avgLoss: nLoss > 0 ? lossSum / nLoss : 0,
      nWin,
      nLoss,
    };
  });
}
