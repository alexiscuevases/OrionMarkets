import type { Candle, Direction } from './types';

/* Estructura Smart Money para el dossier de la IA — la misma lectura que la
   capa visual del frontend (src/charts/smc.ts), calculada aquí sobre las
   velas del dossier para que la IA y el scoring la tengan en cuenta:

   - zona institucional (order block): última vela contraria antes de un
     impulso fuerte, sin mitigar y por delante del precio
   - liquidez: máximos/mínimos iguales (2+ toques) aún sin barrer
   - structuralBias: lectura agregada para la dirección de la señal

   Determinista y sin look-ahead: opera sobre las velas <= asOf que le pasa
   buildContext. */

export interface SmcZoneInfo {
  low: number;
  high: number;
  /** distancia del precio al borde cercano de la zona, % del precio */
  distancePct: number;
}

export interface SmcLiquidityInfo {
  price: number;
  touches: number;
  distancePct: number;
}

export interface SmcSummary {
  /** zona de demanda sin mitigar más cercana por debajo del precio */
  demandZone: SmcZoneInfo | null;
  /** zona de oferta sin mitigar más cercana por encima del precio */
  supplyZone: SmcZoneInfo | null;
  /** máximos iguales sin barrer por encima (imán de stops de cortos) */
  buySideLiquidity: SmcLiquidityInfo | null;
  /** mínimos iguales sin barrer por debajo (imán de stops de largos) */
  sellSideLiquidity: SmcLiquidityInfo | null;
  /** lectura estructural para la dirección de la señal */
  structuralBias: 'apoya' | 'en contra' | 'neutral';
}

const LOOKBACK = 240;
const IMPULSE_ATR = 1.6;
const ZONE_MAX_ATR = 1.5;
const CLUSTER_TOL_ATR = 0.3;

export function smcSummary(candles: Candle[], direction: Direction): SmcSummary | null {
  if (candles.length < 40) return null;
  const win = candles.slice(-Math.min(LOOKBACK, candles.length));
  const close = win[win.length - 1].close;

  let trSum = 0;
  for (let i = 1; i < win.length; i++) {
    const prev = win[i - 1].close;
    trSum += Math.max(
      win[i].high - win[i].low,
      Math.abs(win[i].high - prev),
      Math.abs(win[i].low - prev),
    );
  }
  const atr = trSum / (win.length - 1);
  if (atr <= 0) return null;

  const pct = (dist: number) => Math.round((dist / close) * 10000) / 100;

  /* ---- order blocks sin mitigar, el más cercano por lado ---- */

  const zones: { kind: 'demand' | 'supply'; from: number; low: number; high: number }[] = [];
  for (let i = 0; i < win.length - 3; i++) {
    const c = win[i];
    const move = win[i + 3].close - c.close;
    if (c.close < c.open && move >= IMPULSE_ATR * atr) {
      zones.push({
        kind: 'demand', from: c.ts,
        low: c.low, high: Math.min(c.open, c.low + ZONE_MAX_ATR * atr),
      });
    } else if (c.close > c.open && -move >= IMPULSE_ATR * atr) {
      zones.push({
        kind: 'supply', from: c.ts,
        low: Math.max(c.open, c.high - ZONE_MAX_ATR * atr), high: c.high,
      });
    }
  }

  const unmitigated = zones.filter((z) => {
    for (const c of win) {
      if (c.ts <= z.from) continue;
      if (z.kind === 'demand' && c.close < z.low) return false;
      if (z.kind === 'supply' && c.close > z.high) return false;
    }
    return z.kind === 'demand' ? z.high <= close : z.low >= close;
  });

  const demand = unmitigated
    .filter((z) => z.kind === 'demand')
    .sort((a, b) => b.high - a.high)[0] ?? null;
  const supply = unmitigated
    .filter((z) => z.kind === 'supply')
    .sort((a, b) => a.low - b.low)[0] ?? null;

  const demandZone: SmcZoneInfo | null = demand
    ? { low: demand.low, high: demand.high, distancePct: pct(close - demand.high) }
    : null;
  const supplyZone: SmcZoneInfo | null = supply
    ? { low: supply.low, high: supply.high, distancePct: pct(supply.low - close) }
    : null;

  /* ---- liquidez sin barrer, la más cercana por lado ---- */

  const wing = 3;
  const tol = CLUSTER_TOL_ATR * atr;
  const pivots = (side: 'high' | 'low'): { price: number; ts: number }[] => {
    const out: { price: number; ts: number }[] = [];
    for (let i = wing; i < win.length - wing; i++) {
      let extreme = true;
      for (let j = i - wing; j <= i + wing && extreme; j++) {
        if (j === i) continue;
        if (side === 'high' ? win[j].high >= win[i].high : win[j].low <= win[i].low) {
          extreme = false;
        }
      }
      if (extreme) out.push({ price: side === 'high' ? win[i].high : win[i].low, ts: win[i].ts });
    }
    return out;
  };

  const nearestLiquidity = (side: 'buy' | 'sell'): SmcLiquidityInfo | null => {
    const points = pivots(side === 'buy' ? 'high' : 'low')
      .sort((a, b) => a.price - b.price);
    const levels: SmcLiquidityInfo[] = [];
    let group: { price: number; ts: number }[] = [];

    const flush = () => {
      if (group.length < 2) { group = []; return; }
      const level = side === 'buy'
        ? Math.max(...group.map((p) => p.price))
        : Math.min(...group.map((p) => p.price));
      const lastTouch = Math.max(...group.map((p) => p.ts));
      const swept = win.some((c) =>
        c.ts > lastTouch && (side === 'buy' ? c.high > level : c.low < level));
      const ahead = side === 'buy' ? level > close : level < close;
      if (!swept && ahead) {
        levels.push({ price: level, touches: group.length, distancePct: pct(Math.abs(level - close)) });
      }
      group = [];
    };

    for (const p of points) {
      if (group.length === 0 || p.price - group[group.length - 1].price <= tol) group.push(p);
      else { flush(); group = [p]; }
    }
    flush();
    return levels.sort((a, b) => a.distancePct - b.distancePct)[0] ?? null;
  };

  const buySideLiquidity = nearestLiquidity('buy');
  const sellSideLiquidity = nearestLiquidity('sell');

  /* ---- lectura agregada para la dirección de la señal ---- */

  const atrPct = pct(atr);
  let pts = 0;
  if (direction === 'buy') {
    if (demandZone && demandZone.distancePct <= 1.5 * atrPct) pts += 1; // respaldo debajo
    if (buySideLiquidity) pts += 1;                                     // imán por delante
    if (supplyZone && supplyZone.distancePct <= 1.0 * atrPct) pts -= 2; // techo inmediato
    if (!buySideLiquidity && sellSideLiquidity) pts -= 1;               // la liquidez tira en contra
  } else {
    if (supplyZone && supplyZone.distancePct <= 1.5 * atrPct) pts += 1;
    if (sellSideLiquidity) pts += 1;
    if (demandZone && demandZone.distancePct <= 1.0 * atrPct) pts -= 2; // suelo inmediato
    if (!sellSideLiquidity && buySideLiquidity) pts -= 1;
  }

  return {
    demandZone,
    supplyZone,
    buySideLiquidity,
    sellSideLiquidity,
    structuralBias: pts > 0 ? 'apoya' : pts < 0 ? 'en contra' : 'neutral',
  };
}
