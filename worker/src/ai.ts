import { estimateCost, estimateTokens, logAiCall, type AiCallKind, type AiCostRates } from './aiLog';
import { PROMPT_VERSION } from './versions';
import type { AiVerdict, SignalContext } from './types';

/* Paso 3b — evaluación con Workers AI.
   La IA solo se invoca con señales cuya confianza determinista supera el
   umbral (AI_MIN_CONFIDENCE): el patrón fiable es la puerta de entrada,
   la IA aporta el juicio cualitativo, nunca inventa la señal.

   Producción (Fase 6): cada llamada queda registrada en ai_calls (latencia,
   tokens, coste estimado, error) vía el parámetro opcional `telemetry`;
   el prompt está versionado (PROMPT_VERSION) — súbela con CUALQUIER cambio
   de texto, la calibración depende de poder separar versiones. */

const SYSTEM_PROMPT = `Eres un analista cuantitativo de Forex. Recibes el dossier de una señal
detectada por algoritmos deterministas (patrón, niveles y contexto de mercado).
Tu trabajo es validarla o descartarla, nunca proponer operaciones nuevas.

Responde EXCLUSIVAMENTE con un objeto JSON válido, sin markdown, con esta forma:
{
  "action": "buy" | "sell" | "skip",
  "confidence": <entero 0-100>,
  "thesis": "<2-3 frases: por qué operar o no>",
  "risks": "<1-2 frases: principal riesgo de la operación>",
  "sentimentScore": <entero 0-5, tu lectura del contexto/momentum>,
  "newsScore": <entero 0-5; si el dossier no trae noticias usa 3 (neutral)>
}

Criterios:
- "action" solo puede coincidir con la dirección del patrón o ser "skip".
- Usa "skip" si el contexto contradice el patrón (tendencia superior opuesta,
  RSI extremo en contra, RR pobre, correlaciones que anulan la ventaja).
- Pesa mucho recentOutcomes: es el rendimiento REAL de cada patrón en este
  mercado. Si el patrón de la señal tiene tpRate bajo con muestra >= 15,
  usa "skip" salvo confluencia excepcional del resto del contexto.
- Pesa mucho similarCases si existe: es el resultado real de situaciones de
  mercado casi idénticas a esta. Un acierto histórico bajo en casos
  similares exige "skip" o confianza claramente reducida.
- Desconfía de señales contra la tendencia del marco superior: exige que
  al menos dos factores más (RSI, volumen, distancia a extremos) la apoyen.
- El bloque "smc" resume la estructura institucional: zonas de órdenes sin
  mitigar (demand/supply) y liquidez sin barrer (máximos/mínimos iguales).
  structuralBias "en contra" significa techo/suelo institucional inmediato:
  exige confluencia excepcional o usa "skip". La liquidez por delante en la
  dirección de la señal actúa como imán del precio y refuerza la entrada.
- "session" indica las sesiones abiertas: Londres y Nueva York concentran
  el volumen; en Sídney/Tokio en solitario los patrones de ruptura pierden
  fiabilidad y merece más prudencia.
- "news" resume el calendario económico próximo de las divisas del par y
  "marketWarnings" avisa de eventos de ALTO impacto inminentes: un dato
  macro fuerte (NFP, IPC, banco central) puede barrer stops sin respetar
  la técnica. Con warning activo, baja newsScore y exige más confluencia
  o usa "skip". Sin noticias en el dossier usa newsScore 3 (neutral).
- Sé conservador: ante la duda, "skip" con confianza baja.`;

/** Bloque adicional cuando la señal ya está abierta y se re-evalúa. */
function reevalBlock(context: SignalContext): string {
  if (!context.tracking) return '';
  return `

Esto es una RE-EVALUACIÓN: la señal sigue abierta y el dossier está
recalculado con los datos más recientes. El campo "tracking" incluye cuántas
velas lleva abierta, el precio actual, el % de recorrido hacia el objetivo
(negativo si avanza hacia el stop) y tu veredicto anterior. Decide con el
contexto ACTUAL: confirma el veredicto, ajusta la confianza, o usa "skip" si
las condiciones que justificaban la entrada ya no se dan. No mantengas el
veredicto anterior por inercia ni lo cambies sin motivo en los datos.`;
}

/** Bloque adicional del system prompt con las lecciones aprendidas. */
function lessonsBlock(lessons: string[]): string {
  if (lessons.length === 0) return '';
  return (
    '\n\nLecciones aprendidas de errores anteriores de este sistema ' +
    '(aplícalas cuando la situación coincida):\n' +
    lessons.map((l) => `- ${l}`).join('\n')
  );
}

/** Contexto opcional de telemetría: si se pasa, la llamada queda en ai_calls. */
export interface AiTelemetry {
  db: D1Database;
  kind: AiCallKind;
  sigKey: string | null;
  rates: AiCostRates;
}

/** Forma habitual de la respuesta de Workers AI para modelos de texto. */
interface AiTextResult {
  response?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export async function evaluateSignal(
  ai: Ai,
  model: string,
  context: SignalContext,
  lessons: string[] = [],
  telemetry?: AiTelemetry,
): Promise<AiVerdict> {
  const system = SYSTEM_PROMPT + reevalBlock(context) + lessonsBlock(lessons);
  const user = JSON.stringify(context, null, 2);
  const started = Date.now();

  let result: AiTextResult;
  try {
    result = (await ai.run(model as Parameters<Ai['run']>[0], {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: 512,
    })) as AiTextResult;
  } catch (e) {
    if (telemetry) {
      await logAiCall(telemetry.db, {
        kind: telemetry.kind, model, promptVersion: PROMPT_VERSION,
        sigKey: telemetry.sigKey, latencyMs: Date.now() - started,
        tokensIn: estimateTokens(system + user), tokensOut: 0,
        estCostUsd: estimateCost(estimateTokens(system + user), 0, telemetry.rates),
        success: false, error: e instanceof Error ? e.message : String(e),
      });
    }
    throw e;
  }

  // algunos modelos de Workers AI devuelven `response` como objeto JSON ya
  // parseado en lugar de string; se normaliza antes del parseo defensivo
  const raw =
    typeof result.response === 'string'
      ? result.response
      : JSON.stringify(result.response ?? '');

  // sin JSON válido → error: el paso del workflow reintenta con otra
  // generación en vez de persistir un "skip" definitivo por un fallo de formato
  const verdict = tryParseVerdict(raw, context);

  if (telemetry) {
    const tokensIn = result.usage?.prompt_tokens ?? estimateTokens(system + user);
    const tokensOut = result.usage?.completion_tokens ?? estimateTokens(raw);
    await logAiCall(telemetry.db, {
      kind: telemetry.kind, model, promptVersion: PROMPT_VERSION,
      sigKey: telemetry.sigKey, latencyMs: Date.now() - started,
      tokensIn, tokensOut,
      estCostUsd: estimateCost(tokensIn, tokensOut, telemetry.rates),
      success: verdict !== null,
      error: verdict === null ? `sin JSON parseable: ${raw.slice(0, 120)}` : null,
    });
  }

  if (!verdict) {
    throw new Error(`respuesta IA sin JSON parseable: ${raw.slice(0, 160)}`);
  }
  return verdict;
}

const FALLBACK: AiVerdict = {
  action: 'skip',
  confidence: 0,
  thesis: 'Respuesta del modelo no parseable; se descarta por seguridad.',
  risks: 'Evaluación IA no disponible.',
  sentimentScore: 3,
  newsScore: 3,
};

/** Parseo defensivo: si la IA no devuelve JSON válido → skip conservador. */
export function parseVerdict(raw: string, context: SignalContext): AiVerdict {
  return tryParseVerdict(raw, context) ?? { ...FALLBACK };
}

function tryParseVerdict(raw: string, context: SignalContext): AiVerdict | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const v = JSON.parse(match[0]) as Partial<AiVerdict>;
    const action =
      v.action === 'buy' || v.action === 'sell' || v.action === 'skip' ? v.action : 'skip';

    return {
      // la IA no puede cambiar la dirección del patrón, solo confirmarla o descartar
      action: action !== 'skip' && action !== context.direction ? 'skip' : action,
      confidence: clampInt(v.confidence, 0, 100, 0),
      thesis: String(v.thesis ?? '').slice(0, 600) || FALLBACK.thesis,
      risks: String(v.risks ?? '').slice(0, 400) || FALLBACK.risks,
      sentimentScore: clampInt(v.sentimentScore, 0, 5, 3),
      newsScore: clampInt(v.newsScore, 0, 5, 3),
    };
  } catch {
    return null;
  }
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}
