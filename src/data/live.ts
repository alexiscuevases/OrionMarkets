import {
  api, type ApiCalibrationBucket, type ApiMarketState, type ApiSignal,
} from '../api/client';
import {
  pairBySymbol, quoteFromCandles,
  type AISignal, type Quote, type SeriesData, type SignalCtx,
} from './market';
import { STRATEGY_DEFS, strategyIdForPattern, type StrategyStats } from './strategies';

/* Capa de datos: todo sale del motor de Cloudflare (Twelve Data + D1).
   Si el par/TF está fuera del universo ingerido, la API cae o el histórico
   está vacío, se devuelve un resultado vacío y la UI muestra ese estado. */

/** Temporalidades de la UI ↔ intervalos de Twelve Data en el motor. */
const TF_TO_INTERVAL: Record<string, string> = {
  M5: '5min',
  M15: '15min',
  M30: '30min',
  M45: '45min',
  H1: '1h',
};

export const LIVE_SYMBOLS = new Set(['EURUSD', 'GBPUSD', 'USDJPY']);
export const LIVE_TFS = Object.keys(TF_TO_INTERVAL);

export function isLiveCapable(symbol: string, tf: string): boolean {
  return LIVE_SYMBOLS.has(symbol) && tf in TF_TO_INTERVAL;
}

export interface MarketData {
  series: SeriesData | null;
  signals: AISignal[];
  live: boolean;
}

const EMPTY: MarketData = { series: null, signals: [], live: false };

/** Serie + señales del motor; vacío si no hay cobertura o la API falla. */
export async function loadMarketData(symbol: string, tf: string): Promise<MarketData> {
  if (!isLiveCapable(symbol, tf)) return EMPTY;

  const interval = TF_TO_INTERVAL[tf];
  try {
    const [candlesRes, signalsRes] = await Promise.all([
      api.candles(symbol, interval, 800),
      api.signals(symbol, interval, 60),
    ]);
    if (candlesRes.candles.length < 2) return EMPTY;
    return {
      series: {
        candles: candlesRes.candles.map((c) => [c.ts, c.open, c.high, c.low, c.close]),
        volume: candlesRes.candles.map((c) => [c.ts, c.volume]),
      },
      signals: signalsRes.signals.map((s) => adaptSignal(s, tf)),
      live: true,
    };
  } catch {
    return EMPTY;
  }
}

/** Mejores oportunidades puntuadas por el motor; lista vacía si no responde. */
export async function loadOpportunities(): Promise<{ signals: AISignal[]; live: boolean }> {
  try {
    const res = await api.opportunities(24);
    return { signals: res.opportunities.map((s) => adaptSignal(s)), live: true };
  } catch {
    return { signals: [], live: false };
  }
}

/** Rendimiento real por estrategia agregado desde /api/strategies.
    Los agregados por patrón del motor se pliegan a su estrategia (varios
    patrones pueden pertenecer al mismo detector) y la curva se reconstruye
    en múltiplos de R: cada TP suma su rr, cada SL resta 1. */
export async function loadStrategyStats(): Promise<{
  byId: Map<string, StrategyStats>;
  live: boolean;
}> {
  const byId = new Map<string, StrategyStats>();
  const ensure = (id: string): StrategyStats => {
    let s = byId.get(id);
    if (!s) {
      s = {
        signals30d: 0, open: 0, wins: 0, losses: 0,
        winRate: null, profitFactor: null, equity: [],
      };
      byId.set(id, s);
    }
    return s;
  };

  try {
    const res = await api.strategies(30);
    const grossR = new Map<string, number>();

    // con el motor respondiendo, una estrategia sin señales muestra 0, no «—»
    for (const d of STRATEGY_DEFS) ensure(d.id);

    for (const p of res.patterns) {
      const id = strategyIdForPattern(p.pattern);
      if (!id) continue;
      const s = ensure(id);
      s.signals30d += p.total;
      s.open += p.open;
      s.wins += p.tp;
      s.losses += p.sl;
      grossR.set(id, (grossR.get(id) ?? 0) + p.grossR);
    }

    for (const c of res.closed) {
      const id = strategyIdForPattern(c.pattern);
      if (!id) continue;
      const s = ensure(id);
      const r = c.outcome === 'tp_hit' ? c.rr : -1;
      s.equity.push((s.equity[s.equity.length - 1] ?? 0) + r);
    }

    for (const [id, s] of byId) {
      const decided = s.wins + s.losses;
      s.winRate = decided > 0 ? Math.round((s.wins / decided) * 100) : null;
      const gross = grossR.get(id) ?? 0;
      s.profitFactor =
        s.losses > 0 ? gross / s.losses : s.wins > 0 ? Infinity : null;
    }

    return { byId, live: true };
  } catch {
    return { byId: new Map(), live: false };
  }
}

/** Cotización real para la watchlist (null si no hay datos suficientes). */
export async function loadLiveQuote(symbol: string): Promise<Quote | null> {
  if (!LIVE_SYMBOLS.has(symbol)) return null;
  try {
    const res = await api.candles(symbol, '1h', 40);
    if (res.candles.length < 26) return null;
    return quoteFromCandles(
      symbol,
      res.candles.map((c) => [c.ts, c.open, c.high, c.low, c.close]),
      60,
    );
  } catch {
    return null;
  }
}

/** Estado de mercado por símbolo (tendencia, volatilidad…); null si el motor no responde. */
export async function loadMarketStates(): Promise<Map<string, ApiMarketState> | null> {
  try {
    const res = await api.marketState();
    return new Map(res.states.map((s) => [s.symbol, s]));
  } catch {
    return null;
  }
}

/* Calibración empírica de la IA, cacheada en módulo: cambia despacio y
   la consultan los modales de análisis cada vez que se abren. */
let calibCache: { at: number; buckets: ApiCalibrationBucket[] } | null = null;

export async function loadCalibration(): Promise<ApiCalibrationBucket[]> {
  if (calibCache && Date.now() - calibCache.at < 5 * 60_000) return calibCache.buckets;
  try {
    const res = await api.learning();
    calibCache = { at: Date.now(), buckets: res.calibration };
    return res.calibration;
  } catch {
    return calibCache?.buckets ?? [];
  }
}

export type EngineStatus = 'online' | 'offline';

export async function loadEngineStatus(): Promise<{
  status: EngineStatus;
  lastRun: string | null;
  topScore: number | null;
}> {
  try {
    const h = await api.health();
    return {
      status: h.ok ? 'online' : 'offline',
      lastRun: h.lastRun?.finishedAt ?? null,
      topScore: h.lastRun?.topScore ?? null,
    };
  } catch {
    return { status: 'offline', lastRun: null, topScore: null };
  }
}

/* ---------- adaptación motor → UI ---------- */

const INTERVAL_TO_TF: Record<string, string> = {
  '5min': 'M5',
  '15min': 'M15',
  '30min': 'M30',
  '45min': 'M45',
  '1h': 'H1',
};

function adaptSignal(s: ApiSignal, tfOverride?: string): AISignal {
  const pair = pairBySymbol(s.symbol);
  const evaluated = s.aiAction !== null;

  let status: AISignal['status'];
  let resultPips: number | undefined;
  if (s.outcome === 'open') {
    // una señal abierta que la IA descartó no es una oportunidad activa
    status = !evaluated ? 'Pendiente' : s.aiAction === 'skip' ? 'Descartada' : 'Activa';
  } else {
    status = 'Cerrada';
    resultPips =
      s.outcome === 'tp_hit'
        ? Math.round(Math.abs(s.target - s.entry) / pair.pip)
        : s.outcome === 'sl_hit'
          ? -Math.round(Math.abs(s.entry - s.stop) / pair.pip)
          : 0;
  }

  let scores: Record<string, number> | null = null;
  if (s.scoresJson) {
    try {
      scores = JSON.parse(s.scoresJson) as Record<string, number>;
    } catch {
      scores = null;
    }
  }

  let context: SignalCtx | null = null;
  if (s.contextJson) {
    try {
      context = JSON.parse(s.contextJson) as SignalCtx;
    } catch {
      context = null;
    }
  }

  return {
    id: s.sigKey,
    symbol: s.symbol,
    tf: tfOverride ?? INTERVAL_TO_TF[s.interval] ?? s.interval,
    direction: s.direction,
    pattern: s.pattern,
    strategy:
      s.aiAction === null
        ? 'pendiente de IA'
        : s.aiAction === 'skip'
          ? 'IA: descartada'
          : `IA: validada ${s.aiConfidence ?? ''}%`.trim(),
    confidence: s.confidence,
    time: s.ts,
    entry: s.entry,
    stop: s.stop,
    target: s.target,
    status,
    outcome: s.outcome,
    resultPips,
    live: true,
    overallScore: s.overallScore,
    scores,
    aiThesis: s.aiThesis,
    aiRisks: s.aiRisks ?? null,
    aiAction: s.aiAction,
    aiConfidence: s.aiConfidence,
    rr: s.rr,
    context,
  };
}
