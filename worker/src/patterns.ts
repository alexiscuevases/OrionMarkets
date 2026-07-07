import { atr, ema, rsi, swings, type Swing } from './indicators';
import type { Candle, DetectedSignal, Direction } from './types';

/* Detectores deterministas de patrones.
   Cada detector recorre TODO el histórico (no solo la última vela), por lo
   que también identifica compras/ventas pasadas. La clave sig_key hace las
   inserciones idempotentes entre ejecuciones.

   Convención de niveles: entry = cierre de la vela de confirmación;
   stop y target derivados de la estructura del patrón; confidence 0-100
   calculada solo con reglas (sin IA). */

interface Ctx {
  candles: Candle[];
  closes: number[];
  ema20: number[];
  ema50: number[];
  ema200: number[];
  rsi14: number[];
  atr14: number[];
  swingList: Swing[];
}

type Detector = (ctx: Ctx) => RawSignal[];

interface RawSignal {
  index: number;
  pattern: string;
  direction: Direction;
  stop: number;
  target: number;
  confidence: number;
}

const MIN_BARS = 220; // se necesita EMA200 estable

export function detectAll(
  symbol: string,
  interval: string,
  candles: Candle[],
): DetectedSignal[] {
  if (candles.length < MIN_BARS) return [];

  const closes = candles.map((c) => c.close);
  const ctx: Ctx = {
    candles,
    closes,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi14: rsi(closes, 14),
    atr14: atr(candles, 14),
    swingList: swings(candles, 3),
  };

  const detectors: Detector[] = [
    emaCross,
    rsiDivergence,
    engulfing,
    pinBar,
    doubleTopBottom,
    flag,
    rangeBreakout,
  ];

  const out: DetectedSignal[] = [];
  for (const detect of detectors) {
    for (const raw of detect(ctx)) {
      const candle = candles[raw.index];
      const entry = candle.close;
      const risk = Math.abs(entry - raw.stop);
      if (risk <= 0) continue;
      const rr = Math.abs(raw.target - entry) / risk;
      if (rr < 1) continue; // descartamos operaciones con RR < 1

      out.push({
        sigKey: `${symbol}|${interval}|${candle.ts}|${raw.pattern}`,
        symbol,
        interval,
        ts: candle.ts,
        pattern: raw.pattern,
        direction: raw.direction,
        entry: round6(entry),
        stop: round6(raw.stop),
        target: round6(raw.target),
        rr: Math.round(rr * 100) / 100,
        confidence: Math.max(0, Math.min(100, Math.round(raw.confidence))),
      });
    }
  }
  return out;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Bonus de confluencia con la tendencia de fondo (EMA200). */
function trendBonus(ctx: Ctx, i: number, dir: Direction): number {
  const above = ctx.closes[i] > ctx.ema200[i];
  return (dir === 'buy') === above ? 12 : -8;
}

/* ---------- 1. Cruce EMA 20/50 ---------- */

function emaCross(ctx: Ctx): RawSignal[] {
  const out: RawSignal[] = [];
  for (let i = MIN_BARS; i < ctx.candles.length; i++) {
    const prevDiff = ctx.ema20[i - 1] - ctx.ema50[i - 1];
    const diff = ctx.ema20[i] - ctx.ema50[i];
    if (!Number.isFinite(prevDiff) || !Number.isFinite(diff)) continue;
    if (prevDiff === 0 || Math.sign(prevDiff) === Math.sign(diff)) continue;

    const dir: Direction = diff > 0 ? 'buy' : 'sell';
    const a = ctx.atr14[i];
    const c = ctx.candles[i];
    const stop = dir === 'buy' ? c.close - a * 2 : c.close + a * 2;
    const target = dir === 'buy' ? c.close + a * 3.5 : c.close - a * 3.5;

    // separación posterior de las medias como medida de fuerza del cruce
    const strength = Math.min(10, (Math.abs(diff) / a) * 20);
    out.push({
      index: i,
      pattern: 'Cruce EMA 20/50',
      direction: dir,
      stop,
      target,
      confidence: 52 + strength + trendBonus(ctx, i, dir),
    });
  }
  return out;
}

/* ---------- 2. Divergencia RSI ---------- */

function rsiDivergence(ctx: Ctx): RawSignal[] {
  const out: RawSignal[] = [];
  const lows = ctx.swingList.filter((s) => s.kind === 'low');
  const highs = ctx.swingList.filter((s) => s.kind === 'high');

  const scan = (pivots: Swing[], dir: Direction) => {
    for (let k = 1; k < pivots.length; k++) {
      const p1 = pivots[k - 1];
      const p2 = pivots[k];
      const span = p2.index - p1.index;
      if (span < 8 || span > 60) continue;

      const r1 = ctx.rsi14[p1.index];
      const r2 = ctx.rsi14[p2.index];
      if (!Number.isFinite(r1) || !Number.isFinite(r2)) continue;

      const divergent =
        dir === 'buy'
          ? p2.price < p1.price && r2 > r1 + 3 && r2 < 45 // precio hace mínimo menor, RSI mínimo mayor
          : p2.price > p1.price && r2 < r1 - 3 && r2 > 55;
      if (!divergent) continue;

      const i = Math.min(p2.index + 3, ctx.candles.length - 1); // confirmación 3 velas después del pivote
      const a = ctx.atr14[i];
      if (!Number.isFinite(a)) continue;
      const stop = dir === 'buy' ? p2.price - a * 0.8 : p2.price + a * 0.8;
      const c = ctx.candles[i];
      const target = dir === 'buy' ? c.close + Math.abs(c.close - stop) * 2 : c.close - Math.abs(c.close - stop) * 2;

      const extreme = dir === 'buy' ? Math.max(0, 40 - r2) : Math.max(0, r2 - 60);
      out.push({
        index: i,
        pattern: 'Divergencia RSI',
        direction: dir,
        stop,
        target,
        confidence: 56 + Math.min(14, extreme) + trendBonus(ctx, i, dir),
      });
    }
  };

  scan(lows, 'buy');
  scan(highs, 'sell');
  return out;
}

/* ---------- 3. Envolvente en extremo ---------- */

function engulfing(ctx: Ctx): RawSignal[] {
  const out: RawSignal[] = [];
  for (let i = MIN_BARS; i < ctx.candles.length; i++) {
    const prev = ctx.candles[i - 1];
    const c = ctx.candles[i];
    const a = ctx.atr14[i];
    if (!Number.isFinite(a)) continue;

    const prevBody = Math.abs(prev.close - prev.open);
    const body = Math.abs(c.close - c.open);
    if (body < a * 0.9 || body < prevBody * 1.4) continue; // cuerpo dominante

    const bull = c.close > c.open && prev.close < prev.open
      && c.close > prev.open && c.open < prev.close;
    const bear = c.close < c.open && prev.close > prev.open
      && c.close < prev.open && c.open > prev.close;
    if (!bull && !bear) continue;

    // solo interesa en zona extrema del rango reciente
    const win = ctx.candles.slice(Math.max(0, i - 20), i);
    const hh = Math.max(...win.map((x) => x.high));
    const ll = Math.min(...win.map((x) => x.low));
    const posPct = (c.close - ll) / Math.max(hh - ll, 1e-9);
    if (bull && posPct > 0.35) continue;  // envolvente alcista solo cerca del suelo
    if (bear && posPct < 0.65) continue;

    const dir: Direction = bull ? 'buy' : 'sell';
    const stop = bull ? Math.min(c.low, prev.low) - a * 0.3 : Math.max(c.high, prev.high) + a * 0.3;
    const risk = Math.abs(c.close - stop);
    const target = bull ? c.close + risk * 2 : c.close - risk * 2;

    out.push({
      index: i,
      pattern: bull ? 'Envolvente alcista' : 'Envolvente bajista',
      direction: dir,
      stop,
      target,
      confidence: 55 + Math.min(12, (body / a) * 6) + trendBonus(ctx, i, dir),
    });
  }
  return out;
}

/* ---------- 4. Pin bar en soporte/resistencia ---------- */

function pinBar(ctx: Ctx): RawSignal[] {
  const out: RawSignal[] = [];
  for (let i = MIN_BARS; i < ctx.candles.length; i++) {
    const c = ctx.candles[i];
    const a = ctx.atr14[i];
    if (!Number.isFinite(a)) continue;

    const range = c.high - c.low;
    if (range < a * 1.1) continue;
    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;

    const bullPin = lowerWick > range * 0.62 && body < range * 0.25;
    const bearPin = upperWick > range * 0.62 && body < range * 0.25;
    if (!bullPin && !bearPin) continue;

    // la mecha debe barrer un pivote previo (soporte/resistencia)
    const level = ctx.swingList.find(
      (s) =>
        s.index < i - 3 && s.index > i - 80 &&
        (bullPin
          ? s.kind === 'low' && Math.abs(s.price - c.low) < a * 0.6
          : s.kind === 'high' && Math.abs(s.price - c.high) < a * 0.6),
    );
    if (!level) continue;

    const dir: Direction = bullPin ? 'buy' : 'sell';
    const stop = bullPin ? c.low - a * 0.25 : c.high + a * 0.25;
    const risk = Math.abs(c.close - stop);
    const target = bullPin ? c.close + risk * 2.2 : c.close - risk * 2.2;

    out.push({
      index: i,
      pattern: bullPin ? 'Pin bar en soporte' : 'Pin bar en resistencia',
      direction: dir,
      stop,
      target,
      confidence: 58 + trendBonus(ctx, i, dir),
    });
  }
  return out;
}

/* ---------- 5. Doble suelo / doble techo ---------- */

function doubleTopBottom(ctx: Ctx): RawSignal[] {
  const out: RawSignal[] = [];

  const scan = (kind: 'low' | 'high') => {
    const pivots = ctx.swingList.filter((s) => s.kind === kind);
    for (let k = 1; k < pivots.length; k++) {
      const p1 = pivots[k - 1];
      const p2 = pivots[k];
      const span = p2.index - p1.index;
      if (span < 10 || span > 90) continue;

      const a = ctx.atr14[p2.index];
      if (!Number.isFinite(a)) continue;
      if (Math.abs(p1.price - p2.price) > a * 0.7) continue; // mismos niveles

      // neckline: extremo opuesto entre ambos pivotes
      const between = ctx.candles.slice(p1.index, p2.index + 1);
      const neckline = kind === 'low'
        ? Math.max(...between.map((c) => c.high))
        : Math.min(...between.map((c) => c.low));

      // confirmación: cierre que rompe la neckline tras el segundo pivote
      const dir: Direction = kind === 'low' ? 'buy' : 'sell';
      let confirmIdx = -1;
      const limit = Math.min(p2.index + 40, ctx.candles.length);
      for (let i = p2.index + 1; i < limit; i++) {
        const brk = dir === 'buy'
          ? ctx.candles[i].close > neckline
          : ctx.candles[i].close < neckline;
        if (brk) { confirmIdx = i; break; }
      }
      if (confirmIdx < MIN_BARS) continue;

      const c = ctx.candles[confirmIdx];
      const stop = dir === 'buy' ? p2.price - a * 0.5 : p2.price + a * 0.5;
      const height = Math.abs(neckline - p2.price);
      const target = dir === 'buy' ? c.close + height : c.close - height; // proyección de la figura

      out.push({
        index: confirmIdx,
        pattern: kind === 'low' ? 'Doble suelo' : 'Doble techo',
        direction: dir,
        stop,
        target,
        confidence: 62 + trendBonus(ctx, confirmIdx, dir),
      });
    }
  };

  scan('low');
  scan('high');
  return out;
}

/* ---------- 6. Bandera (bull/bear flag) ---------- */

function flag(ctx: Ctx): RawSignal[] {
  const out: RawSignal[] = [];
  const POLE = 8;   // velas del impulso
  const FLAG_MIN = 4;
  const FLAG_MAX = 14;

  for (let i = MIN_BARS; i < ctx.candles.length; i++) {
    const a = ctx.atr14[i];
    if (!Number.isFinite(a)) continue;

    for (const dir of ['buy', 'sell'] as const) {
      // 1) mástil: movimiento fuerte en POLE velas
      const poleEnd = i;
      const poleStart = poleEnd - POLE;
      if (poleStart < 0) continue;
      const move = ctx.closes[poleEnd] - ctx.closes[poleStart];
      const strongPole = dir === 'buy' ? move > a * 3 : move < -a * 3;
      if (!strongPole) continue;

      // 2) bandera: consolidación estrecha con deriva contraria suave
      let flagEnd = -1;
      for (let len = FLAG_MIN; len <= FLAG_MAX; len++) {
        const j = poleEnd + len;
        if (j >= ctx.candles.length) break;
        const seg = ctx.candles.slice(poleEnd + 1, j + 1);
        const hh = Math.max(...seg.map((c) => c.high));
        const ll = Math.min(...seg.map((c) => c.low));
        if (hh - ll > Math.abs(move) * 0.5) break; // demasiado ancha → no es bandera

        const drift = seg[seg.length - 1].close - seg[0].close;
        const gentleCounter = dir === 'buy' ? drift <= 0 : drift >= 0;

        // 3) ruptura en la dirección del mástil
        const breakout = dir === 'buy'
          ? ctx.candles[j].close > hh - 1e-12 && ctx.candles[j].close > seg[0].high
          : ctx.candles[j].close < ll + 1e-12 && ctx.candles[j].close < seg[0].low;

        if (gentleCounter && breakout) { flagEnd = j; break; }
      }
      if (flagEnd < 0) continue;

      const c = ctx.candles[flagEnd];
      const seg = ctx.candles.slice(poleEnd + 1, flagEnd + 1);
      const stop = dir === 'buy'
        ? Math.min(...seg.map((x) => x.low)) - a * 0.3
        : Math.max(...seg.map((x) => x.high)) + a * 0.3;
      const target = dir === 'buy' ? c.close + Math.abs(move) * 0.8 : c.close - Math.abs(move) * 0.8;

      out.push({
        index: flagEnd,
        pattern: dir === 'buy' ? 'Bandera alcista' : 'Bandera bajista',
        direction: dir,
        stop,
        target,
        confidence: 60 + Math.min(10, (Math.abs(move) / a - 3) * 3) + trendBonus(ctx, flagEnd, dir),
      });
      i = flagEnd; // no re-detectar la misma estructura
    }
  }
  return out;
}

/* ---------- 7. Ruptura de rango (Donchian) ---------- */

function rangeBreakout(ctx: Ctx): RawSignal[] {
  const out: RawSignal[] = [];
  const N = 40;

  for (let i = MIN_BARS; i < ctx.candles.length; i++) {
    const a = ctx.atr14[i];
    if (!Number.isFinite(a)) continue;

    const win = ctx.candles.slice(i - N, i);
    const hh = Math.max(...win.map((c) => c.high));
    const ll = Math.min(...win.map((c) => c.low));
    const width = hh - ll;
    if (width > a * 8) continue; // solo rangos comprimidos

    const c = ctx.candles[i];
    let dir: Direction | null = null;
    if (c.close > hh + a * 0.15) dir = 'buy';
    else if (c.close < ll - a * 0.15) dir = 'sell';
    if (!dir) continue;

    const stop = (hh + ll) / 2; // mitad del rango roto
    const target = dir === 'buy' ? c.close + width : c.close - width;

    out.push({
      index: i,
      pattern: 'Ruptura de rango',
      direction: dir,
      stop,
      target,
      confidence: 57 + Math.min(10, (a * 8 - width) / a) + trendBonus(ctx, i, dir),
    });
    i += 5; // evita señales duplicadas en velas consecutivas
  }
  return out;
}

/* ---------- Resolución de resultados históricos ---------- */

/**
 * Recorre las velas posteriores a la señal y decide si tocó TP o SL.
 * Si tras `maxBars` no tocó ninguno → 'expired'. Determinista: si en la
 * misma vela caben ambos, gana el SL (criterio conservador).
 */
export function resolveOutcome(
  signal: { ts: number; direction: Direction; stop: number; target: number },
  candles: Candle[],
  maxBars = 400,
): { outcome: 'open' | 'tp_hit' | 'sl_hit' | 'expired'; outcomeTs: number | null } {
  const startIdx = candles.findIndex((c) => c.ts > signal.ts);
  if (startIdx < 0) return { outcome: 'open', outcomeTs: null };

  const end = Math.min(startIdx + maxBars, candles.length);
  for (let i = startIdx; i < end; i++) {
    const c = candles[i];
    const slHit = signal.direction === 'buy' ? c.low <= signal.stop : c.high >= signal.stop;
    if (slHit) return { outcome: 'sl_hit', outcomeTs: c.ts };
    const tpHit = signal.direction === 'buy' ? c.high >= signal.target : c.low <= signal.target;
    if (tpHit) return { outcome: 'tp_hit', outcomeTs: c.ts };
  }

  if (end - startIdx >= maxBars) {
    return { outcome: 'expired', outcomeTs: candles[end - 1].ts };
  }
  return { outcome: 'open', outcomeTs: null };
}
