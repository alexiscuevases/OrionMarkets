import type { Candle } from './types';

/* Cliente mínimo de Twelve Data (https://twelvedata.com/docs).
   Endpoint time_series: OHLC por símbolo + intervalo.
   Plan gratuito: 8 créditos/min y 800/día — el workflow espacia las
   peticiones con step.sleep, aquí solo se hace 1 request por llamada. */

const BASE = 'https://api.twelvedata.com';
export const MAX_OUTPUT = 5000; // límite de outputsize por petición

/** EURUSD → EUR/USD (formato de símbolo de Twelve Data). */
function tdSymbol(symbol: string): string {
  return `${symbol.slice(0, 3)}/${symbol.slice(3)}`;
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
  /** true si la respuesta vino llena → probablemente queda histórico por pedir */
  hasMore: boolean;
}

/**
 * Pide velas ASC desde `startTs` (exclusivo si es un cursor previo).
 * Lanza Error en fallos transitorios (429/5xx) para que el workflow reintente.
 */
export async function fetchSeries(
  apiKey: string,
  symbol: string,
  interval: string,
  startTs: number,
): Promise<FetchResult> {
  const params = new URLSearchParams({
    symbol: tdSymbol(symbol),
    interval,
    apikey: apiKey,
    timezone: 'UTC',
    order: 'ASC',
    outputsize: String(MAX_OUTPUT),
    start_date: new Date(startTs).toISOString().slice(0, 19).replace('T', ' '),
  });

  const res = await fetch(`${BASE}/time_series?${params}`);
  if (res.status === 429 || res.status >= 500) {
    throw new Error(`Twelve Data ${res.status} — reintentable`);
  }

  const body = (await res.json()) as TdResponse;

  if (body.status === 'error' || body.code) {
    // 429 llega a veces como body {code: 429} con HTTP 200
    if (body.code === 429) throw new Error(`Twelve Data rate limit: ${body.message}`);
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

  return { candles, hasMore: candles.length >= MAX_OUTPUT };
}
