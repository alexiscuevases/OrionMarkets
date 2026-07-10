import { atr, ema, rsi, slopePct } from './indicators';
import { REFLECT_PROMPT_VERSION } from './versions';
import type { Candle, SignalContext, SignalRow } from './types';

/* Aprendizaje continuo — memoria de casos y reflexión sobre errores.

   1. MEMORIA DE CASOS (Vectorize): cada señal cerrada se embebe (bge-m3)
      a partir de un texto canónico de sus features de mercado. Al evaluar
      una señal nueva se recuperan los casos más parecidos con su resultado
      real y se resumen en el dossier → la IA decide "con jurisprudencia".

   2. REFLEXIÓN: periódicamente se toman los errores de la IA (validó y
      salió SL / descartó y salió TP) y el propio modelo destila lecciones
      cortas que se inyectan en el prompt de las evaluaciones futuras.

   El texto de caso usa SOLO features del propio marco de la señal, para
   que el backfill histórico (sin dossier completo) y la evaluación en vivo
   produzcan exactamente el mismo formato. */

export const EMBED_MODEL = '@cf/baai/bge-m3'; // 1024 dims, coseno

/* ---------- features canónicas de un caso ---------- */

export interface CaseFeatures {
  symbol: string;
  interval: string;
  pattern: string;
  direction: string;
  emaSide: 'encima' | 'debajo';
  emaSlope: 'ascendente' | 'descendente' | 'plana';
  rsiBucket: string;
  atrBucket: string;
  volumeTrend: string;
  rrBucket: number;
  roomHigh: string;
  roomLow: string;
}

/** Texto canónico y determinista del caso (entrada del embedding). */
export function caseText(f: CaseFeatures): string {
  return [
    `${f.pattern} ${f.direction} en ${f.symbol} ${f.interval}`,
    `precio ${f.emaSide} de EMA200 con pendiente ${f.emaSlope}`,
    f.rsiBucket,
    f.atrBucket,
    `volumen ${f.volumeTrend}`,
    `RR ${f.rrBucket}`,
    `techo reciente ${f.roomHigh}`,
    `suelo reciente ${f.roomLow}`,
  ].join('; ');
}

function rsiBucket(v: number): string {
  return v < 30 ? 'RSI sobrevendido' : v < 45 ? 'RSI bajo' : v < 55 ? 'RSI neutro' : v < 70 ? 'RSI alto' : 'RSI sobrecomprado';
}

function atrBucket(atrPct: number): string {
  return atrPct < 0.06 ? 'volatilidad baja' : atrPct < 0.2 ? 'volatilidad media' : 'volatilidad alta';
}

function roomBucket(distPct: number): string {
  return distPct < 0.15 ? 'cerca' : distPct < 0.5 ? 'a media distancia' : 'lejos';
}

/** Features desde el dossier completo (evaluación en vivo). */
export function featuresFromContext(ctx: SignalContext): CaseFeatures {
  return {
    symbol: ctx.symbol,
    interval: ctx.interval,
    pattern: ctx.pattern,
    direction: ctx.direction,
    emaSide: ctx.ema200 === 'precio por encima' ? 'encima' : 'debajo',
    emaSlope: ctx.ema200Slope,
    rsiBucket: rsiBucket(ctx.rsi14),
    atrBucket: atrBucket(ctx.atrPct),
    volumeTrend: ctx.volumeTrend,
    rrBucket: Math.round(ctx.riskReward * 2) / 2,
    roomHigh: roomBucket(ctx.distanceToRecentHigh),
    roomLow: roomBucket(ctx.distanceToRecentLow),
  };
}

/** Features recalculadas desde las velas del propio marco (backfill del
    histórico). Replica los cálculos de enrich.ts cortados en signal.ts.
    Devuelve null si no hay velas suficientes para una EMA200 estable. */
export function featuresFromCandles(
  sig: SignalRow,
  candles: Candle[],
): CaseFeatures | null {
  const upto = candles.filter((c) => c.ts <= sig.ts);
  if (upto.length < 220) return null;

  const closes = upto.map((c) => c.close);
  const last = closes.length - 1;
  const price = closes[last];

  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(upto, 14);
  if (!Number.isFinite(ema200[last]) || !Number.isFinite(rsi14[last]) || !Number.isFinite(atr14[last])) {
    return null;
  }

  const slope = slopePct(ema200, last, 40);
  const vols = upto.map((c) => c.volume);
  const vNow = avg(vols.slice(-20));
  const vPrev = avg(vols.slice(-40, -20));
  const volumeTrend =
    vPrev === 0 ? 'estable' : vNow > vPrev * 1.15 ? 'creciente' : vNow < vPrev * 0.85 ? 'decreciente' : 'estable';

  const win = upto.slice(-120);
  const hh = Math.max(...win.map((c) => c.high));
  const ll = Math.min(...win.map((c) => c.low));

  return {
    symbol: sig.symbol,
    interval: sig.interval,
    pattern: sig.pattern,
    direction: sig.direction,
    emaSide: price > ema200[last] ? 'encima' : 'debajo',
    emaSlope: slope > 0.005 ? 'ascendente' : slope < -0.005 ? 'descendente' : 'plana',
    rsiBucket: rsiBucket(rsi14[last]),
    atrBucket: atrBucket((atr14[last] / price) * 100),
    volumeTrend,
    rrBucket: Math.round(sig.rr * 2) / 2,
    roomHigh: roomBucket(((hh - price) / price) * 100),
    roomLow: roomBucket(((price - ll) / price) * 100),
  };
}

/* ---------- embeddings ---------- */

/** Embeddings en lote (una sola llamada a Workers AI, hasta ~100 textos).
    Con `telemetry` la llamada queda registrada en ai_calls (kind 'embed'). */
export async function embedTexts(
  ai: Ai,
  texts: string[],
  telemetry?: import('./ai').AiTelemetry,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const started = Date.now();
  let res: { data?: number[][] };
  try {
    res = (await ai.run(EMBED_MODEL as Parameters<Ai['run']>[0], {
      text: texts,
    })) as { data?: number[][] };
  } catch (e) {
    if (telemetry) {
      const { estimateTokens, logAiCall } = await import('./aiLog');
      const tokensIn = estimateTokens(texts.join(' '));
      await logAiCall(telemetry.db, {
        kind: 'embed', model: EMBED_MODEL, promptVersion: null, sigKey: telemetry.sigKey,
        latencyMs: Date.now() - started, tokensIn, tokensOut: 0,
        estCostUsd: 0, success: false, error: e instanceof Error ? e.message : String(e),
      });
    }
    throw e;
  }
  const data = res.data ?? [];
  if (telemetry) {
    const { estimateTokens, logAiCall } = await import('./aiLog');
    await logAiCall(telemetry.db, {
      kind: 'embed', model: EMBED_MODEL, promptVersion: null, sigKey: telemetry.sigKey,
      latencyMs: Date.now() - started, tokensIn: estimateTokens(texts.join(' ')),
      tokensOut: 0, estCostUsd: 0, success: data.length === texts.length,
      error: data.length === texts.length ? null : `esperados ${texts.length}, recibidos ${data.length}`,
    });
  }
  if (data.length !== texts.length) {
    throw new Error(`embeddings: esperados ${texts.length}, recibidos ${data.length}`);
  }
  return data;
}

/* ---------- resumen de casos similares para el dossier ---------- */

export interface CaseMatch {
  score: number;
  metadata?: Record<string, unknown> | null;
}

/** Resume los vecinos recuperados de Vectorize en una frase para la IA.
    null si no hay muestra suficientemente parecida. Si la metadata trae los
    campos enriquecidos (regime, aiScore) añade el desglose por régimen. */
export function summarizeSimilarCases(matches: CaseMatch[], minScore = 0.72): string | null {
  const near = matches.filter((m) => m.score >= minScore && m.metadata);
  if (near.length < 3) return null;

  let tp = 0;
  let sl = 0;
  let aiWrong = 0;
  const regimeCounts = new Map<string, { tp: number; sl: number }>();
  for (const m of near) {
    const meta = m.metadata as Record<string, unknown>;
    if (meta.outcome === 'tp_hit') tp++;
    else if (meta.outcome === 'sl_hit') sl++;
    const action = meta.aiAction;
    if ((action === 'buy' || action === 'sell') && meta.outcome === 'sl_hit') aiWrong++;
    if (typeof meta.regime === 'string' && (meta.outcome === 'tp_hit' || meta.outcome === 'sl_hit')) {
      let rc = regimeCounts.get(meta.regime);
      if (!rc) { rc = { tp: 0, sl: 0 }; regimeCounts.set(meta.regime, rc); }
      if (meta.outcome === 'tp_hit') rc.tp++; else rc.sl++;
    }
  }
  if (tp + sl < 3) return null;

  let s = `${near.length} casos históricos muy similares: ${tp} alcanzaron TP y ${sl} tocaron SL (acierto ${Math.round((tp / (tp + sl)) * 100)}%).`;
  if (aiWrong > 0) {
    s += ` En ${aiWrong} de ellos la IA validó la señal y acabó en SL.`;
  }
  if (regimeCounts.size > 0) {
    const parts = [...regimeCounts.entries()]
      .map(([r, c]) => `${r}: ${c.tp}/${c.tp + c.sl} TP`);
    s += ` Por régimen — ${parts.join('; ')}.`;
  }
  return s;
}

/* ---------- reflexión: destilar lecciones de los errores ---------- */

export interface MistakeCase {
  symbol: string;
  interval: string;
  pattern: string;
  direction: string;
  rr: number;
  aiAction: string;
  aiConfidence: number;
  aiThesis: string;
  outcome: string;
  /** Régimen de mercado de la señal (regime.ts); null en filas antiguas. */
  regime?: string | null;
  /** Taxonomía determinista del error (review.ts), si hay review. */
  mistakeType?: string | null;
  cause?: string | null;
}

export interface DistilledLesson {
  scope: string;
  lesson: string;
  mistakeType: string | null;
  cause: string | null;
  affectedPatterns: string[];
}

const REFLECT_PROMPT = `Eres el auditor de un sistema de señales de Forex. Recibes una lista de
errores recientes de la IA evaluadora: señales que validó y acabaron en stop
loss, o que descartó y acabaron en take profit. Cada caso puede traer
"regime" (régimen de mercado), "mistakeType" y "cause" (clasificación
determinista del error).

Destila como máximo 5 lecciones cortas, concretas y accionables que eviten
repetir estos errores. Cada lección debe describir una condición observable
(patrón, mercado, régimen, RSI, volumen, tendencia, RR...) y qué hacer al
respecto. No inventes datos que no estén en los casos. Generaliza solo con
>= 3 casos que apunten en la misma dirección; si un error es de un mercado
concreto, usa su scope.

Responde EXCLUSIVAMENTE con JSON válido, sin markdown:
{"lessons": [{
  "scope": "global" | "SYMBOL|interval",
  "lesson": "<frase imperativa <= 220 caracteres>",
  "mistakeType": "<mistakeType dominante de los casos que la respaldan, o null>",
  "cause": "<causa dominante, o null>",
  "affectedPatterns": ["<patrones exactos implicados>"]
}]}`;

export async function reflectOnMistakes(
  ai: Ai,
  model: string,
  cases: MistakeCase[],
  telemetry?: import('./ai').AiTelemetry,
): Promise<DistilledLesson[]> {
  const user = JSON.stringify(cases, null, 1);
  const started = Date.now();
  let result: { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  try {
    result = (await ai.run(model as Parameters<Ai['run']>[0], {
      messages: [
        { role: 'system', content: REFLECT_PROMPT },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: 768,
    })) as typeof result;
  } catch (e) {
    if (telemetry) {
      const { estimateCost, estimateTokens, logAiCall } = await import('./aiLog');
      const tokensIn = estimateTokens(REFLECT_PROMPT + user);
      await logAiCall(telemetry.db, {
        kind: 'reflect', model, promptVersion: REFLECT_PROMPT_VERSION, sigKey: null,
        latencyMs: Date.now() - started, tokensIn, tokensOut: 0,
        estCostUsd: estimateCost(tokensIn, 0, telemetry.rates),
        success: false, error: e instanceof Error ? e.message : String(e),
      });
    }
    throw e;
  }

  const raw =
    typeof result.response === 'string' ? result.response : JSON.stringify(result.response ?? '');

  if (telemetry) {
    const { estimateCost, estimateTokens, logAiCall } = await import('./aiLog');
    const tokensIn = result.usage?.prompt_tokens ?? estimateTokens(REFLECT_PROMPT + user);
    const tokensOut = result.usage?.completion_tokens ?? estimateTokens(raw);
    await logAiCall(telemetry.db, {
      kind: 'reflect', model, promptVersion: REFLECT_PROMPT_VERSION, sigKey: null,
      latencyMs: Date.now() - started, tokensIn, tokensOut,
      estCostUsd: estimateCost(tokensIn, tokensOut, telemetry.rates),
      success: true, error: null,
    });
  }
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]) as {
      lessons?: {
        scope?: unknown; lesson?: unknown; mistakeType?: unknown;
        cause?: unknown; affectedPatterns?: unknown;
      }[];
    };
    const valid = /^(global|[A-Z]{6}\|[a-z0-9]+)$/;
    return (parsed.lessons ?? [])
      .map((l) => ({
        scope: String(l.scope ?? 'global'),
        lesson: String(l.lesson ?? '').trim().slice(0, 240),
        mistakeType:
          typeof l.mistakeType === 'string' && l.mistakeType.length > 0
            ? l.mistakeType.slice(0, 60) : null,
        cause:
          typeof l.cause === 'string' && l.cause.length > 0
            ? l.cause.slice(0, 160) : null,
        affectedPatterns: Array.isArray(l.affectedPatterns)
          ? l.affectedPatterns.filter((p): p is string => typeof p === 'string').slice(0, 8)
          : [],
      }))
      .filter((l) => l.lesson.length >= 20 && valid.test(l.scope))
      .slice(0, 5);
  } catch {
    return [];
  }
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
