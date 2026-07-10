/* Walk-forward y salud de patrones (módulo puro, cero I/O).

   Cada patrón por mercado se evalúa en dos ventanas: la vida completa y la
   reciente. Si el rendimiento reciente se degrada respecto al histórico,
   la salud cae y con ella un multiplicador de confianza que reduce el
   score gradualmente ANTES de llegar al skip binario. 'disabled' reproduce
   el gate de expectancia que ya existía ('gate:historial'), ahora
   persistido y auditable en pattern_health. */

export interface PatternWindowStats {
  total: number;   // cierres tp+sl en la ventana
  tpRate: number;  // 0-1
  avgRr: number;
}

export interface PatternHealth {
  symbol: string;
  interval: string;
  pattern: string;
  totalTrades: number;
  winRate: number;
  avgRR: number;
  expectancy: number;        // en múltiplos de R
  recentTrades: number;
  recentWinRate: number;
  recentExpectancy: number;
  degradationScore: number;  // 0-1
  health: number;            // 0-100
  status: 'healthy' | 'degrading' | 'disabled';
  confidenceMultiplier: number; // 0 … 1, aplicado al score final
}

/** Expectancia en R: tpRate·avgRr − (1 − tpRate). Único punto de cálculo
    (antes replicado en workflow.ts, scoring.ts y getAiCalibration). */
export function expectancyOf(tpRate: number, avgRr: number): number {
  return tpRate * avgRr - (1 - tpRate);
}

/** Umbrales del sistema de salud (exportados para tests). */
export const HEALTH_THRESHOLDS = {
  minTotalForDisable: 15,   // muestra mínima para desactivar por histórico (= gate actual)
  minRecentForSignal: 8,    // muestra reciente mínima para medir degradación
  disableRecentTrades: 12,  // muestra reciente mínima para desactivar por degradación
  disableRecentExpectancy: -0.25,
  degradingThreshold: 0.35, // degradationScore a partir del cual el estado baja
  recentWindowDays: 30,     // ventana walk-forward por defecto (el caller la aplica)
} as const;

/**
 * Combina la ventana completa y la reciente en el estado de salud.
 * Determinista; ventanas sin muestra suficiente → neutral (sin castigo).
 */
export function computePatternHealth(
  key: { symbol: string; interval: string; pattern: string },
  full: PatternWindowStats,
  recent: PatternWindowStats,
): PatternHealth {
  const t = HEALTH_THRESHOLDS;
  const fullExp = full.total > 0 ? expectancyOf(full.tpRate, full.avgRr) : 0;
  const recentExp = recent.total > 0 ? expectancyOf(recent.tpRate, recent.avgRr) : 0;

  // degradación: cuánto empeora la ventana reciente frente a la histórica,
  // normalizada a 1R; sin muestra reciente suficiente no se castiga
  let degradation = 0;
  if (recent.total >= t.minRecentForSignal && full.total >= t.minRecentForSignal) {
    degradation = Math.min(1, Math.max(0, fullExp - recentExp));
    // deterioro con pérdidas reales recientes pesa más que una simple caída
    if (recentExp < 0 && fullExp > 0) degradation = Math.max(degradation, 0.5);
  }

  // salud 0-100: expectancia histórica mapeada, penalizada por degradación
  const base = 50 + Math.max(-50, Math.min(50, fullExp * 60));
  const health = Math.round(Math.max(0, Math.min(100, base * (1 - 0.5 * degradation))));

  let status: PatternHealth['status'] = 'healthy';
  if (
    (full.total >= t.minTotalForDisable && fullExp <= 0) ||
    (recent.total >= t.disableRecentTrades && recentExp <= t.disableRecentExpectancy)
  ) {
    status = 'disabled';
  } else if (degradation >= t.degradingThreshold) {
    status = 'degrading';
  }

  const confidenceMultiplier =
    status === 'disabled' ? 0
    : status === 'degrading' ? Math.max(0.6, Math.round((1 - 0.4 * degradation) * 100) / 100)
    : 1;

  return {
    ...key,
    totalTrades: full.total,
    winRate: round2(full.tpRate),
    avgRR: round2(full.avgRr),
    expectancy: round2(fullExp),
    recentTrades: recent.total,
    recentWinRate: round2(recent.tpRate),
    recentExpectancy: round2(recentExp),
    degradationScore: round2(degradation),
    health,
    status,
    confidenceMultiplier,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
