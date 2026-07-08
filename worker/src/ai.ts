import type { AiVerdict, SignalContext } from './types';

/* Paso 3b — evaluación con Workers AI.
   La IA solo se invoca con señales cuya confianza determinista supera el
   umbral (AI_MIN_CONFIDENCE): el patrón fiable es la puerta de entrada,
   la IA aporta el juicio cualitativo, nunca inventa la señal. */

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

export async function evaluateSignal(
  ai: Ai,
  model: string,
  context: SignalContext,
  lessons: string[] = [],
): Promise<AiVerdict> {
  const result = (await ai.run(model as Parameters<Ai['run']>[0], {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + reevalBlock(context) + lessonsBlock(lessons) },
      { role: 'user', content: JSON.stringify(context, null, 2) },
    ],
    temperature: 0.2,
    max_tokens: 512,
  })) as { response?: unknown };

  // algunos modelos de Workers AI devuelven `response` como objeto JSON ya
  // parseado en lugar de string; se normaliza antes del parseo defensivo
  const raw =
    typeof result.response === 'string'
      ? result.response
      : JSON.stringify(result.response ?? '');

  // sin JSON válido → error: el paso del workflow reintenta con otra
  // generación en vez de persistir un "skip" definitivo por un fallo de formato
  const verdict = tryParseVerdict(raw, context);
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
