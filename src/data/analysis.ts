import type { ApiCalibrationBucket } from '../api/client';
import type { AISignal, SignalCtx } from './market';

/* Análisis explicable de una señal: traduce el dossier determinista
   (context_json) y el desglose de scoring a factores legibles, y separa
   el score global en Técnico / IA / Riesgo / Calidad. Los umbrales
   replican los del scoring del motor (worker/src/scoring.ts) para que
   la explicación coincida con la puntuación. */

export interface Factor {
  text: string;
}

export type RiskLevel = 'Bajo' | 'Medio' | 'Alto';

export interface SignalAnalysis {
  positives: Factor[];
  negatives: Factor[];
  technicalScore: number | null; // 0-100, solo dimensiones deterministas
  aiScore: number | null;        // confianza declarada por la IA (0-100)
  risk: RiskLevel | null;
  grade: string | null;          // calidad A+…D derivada del score global
  patternProb: { pct: number; n: number } | null; // acierto real del patrón aquí
  conclusion: string | null;
}

/* Pesos de las dimensiones computables, espejo de WEIGHTS del motor
   (sin news/sentiment, que son valoración cualitativa de la IA). */
const TECH_WEIGHTS: Record<string, number> = {
  trend: 1.5,
  momentum: 1.2,
  volume: 0.8,
  volatility: 1.0,
  macro: 1.0,
  institutional: 1.0,
  riskReward: 1.4,
  history: 1.3,
};

export function gradeForScore(score: number): string {
  return score >= 85 ? 'A+'
    : score >= 75 ? 'A'
    : score >= 68 ? 'B+'
    : score >= 60 ? 'B'
    : score >= 50 ? 'C'
    : 'D';
}

/** Acierto real de veredictos IA pasados en el mismo tramo de confianza. */
export function calibratedProb(
  confidence: number | null | undefined,
  buckets: ApiCalibrationBucket[],
): { pct: number; n: number } | null {
  if (confidence == null) return null;
  const key =
    confidence < 50 ? 'lt50' : confidence < 65 ? '50-64' : confidence < 80 ? '65-79' : '80plus';
  const b = buckets.find((x) => x.bucket === key);
  if (!b || b.n < 10) return null;
  return { pct: Math.round(b.tpRate * 100), n: b.n };
}

export function buildAnalysis(s: AISignal): SignalAnalysis {
  const ctx = s.context ?? null;
  const positives: Factor[] = [];
  const negatives: Factor[] = [];
  const buy = s.direction === 'buy';
  const dirWord = buy ? 'compra' : 'venta';

  let riskPts = 0;
  let patternProb: SignalAnalysis['patternProb'] = null;

  if (ctx) {
    // Tendencia de marco superior (H1)
    const withTrend =
      (buy && ctx.trendHigherTf === 'alcista') || (!buy && ctx.trendHigherTf === 'bajista');
    if (withTrend) {
      positives.push({ text: `Tendencia H1 ${ctx.trendHigherTf}, a favor de la ${dirWord}` });
    } else if (ctx.trendHigherTf === 'lateral') {
      negatives.push({ text: 'Mercado lateral en H1: sin viento de cola' });
      riskPts += 1;
    } else {
      negatives.push({ text: `Tendencia H1 todavía ${ctx.trendHigherTf}: entrada contra tendencia` });
      riskPts += 2;
    }

    // Posición y pendiente de la EMA 200
    const withEma = buy === (ctx.ema200 === 'precio por encima');
    (withEma ? positives : negatives).push({
      text: withEma
        ? `Precio ${ctx.ema200} de la EMA 200, coherente con la ${dirWord}`
        : `Precio ${ctx.ema200} de la EMA 200, en contra de la ${dirWord}`,
    });
    const slopeAligned =
      (buy && ctx.ema200Slope === 'ascendente') || (!buy && ctx.ema200Slope === 'descendente');
    if (slopeAligned) {
      positives.push({ text: `EMA 200 con pendiente ${ctx.ema200Slope}` });
    }

    // RSI 14 (mismos tramos que el scoring de momentum)
    const rsi = ctx.rsi14;
    if (buy) {
      if (rsi >= 45 && rsi <= 65) positives.push({ text: `RSI en ${rsi}: impulso sano sin agotamiento` });
      else if (rsi > 65 && rsi <= 75) negatives.push({ text: `RSI alto (${rsi}): recorrido alcista limitado` });
      else if (rsi > 75) { negatives.push({ text: `RSI en sobrecompra (${rsi})` }); riskPts += 1; }
      else if (rsi < 30) positives.push({ text: `RSI en sobreventa (${rsi}): posible rebote` });
      else negatives.push({ text: `RSI débil (${rsi}) para una compra` });
    } else {
      if (rsi <= 55 && rsi >= 35) positives.push({ text: `RSI en ${rsi}: impulso bajista sano` });
      else if (rsi < 35 && rsi >= 25) negatives.push({ text: `RSI bajo (${rsi}): recorrido bajista limitado` });
      else if (rsi < 25) { negatives.push({ text: `RSI en sobreventa (${rsi})` }); riskPts += 1; }
      else if (rsi > 70) positives.push({ text: `RSI saliendo de sobrecompra (${rsi})` });
      else negatives.push({ text: `RSI alto (${rsi}) para una venta` });
    }

    // Volumen
    if (ctx.volumeTrend === 'creciente') positives.push({ text: 'Volumen creciente confirma el movimiento' });
    else if (ctx.volumeTrend === 'decreciente') negatives.push({ text: 'Volumen decreciente: poca convicción' });

    // Volatilidad (ATR % del precio)
    if (ctx.atrPct >= 0.05 && ctx.atrPct <= 0.25) {
      positives.push({ text: `Volatilidad sana (ATR ${ctx.atrPct}%)` });
    } else if (ctx.atrPct < 0.05) {
      negatives.push({ text: `Volatilidad muy baja (ATR ${ctx.atrPct}%): el movimiento puede tardar` });
      riskPts += 1;
    } else {
      negatives.push({ text: `Volatilidad elevada (ATR ${ctx.atrPct}%): stops expuestos` });
      riskPts += ctx.atrPct > 0.4 ? 2 : 1;
    }

    // Espacio hasta el extremo reciente en la dirección del trade
    const room = buy ? ctx.distanceToRecentHigh : ctx.distanceToRecentLow;
    const extreme = buy ? 'máximo' : 'mínimo';
    if (room > 0.6) positives.push({ text: `Espacio hasta el ${extreme} reciente (${room}%)` });
    else if (room < 0.3) negatives.push({ text: `El ${extreme} reciente está muy cerca (${room}%): posible freno` });

    // Historial real del patrón en este símbolo + intervalo
    const mine = ctx.recentOutcomes?.find((o) => o.pattern === s.pattern);
    if (mine && mine.total >= 10) {
      const pct = Math.round(mine.tpRate * 100);
      patternProb = { pct, n: mine.total };
      if (mine.tpRate >= 0.55) {
        positives.push({ text: `El patrón acierta el ${pct}% en este mercado (${mine.total} casos)` });
      } else if (mine.tpRate < 0.45) {
        negatives.push({ text: `El patrón solo acierta el ${pct}% en este mercado (${mine.total} casos)` });
        riskPts += 1;
      }
    }

    // Noticias (null hasta conectar proveedor)
    if (ctx.news) negatives.push({ text: `Noticias próximas: ${ctx.news}` });
  }

  // Ratio riesgo/beneficio (disponible aunque no haya dossier)
  const rr = s.rr ?? ctx?.riskReward;
  if (rr != null) {
    if (rr >= 2) positives.push({ text: `Ratio riesgo/beneficio favorable (1:${rr.toFixed(1)})` });
    else if (rr < 1.5) { negatives.push({ text: `Ratio riesgo/beneficio ajustado (1:${rr.toFixed(1)})` }); riskPts += 1; }
  }

  // Score técnico: media ponderada de las dimensiones deterministas (0-5 → 0-100)
  let technicalScore: number | null = null;
  if (s.scores) {
    let sum = 0;
    let weight = 0;
    for (const [k, w] of Object.entries(TECH_WEIGHTS)) {
      const v = s.scores[k];
      if (typeof v === 'number') { sum += v * w; weight += w; }
    }
    if (weight > 0) technicalScore = Math.round((sum / weight / 5) * 100);
  }

  const evaluated = s.aiAction != null;
  const risk: RiskLevel | null = !evaluated && !ctx
    ? null
    : riskPts >= 4 ? 'Alto' : riskPts >= 2 ? 'Medio' : 'Bajo';

  const grade = s.overallScore != null ? gradeForScore(s.overallScore) : null;

  let conclusion: string | null = null;
  if (s.aiAction === 'skip') {
    conclusion = 'La IA descartó esta señal: los factores en contra pesan más que la oportunidad.';
  } else if (evaluated && s.overallScore != null && risk) {
    const riskWord = risk === 'Bajo' ? 'bajo' : risk === 'Medio' ? 'moderado' : 'alto';
    conclusion =
      s.overallScore >= 68 && risk !== 'Alto'
        ? `Entrada válida con riesgo ${riskWord}.`
        : s.overallScore >= 50
          ? `Entrada aceptable pero con riesgo ${riskWord}: conviene reducir tamaño.`
          : `Señal débil y riesgo ${riskWord}: mejor esperar confirmación.`;
  }

  return {
    positives,
    negatives,
    technicalScore,
    aiScore: s.aiConfidence ?? null,
    risk,
    grade,
    patternProb,
    conclusion,
  };
}

export type { SignalCtx };
