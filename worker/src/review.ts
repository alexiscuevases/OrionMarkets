import { regimeAligned, type MarketRegime } from './regime';
import type { Direction, Outcome } from './types';

/* Evaluación continua (módulo puro, cero IA): tras cada trade cerrado se
   clasifica qué pasó — ¿acertó la IA? ¿funcionó el patrón? ¿el régimen
   acompañaba? ¿la confianza estaba calibrada? — y se persiste en
   trade_reviews. La reflexión IA (learn.ts) recibe esta taxonomía como
   material estructurado en lugar de casos crudos. */

export type MistakeType =
  | 'ia_valido_y_salio_sl'      // la IA validó y el mercado la desmintió
  | 'ia_descarto_y_salio_tp'    // la IA descartó una ganadora
  | 'gate_descarto_y_salio_tp'  // el gate automático descartó una ganadora
  | 'validacion_correcta'       // validó y salió TP
  | 'descarte_correcto'         // descartó (IA o gate) y salió SL
  | 'expirada';                 // no tocó niveles en la ventana

export interface TradeReviewInput {
  sigKey: string;
  symbol: string;
  interval: string;
  pattern: string;
  direction: Direction;
  rr: number;
  outcome: Outcome;             // solo cierres: tp_hit | sl_hit | expired
  regime: MarketRegime | string | null;
  aiAction: string | null;      // buy | sell | skip | null (sin evaluación)
  aiConfidence: number | null;
  overallScore: number | null;
  isGate: boolean;              // model LIKE 'gate:%'
  /** Campos del dossier persistido (context_json), si está disponible. */
  context?: {
    trendHigherTf?: string;
    rsi14?: number;
    atrPct?: number;
    marketWarnings?: string[] | null;
    session?: string;
  } | null;
}

export interface TradeReview {
  sigKey: string;
  symbol: string;
  interval: string;
  pattern: string;
  regime: string | null;
  outcome: Outcome;
  aiAction: string | null;
  aiConfidence: number | null;
  overallScore: number | null;
  mistakeType: MistakeType;
  cause: string | null;
  aiCorrect: boolean | null;      // null si expiró
  patternWorked: boolean;
  regimeAligned: boolean | null;  // null si el régimen no direcciona
  confidenceCalibrated: boolean | null;
  affectedPatterns: string[];
}

export function classifyTradeReview(input: TradeReviewInput): TradeReview {
  const { outcome, aiAction, aiConfidence } = input;
  const validated = aiAction === 'buy' || aiAction === 'sell';

  let mistakeType: MistakeType;
  let aiCorrect: boolean | null;
  if (outcome === 'expired') {
    mistakeType = 'expirada';
    aiCorrect = null;
  } else if (validated) {
    mistakeType = outcome === 'tp_hit' ? 'validacion_correcta' : 'ia_valido_y_salio_sl';
    aiCorrect = outcome === 'tp_hit';
  } else {
    // skip (de la IA o del gate)
    if (outcome === 'tp_hit') {
      mistakeType = input.isGate ? 'gate_descarto_y_salio_tp' : 'ia_descarto_y_salio_tp';
      aiCorrect = false;
    } else {
      mistakeType = 'descarte_correcto';
      aiCorrect = true;
    }
  }

  const aligned = regimeAligned(input.regime as MarketRegime | null, input.direction);

  // calibración: sobreconfianza (validó fuerte y salió SL) o infraconfianza
  // (confianza mínima y salió TP); expiradas y gates no puntúan
  let confidenceCalibrated: boolean | null = null;
  if (!input.isGate && aiConfidence !== null && outcome !== 'expired') {
    if (validated) {
      confidenceCalibrated = !(aiConfidence >= 65 && outcome === 'sl_hit');
    } else {
      confidenceCalibrated = !(aiConfidence <= 40 && outcome === 'tp_hit');
    }
  }

  return {
    sigKey: input.sigKey,
    symbol: input.symbol,
    interval: input.interval,
    pattern: input.pattern,
    regime: input.regime ? String(input.regime) : null,
    outcome,
    aiAction,
    aiConfidence,
    overallScore: input.overallScore,
    mistakeType,
    cause: causeFor(input, mistakeType, aligned),
    aiCorrect,
    patternWorked: outcome === 'tp_hit',
    regimeAligned: aligned,
    confidenceCalibrated,
    affectedPatterns: [input.pattern],
  };
}

/** Primera causa observable que explica el error (null en aciertos). */
function causeFor(
  input: TradeReviewInput,
  mistakeType: MistakeType,
  aligned: boolean | null,
): string | null {
  const isMistake =
    mistakeType === 'ia_valido_y_salio_sl' ||
    mistakeType === 'ia_descarto_y_salio_tp' ||
    mistakeType === 'gate_descarto_y_salio_tp';
  if (!isMistake && mistakeType !== 'expirada') return null;

  const ctx = input.context;
  if (mistakeType === 'expirada') {
    return input.rr >= 4 ? 'objetivo demasiado ambicioso para el horizonte' : 'mercado sin recorrido en la ventana';
  }
  if (mistakeType === 'ia_valido_y_salio_sl') {
    if (aligned === false) return 'señal validada contra el régimen dominante';
    if (input.regime === 'HIGH_VOLATILITY') return 'validada en régimen de volatilidad alta';
    if (ctx?.marketWarnings && ctx.marketWarnings.length > 0) return 'validada con aviso macro de alto impacto activo';
    if (ctx?.trendHigherTf && (
      (input.direction === 'buy' && ctx.trendHigherTf === 'bajista') ||
      (input.direction === 'sell' && ctx.trendHigherTf === 'alcista')
    )) return 'validada contra la tendencia del marco superior';
    if (input.aiConfidence !== null && input.aiConfidence >= 80) return 'sobreconfianza de la IA';
    return 'contexto favorable insuficiente';
  }
  // descartes de ganadoras
  if (aligned === true) return 'descartada pese a operar a favor del régimen';
  if (input.aiConfidence !== null && input.aiConfidence <= 20) return 'descarte con convicción excesiva';
  return 'exceso de prudencia con confluencia suficiente';
}
