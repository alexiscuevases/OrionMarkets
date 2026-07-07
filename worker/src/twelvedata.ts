import { INTERVAL_MS, type Candle, type Interval } from './types';

/* Cliente mínimo de Twelve Data (https://twelvedata.com/docs).
   Nota de comportamiento: time_series devuelve las velas MÁS RECIENTES del
   rango pedido, así que la paginación del backfill se hace con ventanas
   [start_date, end_date] de tamaño <= outputsize velas — nunca con
   start_date abierto. Plan gratuito: 8 créditos/min y 800/día; el workflow
   espacia las peticiones con step.sleep. */

const BASE = 'https://api.twelvedata.com';
export const MAX_OUTPUT = 5000; // límite de outputsize por petición

/** EURUSD → EUR/USD (formato de símbolo de Twelve Data). */
function tdSymbol(symbol: string): string {
  return `${symbol.slice(0, 3)}/${symbol.slice(3)}`;
}

function tdDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
}

interface TdValue {
  datetime: string; // "2026-01-01 00:05:00" en el timezone pedido
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

interface TdResponse {
  status?: string;
  code?: number;
  message?: string;
  values?: TdValue[];
}

export interface FetchResult {
  candles: Candle[];
  /** fin de la ventana pedida: cursor de avance aunque no haya velas (huecos/fin de semana) */
  windowEnd: number;
  /** true si la ventana termina antes del presente → queda histórico por pedir */
  hasMore: boolean;
}

/**
 * Pide la ventana de velas [startTs, startTs + 5000·intervalo], acotada al presente.
 * Lanza Error en fallos transitorios (429/5xx) para que el workflow reintente;
 * "no hay datos en el rango" NO es un error (mercado cerrado, huecos).
 */
export async function fetchSeries(
  apiKey: string,
  symbol: string,
  interval: Interval,
  startTs: number,
): Promise<FetchResult> {
  const stepMs = INTERVAL_MS[interval];
  const now = Date.now();
  const windowEnd = Math.min(startTs + MAX_OUTPUT * stepMs, now);
  const hasMore = windowEnd < now - stepMs;

  const params = new URLSearchParams({
    symbol: tdSymbol(symbol),
    interval,
    apikey: apiKey,
    timezone: 'UTC',
    order: 'ASC',
    outputsize: String(MAX_OUTPUT),
    start_date: tdDate(startTs),
    end_date: tdDate(windowEnd),
  });

  const res = await fetch(`${BASE}/time_series?${params}`);
  if (res.status === 429 || res.status >= 500) {
    throw new Error(`Twelve Data ${res.status} — reintentable`);
  }

  const body = (await res.json()) as TdResponse;

  if (body.status === 'error' || body.code) {
    // 429 llega a veces como body {code: 429} con HTTP 200
    if (body.code === 429) throw new Error(`Twelve Data rate limit: ${body.message}`);
    // ventana sin datos (fin de semana, festivo, mercado cerrado) → no es fallo
    if (body.code === 400 && /no data is available/i.test(body.message ?? '')) {
      return { candles: [], windowEnd, hasMore };
    }
    throw new Error(`Twelve Data error ${body.code}: ${body.message}`);
  }

  const candles = (body.values ?? [])
    .map((v): Candle => ({
      ts: Date.parse(v.datetime.replace(' ', 'T') + 'Z'),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: Number(v.volume ?? 0),
    }))
    .filter((c) => Number.isFinite(c.ts) && Number.isFinite(c.close))
    .sort((a, b) => a.ts - b.ts);

  return { candles, windowEnd, hasMore };
}
