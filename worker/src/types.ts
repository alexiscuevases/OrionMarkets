export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  AI: Ai;
  VECTOR_INDEX: Vectorize;
  PIPELINE: Workflow;
  TWELVEDATA_API_KEY: string;
  /** Plan contratado en Twelve Data (free | grow | pro | expert | enterprise);
      dimensiona el ritmo y profundidad de la ingesta (plans.ts). */
  TWELVEDATA_PLAN?: string;
  /** Plan de Cloudflare Workers (free | paid); en free se minimizan las
      escrituras de KV para no agotar las 1000/día (plans.ts). */
  CLOUDFLARE_WORKERS_PLAN?: string;
  /** Secret: Bearer token de los endpoints de administración (Fase 8). */
  ADMIN_API_KEY?: string;
  /** "true" permite registrarse a más usuarios tras el primero (que es admin). */
  ALLOW_SIGNUPS?: string;
  AI_MODEL: string;
  AI_MIN_CONFIDENCE: string;
  AI_MAX_PER_RUN: string;
  AI_MAX_REEVAL: string;
  /** Orígenes CORS permitidos, separados por comas; '*' si no se define. */
  ALLOWED_ORIGINS?: string;
  /** Tarifas Workers AI (USD por millón de tokens) para el coste estimado. */
  AI_COST_IN_PER_M?: string;
  AI_COST_OUT_PER_M?: string;
  /** Paper trading: parámetros de la cuenta por defecto. */
  PAPER_INITIAL_BALANCE?: string;
  PAPER_RISK_PCT?: string;
  PAPER_MIN_SCORE?: string;
}

/** Configuración del universo a ingerir. */
export const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY'] as const;
export const INTERVALS = ['5min', '15min', '30min', '45min', '1h'] as const;
export const HISTORY_START = '2026-01-01';

export type Symbol = (typeof SYMBOLS)[number];
export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_MS: Record<Interval, number> = {
  '5min': 5 * 60_000,
  '15min': 15 * 60_000,
  '30min': 30 * 60_000,
  '45min': 45 * 60_000,
  '1h': 60 * 60_000,
};

export interface Candle {
  ts: number; // epoch ms UTC (apertura de la vela)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Direction = 'buy' | 'sell';

export interface DetectedSignal {
  sigKey: string;
  symbol: string;
  interval: string;
  ts: number;
  pattern: string;
  direction: Direction;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  confidence: number; // 0-100 determinista
  /** Régimen de mercado en el momento de la señal (regime.ts); lo anota el
      workflow tras la detección, null si no hay muestra suficiente. */
  regime?: import('./regime').MarketRegime | null;
}

export type Outcome = 'open' | 'tp_hit' | 'sl_hit' | 'expired';

export interface SignalRow extends DetectedSignal {
  outcome: Outcome;
  outcomeTs: number | null;
}

/** Walk-forward del patrón de la señal (health.ts): histórico vs. reciente. */
export interface PatternWalkForward {
  totalTrades: number;
  winRate: number;
  avgRR: number;
  expectancy: number;
  recentTrades: number;
  recentWinRate: number;
  recentExpectancy: number;
  degradationScore: number;
  status: 'healthy' | 'degrading' | 'disabled';
}

/** Dossier determinista que se entrega a la IA (paso 3). */
export interface SignalContext {
  symbol: string;
  interval: string;
  detectedAt: string; // ISO
  pattern: string;
  direction: Direction;
  entry: number;
  stop: number;
  target: number;
  riskReward: number;
  trendHigherTf: 'alcista' | 'bajista' | 'lateral';
  ema200: 'precio por encima' | 'precio por debajo';
  ema200Slope: 'ascendente' | 'descendente' | 'plana';
  rsi14: number;
  atrPct: number;           // ATR como % del precio
  volumeTrend: 'creciente' | 'decreciente' | 'estable';
  distanceToRecentHigh: number; // %
  distanceToRecentLow: number;  // %
  correlations: Record<string, number>; // vs otros pares del universo
  recentOutcomes: { pattern: string; total: number; tpRate: number; avgRr: number }[];
  /** Resumen de casos históricos similares (memoria vectorial); null sin datos. */
  similarCases: string | null;
  /** Calendario económico próximo (capa de contexto); null sin eventos cargados. */
  news: string | null;
  sentiment: string | null; // pendiente de proveedor de sentimiento
  /** Avisos operativos (p. ej. evento de alto impacto inminente). */
  marketWarnings?: string[] | null;
  /** Sesiones de mercado abiertas en el momento del corte del dossier. */
  session?: string;
  /** Estructura Smart Money (order blocks y liquidez); null sin muestra. */
  smc?: import('./smc').SmcSummary | null;
  /** Régimen de mercado en el corte del dossier (regime.ts). */
  marketRegime?: import('./regime').MarketRegime | null;
  /** Frase de régimen para la IA: estado + rendimiento del patrón en él. */
  regimeNote?: string | null;
  /** Walk-forward del patrón de esta señal en este mercado; null sin datos. */
  patternWalkForward?: PatternWalkForward | null;
  /** Rendimiento del patrón bajo el régimen actual (dimensión regime). */
  patternRegimeStats?: { total: number; tpRate: number; avgRr: number } | null;
  /** Solo en re-evaluaciones: seguimiento de la señal desde su detección. */
  tracking?: SignalTracking | null;
}

/** Seguimiento de una señal abierta al re-evaluarla con datos nuevos. */
export interface SignalTracking {
  revision: number;          // nº de esta revisión (2 = primera re-evaluación)
  barsSinceDetected: number;
  currentPrice: number;
  /** % del recorrido entrada→objetivo ya hecho; negativo si va hacia el stop. */
  progressToTargetPct: number;
  previousVerdict: { action: string; confidence: number; thesis: string };
}

/** Lección destilada por la IA a partir de sus propios errores. */
export interface Lesson {
  id: number;
  scope: string; // 'global' o 'SYMBOL|interval'
  lesson: string;
  support: number; // nº de casos que la respaldan
  createdAt: number;
}

/** Calibración empírica de la confianza de la IA por tramo. */
export interface CalibrationBucket {
  bucket: string;     // 'lt50' | '50-64' | '65-79' | '80plus'
  n: number;          // cierres con veredicto buy/sell en el tramo
  tpRate: number;     // acierto real
  avgRr: number;
  expectancy: number; // tpRate·avgRr − (1 − tpRate), en R
}

export interface AiVerdict {
  action: 'buy' | 'sell' | 'skip';
  confidence: number; // 0-100
  thesis: string;
  risks: string;
  /** Condiciones observables que invalidarían la tesis (opcional en el
      modelo: los que la omiten no fuerzan reintento). */
  invalidation: string;
  sentimentScore: number; // 0-5 valoración cualitativa de la IA
  newsScore: number;      // 0-5
}

export interface ScoreBreakdown {
  trend: number;        // 0-5
  momentum: number;
  volume: number;
  volatility: number;
  macro: number;
  news: number;
  sentiment: number;
  institutional: number;
  riskReward: number;
  history: number;      // expectancia histórica real del patrón en este mercado
  regime: number;       // encaje con el régimen de mercado (regime.ts)
}
