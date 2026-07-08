/* Catálogo de estrategias: una por detector determinista del motor
   (worker/src/patterns.ts). Las estadísticas (acierto, factor, curva)
   salen de /api/strategies; aquí solo viven los metadatos y el mapeo
   patrón → estrategia que gobierna qué señales se muestran en la UI. */

export interface StrategyDef {
  id: string;
  name: string;
  desc: string;
  tf: string;
  pairs: string;
  risk: 'Bajo' | 'Medio' | 'Alto';
}

/** Rendimiento real agregado desde el motor (ventana de 30 días). */
export interface StrategyStats {
  signals30d: number;
  open: number;
  wins: number;        // cierres en TP
  losses: number;      // cierres en SL
  winRate: number | null;       // % sobre cierres decididos; null sin muestra
  profitFactor: number | null;  // sum(rr de TP) / nº SL; Infinity sin pérdidas
  equity: number[];             // R acumulado de los cierres, en orden
}

export interface Strategy extends StrategyDef {
  active: boolean;
  stats: StrategyStats | null; // null mientras el motor no responde
}

const UNIVERSE = 'EURUSD · GBPUSD · USDJPY';

export const STRATEGY_DEFS: StrategyDef[] = [
  {
    id: 'ema-cross',
    name: 'Cruce de EMAs',
    desc: 'Cruce de media rápida/lenta sostenido y con separación mínima en ATR.',
    tf: 'M5–H1', pairs: UNIVERSE, risk: 'Bajo',
  },
  {
    id: 'rsi-divergence',
    name: 'Divergencia RSI',
    desc: 'Reversión con divergencia precio/RSI entre pivotes confirmados.',
    tf: 'M5–H1', pairs: UNIVERSE, risk: 'Medio',
  },
  {
    id: 'engulfing',
    name: 'Vela envolvente',
    desc: 'Envolvente alcista o bajista con confluencia de la tendencia de fondo.',
    tf: 'M5–H1', pairs: UNIVERSE, risk: 'Medio',
  },
  {
    id: 'pin-bar',
    name: 'Pin bar',
    desc: 'Rechazo con mecha dominante sobre soporte o resistencia.',
    tf: 'M5–H1', pairs: UNIVERSE, risk: 'Medio',
  },
  {
    id: 'double-top-bottom',
    name: 'Doble techo / suelo',
    desc: 'Estructura de doble pivote con ruptura de la línea de cuello.',
    tf: 'M5–H1', pairs: UNIVERSE, risk: 'Alto',
  },
  {
    id: 'flag',
    name: 'Bandera',
    desc: 'Continuación tras impulso con consolidación en canal contrario.',
    tf: 'M5–H1', pairs: UNIVERSE, risk: 'Medio',
  },
  {
    id: 'range-breakout',
    name: 'Ruptura de rango',
    desc: 'Ruptura del canal Donchian con expansión de volatilidad.',
    tf: 'M5–H1', pairs: UNIVERSE, risk: 'Alto',
  },
];

/* Los detectores emiten variantes del nombre («Cruce EMA 9/21», «Envolvente
   bajista»…); se resuelven a su estrategia por prefijo. */
const PATTERN_PREFIXES: [prefix: string, strategyId: string][] = [
  ['Cruce EMA', 'ema-cross'],
  ['Divergencia RSI', 'rsi-divergence'],
  ['Envolvente', 'engulfing'],
  ['Pin bar', 'pin-bar'],
  ['Doble', 'double-top-bottom'],
  ['Bandera', 'flag'],
  ['Ruptura de rango', 'range-breakout'],
];

export function strategyIdForPattern(pattern: string): string | null {
  const hit = PATTERN_PREFIXES.find(([prefix]) => pattern.startsWith(prefix));
  return hit ? hit[1] : null;
}

/** Una señal se muestra si su estrategia está activa; los patrones que no
    mapean a ninguna estrategia conocida no se ocultan nunca. */
export function isSignalEnabled(pattern: string, activeIds: ReadonlySet<string>): boolean {
  const id = strategyIdForPattern(pattern);
  return id === null || activeIds.has(id);
}

/* ---------- persistencia del interruptor por estrategia ---------- */

const STORAGE_KEY = 'orion.activeStrategies';

export function loadActiveIds(): Set<string> {
  const all = new Set(STRATEGY_DEFS.map((d) => d.id));
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return all;
    const ids = (JSON.parse(raw) as string[]).filter((id) => all.has(id));
    return new Set(ids);
  } catch {
    return all;
  }
}

export function saveActiveIds(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* almacenamiento no disponible: el estado queda solo en memoria */
  }
}
