import type { Direction } from './types';

/* Módulo de riesgo (Fase 4) — funciones puras, sin dependencias de
   Cloudflare, para que backtesting, paper trading y la API usen
   exactamente el mismo cálculo.

   Convenciones FX:
   - Cuenta denominada en USD.
   - 1 lote estándar = 100.000 unidades de la divisa base.
   - pip = 0.0001 (0.01 en pares con JPY como divisa cotizada).
   - P/L de un par BASE/QUOTE = unidades × Δprecio, expresado en QUOTE.
     Conversión a USD:
       · QUOTE = USD (EURUSD, GBPUSD…): 1 unidad de precio = 1 USD/unidad.
       · BASE = USD (USDJPY…): se divide por el precio (aprox. al precio actual).
     Para cruces sin USD haría falta el tipo de conversión del QUOTE;
     `quoteToUsd` permite inyectarlo cuando el universo crezca. */

export interface RiskInput {
  balance: number;      // balance de la cuenta en USD
  riskPct: number;      // % del balance a arriesgar (0-100)
  entry: number;
  stop: number;
  symbol: string;       // p. ej. 'EURUSD'
  /** Conversión QUOTE→USD para cruces sin USD; por defecto se infiere. */
  quoteToUsd?: number;
}

export interface PositionSize {
  riskAmount: number;        // USD arriesgados hasta el stop
  stopDistance: number;      // distancia entrada-stop en precio
  stopDistancePips: number;
  units: number;             // unidades de divisa base
  lots: number;              // lotes estándar (100k)
  valuePerPip: number;       // USD por pip con este tamaño
  notional: number;          // valor nominal aproximado en USD
}

export function pipSize(symbol: string): number {
  return symbol.slice(3) === 'JPY' ? 0.01 : 0.0001;
}

/** USD ganados/perdidos por unidad de base y unidad de precio. */
function usdPerUnitPerPrice(symbol: string, price: number, quoteToUsd?: number): number {
  const quote = symbol.slice(3);
  if (quote === 'USD') return 1;
  if (symbol.slice(0, 3) === 'USD') return 1 / price; // QUOTE→USD ≈ 1/precio
  if (quoteToUsd && quoteToUsd > 0) return quoteToUsd;
  return 1; // sin conversión conocida: se documenta como aproximación
}

/**
 * Tamaño de posición por riesgo fijo: se arriesga `riskPct`% del balance
 * y el tamaño sale de la distancia al stop. Lanza en inputs sin sentido
 * (balance/entry no positivos, stop == entry, riesgo fuera de (0, 100]).
 */
export function positionSize(input: RiskInput): PositionSize {
  const { balance, riskPct, entry, stop, symbol } = input;
  if (!(balance > 0)) throw new Error('balance debe ser > 0');
  if (!(entry > 0)) throw new Error('entry debe ser > 0');
  if (!(riskPct > 0) || riskPct > 100) throw new Error('riskPct debe estar en (0, 100]');
  // round6 elimina el ruido de coma flotante (1.08−1.075 = 0.005000…044),
  // que de otro modo desplaza el floor de las unidades en ±1
  const stopDistance = round6(Math.abs(entry - stop));
  if (!(stopDistance > 0)) throw new Error('stop no puede coincidir con entry');

  const pip = pipSize(symbol);
  const conv = usdPerUnitPerPrice(symbol, entry, input.quoteToUsd);
  const riskAmount = balance * (riskPct / 100);

  // riesgo USD = unidades × stopDistance × conv  →  unidades
  // (epsilon: que el ruido de división no baje un entero exacto)
  const units = riskAmount / (stopDistance * conv) + 1e-9;

  return {
    riskAmount: round2(riskAmount),
    stopDistance,
    stopDistancePips: Math.round((stopDistance / pip) * 10) / 10,
    units: Math.floor(units),
    lots: Math.round((units / 100_000) * 100) / 100,
    valuePerPip: round2(Math.floor(units) * pip * conv),
    notional: round2(Math.floor(units) * entry * (symbol.slice(0, 3) === 'USD' ? 1 : conv)),
  };
}

/** P/L en USD de una posición cerrada (mismas convenciones que positionSize). */
export function positionPl(
  symbol: string,
  direction: Direction,
  entry: number,
  exit: number,
  units: number,
  quoteToUsd?: number,
): number {
  const move = direction === 'buy' ? exit - entry : entry - exit;
  return round2(units * move * usdPerUnitPerPrice(symbol, exit, quoteToUsd));
}

export interface ExposureCheck {
  allowed: boolean;
  reason: string | null;
  openPositions: number;
  totalRiskPct: number; // exposición actual + la nueva
}

/**
 * Límites de exposición de la cuenta: nº máximo de posiciones abiertas y
 * suma de riesgo comprometido. Se aplica antes de abrir cualquier posición
 * (paper hoy; brokers reales mañana con la misma interfaz).
 */
export function checkExposure(params: {
  openPositions: number;
  openRiskAmount: number; // USD ya comprometidos en stops de posiciones abiertas
  newRiskAmount: number;
  balance: number;
  maxOpenPositions: number;
  maxTotalRiskPct: number;
}): ExposureCheck {
  const totalRiskPct =
    params.balance > 0
      ? ((params.openRiskAmount + params.newRiskAmount) / params.balance) * 100
      : Infinity;

  if (params.openPositions >= params.maxOpenPositions) {
    return {
      allowed: false,
      reason: `máximo de posiciones abiertas alcanzado (${params.maxOpenPositions})`,
      openPositions: params.openPositions,
      totalRiskPct: round2(totalRiskPct),
    };
  }
  if (totalRiskPct > params.maxTotalRiskPct) {
    return {
      allowed: false,
      reason: `exposición total ${totalRiskPct.toFixed(1)}% > máximo ${params.maxTotalRiskPct}%`,
      openPositions: params.openPositions,
      totalRiskPct: round2(totalRiskPct),
    };
  }
  return {
    allowed: true,
    reason: null,
    openPositions: params.openPositions,
    totalRiskPct: round2(totalRiskPct),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
