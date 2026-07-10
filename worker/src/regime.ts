import { adx, atr, ema, slopePct } from './indicators';
import type { Candle, Direction } from './types';

/* Detección de régimen de mercado (módulo puro, estilo risk.ts: velas →
   etiqueta, cero I/O). Un único juego de umbrales para todo el sistema:
   la anotación por señal (workflow), el dossier IA (enrich), el scoring y
   /api/market-state consumen este módulo en vez de duplicar heurísticas.

   Prioridad de clasificación:
   1. HIGH_VOLATILITY  — ATR% en el percentil alto de su propia historia
   2. TRENDING_UP/DOWN — ADX con fuerza y pendiente EMA50 / DI dominante
   3. LOW_VOLATILITY   — ATR% en el percentil bajo y sin tendencia
   4. RANGE            — resto */

export type MarketRegime =
  | 'TRENDING_UP'
  | 'TRENDING_DOWN'
  | 'RANGE'
  | 'HIGH_VOLATILITY'
  | 'LOW_VOLATILITY';

export interface RegimeInfo {
  regime: MarketRegime;
  adx: number;          // ADX(14) en la vela
  emaSlopePct: number;  // pendiente EMA50 (% por vela, lookback 20)
  atrPct: number;       // ATR(14) como % del precio
  atrPercentile: number; // percentil del ATR% actual sobre su historia reciente
}

/** Umbrales del clasificador (exportados para tests y documentación). */
export const REGIME_THRESHOLDS = {
  adxTrend: 22,          // ADX mínimo para considerar tendencia
  slopeTrend: 0.008,     // |pendiente EMA50| mínima (%/vela) para dirección
  highVolPercentile: 0.85,
  lowVolPercentile: 0.15,
  // el percentil solo ordena; para HIGH/LOW se exige además diferencia
  // material frente a la mediana (evita extremos por deriva microscópica)
  highVolRatio: 1.4,     // ATR% actual >= 1.4× mediana de la ventana
  lowVolRatio: 0.7,      // ATR% actual <= 0.7× mediana
  volWindow: 240,        // velas de historia para el percentil de ATR%
  minBars: 120,          // mínimo para clasificar (ADX estable + percentil útil)
} as const;

/**
 * Prepara un clasificador de régimen sobre una serie de velas ascendentes.
 * Los indicadores se calculan una sola vez; clasificar un índice es O(volWindow).
 * Pensado para anotar muchas señales históricas del mismo mercado por pasada.
 */
export function makeRegimeCalculator(
  candles: Candle[],
): (index?: number) => RegimeInfo | null {
  const closes = candles.map((c) => c.close);
  const atr14 = atr(candles, 14);
  const ema50 = ema(closes, 50);
  const { adx: adx14, plusDi, minusDi } = adx(candles, 14);

  // serie de ATR% para percentiles (alineada por índice)
  const atrPcts = atr14.map((a, i) =>
    Number.isFinite(a) && closes[i] > 0 ? (a / closes[i]) * 100 : NaN,
  );

  return (index?: number): RegimeInfo | null => {
    const i = index ?? candles.length - 1;
    if (i < REGIME_THRESHOLDS.minBars || i >= candles.length) return null;

    const a = adx14[i];
    const atrPct = atrPcts[i];
    if (!Number.isFinite(a) || !Number.isFinite(atrPct)) return null;

    const slope = slopePct(ema50, i, 20);

    // percentil (rango medio) del ATR% actual dentro de su ventana reciente:
    // los empates cuentan medio punto para que una serie de volatilidad
    // constante quede en 0.5 (ni HIGH ni LOW) en vez de en un extremo
    let below = 0;
    let equal = 0;
    const window: number[] = [];
    const start = Math.max(0, i - REGIME_THRESHOLDS.volWindow);
    for (let j = start; j <= i; j++) {
      const v = atrPcts[j];
      if (!Number.isFinite(v)) continue;
      window.push(v);
      if (v < atrPct) below++;
      else if (v === atrPct) equal++;
    }
    const total = window.length;
    const atrPercentile = total > 0 ? (below + 0.5 * equal) / total : 0.5;
    const median = total > 0
      ? window.slice().sort((x, y) => x - y)[Math.floor(total / 2)]
      : atrPct;

    let regime: MarketRegime;
    const t = REGIME_THRESHOLDS;
    if (atrPercentile >= t.highVolPercentile && atrPct >= median * t.highVolRatio) {
      regime = 'HIGH_VOLATILITY';
    } else if (a >= t.adxTrend && Math.abs(slope) >= t.slopeTrend) {
      regime = slope > 0 ? 'TRENDING_UP' : 'TRENDING_DOWN';
    } else if (a >= t.adxTrend && Math.abs(plusDi[i] - minusDi[i]) >= 6) {
      // ADX fuerte con EMA plana: la dirección la dan los DI
      regime = plusDi[i] > minusDi[i] ? 'TRENDING_UP' : 'TRENDING_DOWN';
    } else if (atrPercentile <= t.lowVolPercentile && atrPct <= median * t.lowVolRatio) {
      regime = 'LOW_VOLATILITY';
    } else {
      regime = 'RANGE';
    }

    return {
      regime,
      adx: Math.round(a * 10) / 10,
      emaSlopePct: Math.round(slope * 1000) / 1000,
      atrPct: Math.round(atrPct * 100) / 100,
      atrPercentile: Math.round(atrPercentile * 100) / 100,
    };
  };
}

/** Clasificación puntual (una sola vela); para lotes usar el calculator. */
export function regimeAt(candles: Candle[], index?: number): RegimeInfo | null {
  return makeRegimeCalculator(candles)(index);
}

/** ¿La dirección opera a favor del régimen? null si el régimen no direcciona. */
export function regimeAligned(
  regime: MarketRegime | null | undefined,
  direction: Direction,
): boolean | null {
  if (regime === 'TRENDING_UP') return direction === 'buy';
  if (regime === 'TRENDING_DOWN') return direction === 'sell';
  return null;
}

/** Etiqueta legible en español para dossieres y UI. */
export const REGIME_LABEL: Record<MarketRegime, string> = {
  TRENDING_UP: 'tendencia alcista',
  TRENDING_DOWN: 'tendencia bajista',
  RANGE: 'rango lateral',
  HIGH_VOLATILITY: 'volatilidad alta',
  LOW_VOLATILITY: 'volatilidad baja',
};

/**
 * Frase de régimen para el dossier IA: estado actual + rendimiento REAL del
 * patrón bajo este régimen si hay muestra (jurisprudencia condicionada).
 */
export function describeRegime(
  info: RegimeInfo,
  direction: Direction,
  patternRegimeStats?: { total: number; tpRate: number; avgRr: number } | null,
): string {
  let s = `Régimen de mercado: ${info.regime} (${REGIME_LABEL[info.regime]}; ADX ${info.adx}, pendiente EMA50 ${info.emaSlopePct}%/vela, ATR ${info.atrPct}% en percentil ${Math.round(info.atrPercentile * 100)}).`;

  const aligned = regimeAligned(info.regime, direction);
  if (aligned === true) s += ' La señal opera a favor del régimen.';
  else if (aligned === false) s += ' La señal opera CONTRA el régimen dominante.';

  if (patternRegimeStats && patternRegimeStats.total >= 10) {
    const pct = Math.round(patternRegimeStats.tpRate * 100);
    s += ` Este patrón bajo este régimen acierta ${pct}% en ${patternRegimeStats.total} cierres reales de este mercado.`;
  }
  return s;
}
