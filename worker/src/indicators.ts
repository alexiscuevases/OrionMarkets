import type { Candle } from './types';

/* Indicadores puros sobre arrays de velas ascendentes.
   Devuelven arrays alineados por índice (NaN donde no hay dato). */

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function atr(candles: Candle[], period = 14): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length <= period) return out;

  const trs: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    ));
  }

  let prev = trs.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** ADX de Wilder con sus componentes direccionales (+DI/−DI). */
export interface AdxResult {
  adx: number[];
  plusDi: number[];
  minusDi: number[];
}

export function adx(candles: Candle[], period = 14): AdxResult {
  const n = candles.length;
  const out: AdxResult = {
    adx: new Array<number>(n).fill(NaN),
    plusDi: new Array<number>(n).fill(NaN),
    minusDi: new Array<number>(n).fill(NaN),
  };
  if (n <= period * 2) return out;

  // movimiento direccional y true range por vela
  const plusDm: number[] = [0];
  const minusDm: number[] = [0];
  const trs: number[] = [0];
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose),
    ));
  }

  // suavizado de Wilder de TR y DMs
  let trS = trs.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let plusS = plusDm.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let minusS = minusDm.slice(1, period + 1).reduce((a, b) => a + b, 0);

  const dxs = new Array<number>(n).fill(NaN);
  for (let i = period; i < n; i++) {
    if (i > period) {
      trS = trS - trS / period + trs[i];
      plusS = plusS - plusS / period + plusDm[i];
      minusS = minusS - minusS / period + minusDm[i];
    }
    const pDi = trS === 0 ? 0 : (plusS / trS) * 100;
    const mDi = trS === 0 ? 0 : (minusS / trS) * 100;
    out.plusDi[i] = pDi;
    out.minusDi[i] = mDi;
    const sum = pDi + mDi;
    dxs[i] = sum === 0 ? 0 : (Math.abs(pDi - mDi) / sum) * 100;
  }

  // ADX: media de Wilder del DX
  let adxPrev = 0;
  for (let i = period; i < period * 2; i++) adxPrev += dxs[i];
  adxPrev /= period;
  out.adx[period * 2 - 1] = adxPrev;
  for (let i = period * 2; i < n; i++) {
    adxPrev = (adxPrev * (period - 1) + dxs[i]) / period;
    out.adx[i] = adxPrev;
  }
  return out;
}

export interface Swing {
  index: number;
  price: number;
  kind: 'high' | 'low';
}

/** Pivotes fractales: extremo local con `wing` velas a cada lado. */
export function swings(candles: Candle[], wing = 3): Swing[] {
  const out: Swing[] = [];
  for (let i = wing; i < candles.length - wing; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: candles[i].high, kind: 'high' });
    if (isLow) out.push({ index: i, price: candles[i].low, kind: 'low' });
  }
  return out;
}

/** Pendiente normalizada (% por vela) de una serie en las últimas n velas. */
export function slopePct(values: number[], endIndex: number, lookback: number): number {
  const start = endIndex - lookback;
  if (start < 0) return 0;
  const a = values[start];
  const b = values[endIndex];
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return 0;
  return ((b - a) / a / lookback) * 100;
}

/** Correlación de Pearson entre dos series de retornos. */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 10) return 0;
  const xa = a.slice(-n);
  const xb = b.slice(-n);
  const ma = xa.reduce((s, v) => s + v, 0) / n;
  const mb = xb.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = xa[i] - ma;
    const db = xb[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  const denom = Math.sqrt(va * vb);
  return denom === 0 ? 0 : cov / denom;
}

export function returns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return out;
}
