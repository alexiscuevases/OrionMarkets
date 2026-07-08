import { detectAll, profileFor, resolveOutcome } from './patterns';
import { DETECTOR_VERSION } from './versions';
import type { Candle, DetectedSignal } from './types';

/* Motor de backtesting (Fase 2).

   Ejecuta EXACTAMENTE la misma lógica que el detector live (detectAll +
   resolveOutcome importados, no re-implementados) sobre un rango histórico,
   y nunca escribe en signals/evaluations: un backtest es una simulación,
   las señales live son otra cosa.

   Sin look-ahead bias:
   - los detectores confirman cada señal solo con velas <= su índice de
     confirmación (misma garantía que en producción);
   - la resolución de cada trade recorre velas posteriores a su ts;
   - las velas se cortan en `toTs`: una señal sin TP/SL dentro del rango
     queda 'open' y se excluye de las métricas (se reporta aparte), en vez
     de resolverse con futuro fuera del rango pedido.

   La curva de equity ordena los trades por su MOMENTO DE CIERRE y arriesga
   un % fijo del balance corriente por operación (R-multiples: TP = +rr,
   SL = −1, expirada = 0). Los trades pueden solaparse en el tiempo; el
   efecto cartera (margen, correlación entre posiciones abiertas) no se
   simula y queda documentado como límite. */

export interface BacktestParams {
  symbol: string;
  interval: string;
  fromTs: number;
  toTs: number;
  /** Solo estos patrones (nombre exacto); ausente → todos. */
  patterns?: string[];
  /** Confianza determinista mínima de la señal; por defecto 0 (todas). */
  minConfidence?: number;
  initialBalance?: number; // USD, por defecto 10.000
  riskPct?: number;        // % por operación, por defecto 1
}

export interface BacktestTrade {
  ts: number;
  pattern: string;
  direction: 'buy' | 'sell';
  entry: number;
  stop: number;
  target: number;
  rr: number;
  confidence: number;
  outcome: 'tp_hit' | 'sl_hit' | 'expired';
  outcomeTs: number;
  r: number; // resultado en múltiplos de R
}

export interface PatternPerf {
  pattern: string;
  trades: number;
  wins: number;
  losses: number;
  expired: number;
  winRate: number | null;    // sobre decididos (tp+sl)
  netR: number;
  expectancyR: number | null;
}

export interface BacktestMetrics {
  totalTrades: number;       // cerrados dentro del rango
  wins: number;
  losses: number;
  expired: number;
  openAtEnd: number;         // señales sin resolver al cortar en toTs
  winRate: number | null;    // tp / (tp + sl)
  profitFactor: number | null;
  expectancyR: number | null; // media de R sobre trades decididos
  avgRr: number | null;       // RR planificado medio
  netR: number;
  maxDrawdownR: number;       // pico-valle de la curva en R
  maxDrawdownPct: number;     // pico-valle del balance compuesto
  finalBalance: number;
  returnPct: number;
  equityCurve: { ts: number; r: number; balance: number }[];
  monthly: { month: string; trades: number; wins: number; losses: number; netR: number }[];
  byPattern: PatternPerf[];
  bestPattern: string | null;  // mayor expectancia con muestra >= 5
  worstPattern: string | null;
}

export interface BacktestResult {
  symbol: string;
  interval: string;
  fromTs: number;
  toTs: number;
  detectorVersion: string;
  params: Required<Pick<BacktestParams, 'initialBalance' | 'riskPct' | 'minConfidence'>> &
    Pick<BacktestParams, 'patterns'>;
  candlesUsed: number;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
}

/**
 * `candles`: histórico ascendente COMPLETO disponible del símbolo+intervalo
 * (los detectores necesitan calentamiento previo a fromTs; el propio motor
 * corta en toTs y filtra señales al rango pedido).
 */
export function runBacktest(candles: Candle[], params: BacktestParams): BacktestResult {
  const initialBalance = params.initialBalance ?? 10_000;
  const riskPct = params.riskPct ?? 1;
  const minConfidence = params.minConfidence ?? 0;
  if (!(initialBalance > 0)) throw new Error('initialBalance debe ser > 0');
  if (!(riskPct > 0) || riskPct > 100) throw new Error('riskPct debe estar en (0, 100]');
  if (!(params.fromTs < params.toTs)) throw new Error('rango de fechas inválido');

  // corte duro en toTs: nada posterior al rango existe para la simulación
  const scoped = candles.filter((c) => c.ts <= params.toTs);
  const wanted = params.patterns?.length ? new Set(params.patterns) : null;

  const signals = detectAll(params.symbol, params.interval, scoped).filter(
    (s) =>
      s.ts >= params.fromTs &&
      s.ts <= params.toTs &&
      s.confidence >= minConfidence &&
      (!wanted || wanted.has(s.pattern)),
  );

  const expiryBars = profileFor(params.interval).expiryBars;
  const trades: BacktestTrade[] = [];
  let openAtEnd = 0;

  for (const sig of signals) {
    const r = resolveOutcome(sig, scoped, expiryBars);
    if (r.outcome === 'open' || r.outcomeTs === null) {
      openAtEnd++;
      continue;
    }
    trades.push({
      ts: sig.ts,
      pattern: sig.pattern,
      direction: sig.direction,
      entry: sig.entry,
      stop: sig.stop,
      target: sig.target,
      rr: sig.rr,
      confidence: sig.confidence,
      outcome: r.outcome,
      outcomeTs: r.outcomeTs,
      r: r.outcome === 'tp_hit' ? sig.rr : r.outcome === 'sl_hit' ? -1 : 0,
    });
  }

  // la equity se construye en orden de cierre (cuando el resultado se conoce)
  trades.sort((a, b) => a.outcomeTs - b.outcomeTs || a.ts - b.ts);

  return {
    symbol: params.symbol,
    interval: params.interval,
    fromTs: params.fromTs,
    toTs: params.toTs,
    detectorVersion: DETECTOR_VERSION,
    params: { initialBalance, riskPct, minConfidence, patterns: params.patterns },
    candlesUsed: scoped.length,
    metrics: computeMetrics(trades, openAtEnd, initialBalance, riskPct),
    trades,
  };
}

function computeMetrics(
  trades: BacktestTrade[],
  openAtEnd: number,
  initialBalance: number,
  riskPct: number,
): BacktestMetrics {
  let wins = 0;
  let losses = 0;
  let expired = 0;
  let grossWinR = 0;
  let grossLossR = 0;
  let netR = 0;
  let rrSum = 0;

  let balance = initialBalance;
  let cumR = 0;
  let peakR = 0;
  let maxDdR = 0;
  let peakBal = initialBalance;
  let maxDdPct = 0;

  const equityCurve: BacktestMetrics['equityCurve'] = [];
  const monthly = new Map<string, { trades: number; wins: number; losses: number; netR: number }>();
  const byPattern = new Map<
    string,
    { trades: number; wins: number; losses: number; expired: number; netR: number }
  >();

  for (const t of trades) {
    if (t.outcome === 'tp_hit') { wins++; grossWinR += t.rr; }
    else if (t.outcome === 'sl_hit') { losses++; grossLossR += 1; }
    else expired++;
    netR += t.r;
    rrSum += t.rr;

    // balance compuesto: cada trade arriesga riskPct% del balance corriente
    balance += balance * (riskPct / 100) * t.r;
    cumR += t.r;
    peakR = Math.max(peakR, cumR);
    maxDdR = Math.max(maxDdR, peakR - cumR);
    peakBal = Math.max(peakBal, balance);
    maxDdPct = Math.max(maxDdPct, (peakBal - balance) / peakBal);

    equityCurve.push({ ts: t.outcomeTs, r: round2(cumR), balance: round2(balance) });

    const month = new Date(t.outcomeTs).toISOString().slice(0, 7);
    const m = monthly.get(month) ?? { trades: 0, wins: 0, losses: 0, netR: 0 };
    m.trades++;
    if (t.outcome === 'tp_hit') m.wins++;
    else if (t.outcome === 'sl_hit') m.losses++;
    m.netR += t.r;
    monthly.set(month, m);

    const p = byPattern.get(t.pattern) ?? { trades: 0, wins: 0, losses: 0, expired: 0, netR: 0 };
    p.trades++;
    if (t.outcome === 'tp_hit') p.wins++;
    else if (t.outcome === 'sl_hit') p.losses++;
    else p.expired++;
    p.netR += t.r;
    byPattern.set(t.pattern, p);
  }

  const decided = wins + losses;
  const patterns: PatternPerf[] = [...byPattern.entries()]
    .map(([pattern, p]) => {
      const d = p.wins + p.losses;
      return {
        pattern,
        ...p,
        netR: round2(p.netR),
        winRate: d > 0 ? round2(p.wins / d) : null,
        expectancyR: d > 0 ? round2((p.netR - 0) / d) : null,
      };
    })
    .sort((a, b) => (b.expectancyR ?? -Infinity) - (a.expectancyR ?? -Infinity));

  const ranked = patterns.filter((p) => p.wins + p.losses >= 5);

  return {
    totalTrades: trades.length,
    wins,
    losses,
    expired,
    openAtEnd,
    winRate: decided > 0 ? round2(wins / decided) : null,
    profitFactor:
      grossLossR > 0 ? round2(grossWinR / grossLossR) : wins > 0 ? Infinity : null,
    expectancyR: decided > 0 ? round2(netR / decided) : null,
    avgRr: trades.length > 0 ? round2(rrSum / trades.length) : null,
    netR: round2(netR),
    maxDrawdownR: round2(maxDdR),
    maxDrawdownPct: round2(maxDdPct * 100),
    finalBalance: round2(balance),
    returnPct: round2(((balance - initialBalance) / initialBalance) * 100),
    equityCurve,
    monthly: [...monthly.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, m]) => ({ month, ...m, netR: round2(m.netR) })),
    byPattern: patterns,
    bestPattern: ranked[0]?.pattern ?? null,
    worstPattern: ranked.length > 0 ? ranked[ranked.length - 1].pattern : null,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/* re-export para que el endpoint valide patrones sin importar patterns.ts */
export type { DetectedSignal };
