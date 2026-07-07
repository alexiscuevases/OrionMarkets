/* Cliente de la API de orion-markets-worker (Cloudflare).
   Sobrescribible con VITE_API_URL (p. ej. http://localhost:8787 con `wrangler dev`). */

export const API_BASE: string =
  import.meta.env.VITE_API_URL ?? 'https://orion-markets-worker.alexcuevas.workers.dev';

const TIMEOUT_MS = 8000;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`API ${res.status} en ${path}`);
  return res.json() as Promise<T>;
}

/* ---------- formas de respuesta del worker ---------- */

export interface ApiHealth {
  ok: boolean;
  universe: { symbols: string[]; intervals: string[] };
  lastRun: {
    finishedAt: string;
    trigger: string;
    ingested: number;
    newSignals: number;
    evaluated: number;
    topScore: number;
  } | null;
}

export interface ApiCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ApiSignal {
  sigKey: string;
  symbol: string;
  interval: string;
  ts: number;
  pattern: string;
  direction: 'buy' | 'sell';
  entry: number;
  stop: number;
  target: number;
  rr: number;
  confidence: number;
  outcome: 'open' | 'tp_hit' | 'sl_hit' | 'expired';
  outcomeTs: number | null;
  aiAction: 'buy' | 'sell' | 'skip' | null;
  aiConfidence: number | null;
  aiThesis: string | null;
  aiRisks?: string | null;
  scoresJson: string | null;
  overallScore: number | null;
}

export const api = {
  health: () => get<ApiHealth>('/api/health'),

  candles: (symbol: string, interval: string, limit = 500) =>
    get<{ candles: ApiCandle[] }>(
      `/api/candles?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    ),

  signals: (symbol: string, interval: string, limit = 100) =>
    get<{ signals: ApiSignal[] }>(
      `/api/signals?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    ),

  opportunities: (limit = 20) =>
    get<{ opportunities: ApiSignal[] }>(`/api/opportunities?limit=${limit}`),
};
