import { api, type ApiSignal } from '../api/client';
import {
  pairBySymbol, quoteFromCandles,
  type AISignal, type Quote, type SeriesData,
} from './market';

/* Capa de datos: todo sale del motor de Cloudflare (Twelve Data + D1).
   Si el par/TF está fuera del universo ingerido, la API cae o el histórico
   está vacío, se devuelve un resultado vacío y la UI muestra ese estado. */

/** Temporalidades de la UI ↔ intervalos de Twelve Data en el motor. */
const TF_TO_INTERVAL: Record<string, string> = {
  M5: '5min',
  M15: '15min',
  M30: '30min',
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
  '45min': 'M30', // la UI no tiene M45; se aproxima al más cercano
  '1h': 'H1',
};

function adaptSignal(s: ApiSignal, tfOverride?: string): AISignal {
  const pair = pairBySymbol(s.symbol);
  const evaluated = s.aiAction !== null;

  let status: AISignal['status'];
  let resultPips: number | undefined;
  if (s.outcome === 'open') {
    status = evaluated ? 'Activa' : 'Pendiente';
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
    resultPips,
    live: true,
    overallScore: s.overallScore,
    scores,
    aiThesis: s.aiThesis,
  };
}
