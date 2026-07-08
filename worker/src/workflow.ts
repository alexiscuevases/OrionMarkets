import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import {
  getCursor, getOpenSignals, getUnevaluatedSignals, insertSignals,
  loadCandles, setCursor, updateOutcomes, upsertCandles,
} from './db';
import { fetchSeries } from './twelvedata';
import { detectAll, profileFor, resolveOutcome } from './patterns';
import { buildContext } from './enrich';
import { evaluateSignal } from './ai';
import { scoreSignal } from './scoring';
import {
  HISTORY_START, INTERVALS, INTERVAL_MS, SYMBOLS,
  type Env, type Interval, type SignalContext, type AiVerdict,
} from './types';

export interface PipelineParams {
  trigger: 'cron' | 'manual';
  /** Intervalos a refrescar en esta pasada; ausente/vacío → todos. */
  intervals?: Interval[];
}

/* Pipeline horario en 4 fases (un solo workflow → orden garantizado,
   reintentos por paso y estado persistido):

   1. INGESTA    Twelve Data → D1 (incremental por símbolo+intervalo,
                 espaciado para respetar 8 créditos/min del plan free)
   2. DETECCIÓN  algoritmos deterministas sobre TODO el histórico
                 + resolución de resultados de señales abiertas (TP/SL)
   3. IA         dossier de contexto + Workers AI, solo para señales
                 con confianza determinista >= AI_MIN_CONFIDENCE
   4. SCORING    puntuación multidimensional 0-100 → D1 + resumen en KV */

const RETRY: WorkflowStepConfig = {
  retries: { limit: 4, delay: '20 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
};

const AI_RETRY: WorkflowStepConfig = {
  retries: { limit: 3, delay: '15 seconds', backoff: 'exponential' },
  timeout: '90 seconds',
};

export class OrionPipeline extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const db = this.env.DB;
    const intervals: readonly Interval[] =
      event.payload.intervals?.length ? event.payload.intervals : INTERVALS;

    /* ---------- FASE 1 · Ingesta ---------- */

    let ingested = 0;
    for (const symbol of SYMBOLS) {
      for (const interval of intervals) {
        // hasta 2 páginas por combinación y ejecución: el backfill desde
        // HISTORY_START converge en pocas horas sin agotar la cuota diaria
        for (const page of [1, 2] as const) {
          const res = await step.do(
            `ingesta ${symbol} ${interval} p${page}`,
            RETRY,
            async () => {
              const cursor = await getCursor(db, symbol, interval);
              const startTs = cursor > 0 ? cursor + 1000 : Date.parse(`${HISTORY_START}T00:00:00Z`);
              const { candles, windowEnd, hasMore } = await fetchSeries(
                this.env.TWELVEDATA_API_KEY, symbol, interval, startTs,
              );
              if (candles.length > 0) {
                await upsertCandles(db, symbol, interval, candles);
              }
              // avance del cursor:
              // - ventana histórica: salta al fin de ventana aunque venga vacía
              //   (huecos de fin de semana), o no repetiríamos nunca el hueco
              // - ventana que llega al presente: retrocede una vela para
              //   re-tomar en la próxima ejecución la vela aún en formación
              let newCursor: number;
              if (hasMore) {
                newCursor = windowEnd;
              } else if (candles.length > 0) {
                newCursor = Math.max(
                  cursor,
                  candles[candles.length - 1].ts - INTERVAL_MS[interval],
                );
              } else {
                newCursor = cursor;
              }
              if (newCursor !== cursor) {
                await setCursor(db, symbol, interval, newCursor);
              }
              return { count: candles.length, hasMore };
            },
          );
          ingested += res.count;

          // rate limit del plan free: ~6,6 req/min con 9 s entre peticiones
          await step.sleep(`rate limit tras ${symbol} ${interval} p${page}`, '9 seconds');
          if (!res.hasMore) break;
        }
      }
    }

    /* ---------- FASE 2 · Detección determinista ---------- */

    let newSignals = 0;
    for (const symbol of SYMBOLS) {
      for (const interval of intervals) {
        const res = await step.do(`detecta ${symbol} ${interval}`, RETRY, async () => {
          const candles = await loadCandles(db, symbol, interval, 50_000);
          if (candles.length === 0) return { inserted: 0, resolved: 0 };

          // detección sobre todo el histórico → también señales pasadas
          const signals = detectAll(symbol, interval, candles);
          const inserted = await insertSignals(db, signals);

          // resolver TP/SL/expiración de señales abiertas con las velas
          // nuevas; los UPDATE van en lote para no agotar subrequests
          const expiryBars = profileFor(interval).expiryBars;
          const resolutions = [];
          for (const open of await getOpenSignals(db, symbol, interval)) {
            const r = resolveOutcome(open, candles, expiryBars);
            if (r.outcome !== 'open') {
              resolutions.push({ sigKey: open.sigKey, outcome: r.outcome, outcomeTs: r.outcomeTs });
            }
          }
          await updateOutcomes(db, resolutions);
          return { inserted, resolved: resolutions.length };
        });
        newSignals += res.inserted;
      }
    }

    /* ---------- FASE 3 · Evaluación IA (solo patrones fiables) ---------- */

    const minConfidence = Number(this.env.AI_MIN_CONFIDENCE) || 65;
    const maxPerRun = Number(this.env.AI_MAX_PER_RUN) || 8;

    const pending = await step.do('selecciona señales para IA', async () =>
      getUnevaluatedSignals(db, minConfidence, maxPerRun),
    );

    let evaluated = 0;
    let topScore = 0;

    for (const sig of pending) {
      const dossier = await step.do(`dossier ${sig.sigKey}`, RETRY, async () => {
        const candles = await loadCandles(db, sig.symbol, sig.interval, 3000);
        return buildContext(db, sig, candles);
      });

      // gate por historial: si el patrón acumula expectancia negativa real
      // en este símbolo+intervalo (muestra >= 15 cierres) se descarta sin
      // gastar cuota de IA — el sistema aprende de sus propios resultados
      const hist = dossier.recentOutcomes.find((o) => o.pattern === sig.pattern);
      const expectancy =
        hist && hist.total >= 15
          ? hist.tpRate * (hist.avgRr || sig.rr) - (1 - hist.tpRate)
          : null;
      if (expectancy !== null && expectancy <= 0) {
        await step.do(`gate ${sig.sigKey}`, RETRY, async () =>
          persistEvaluation(db, 'gate:historial', sig.sigKey, dossier, {
            action: 'skip',
            confidence: 0,
            thesis: `Descartada sin IA: "${sig.pattern}" acumula expectancia ${expectancy.toFixed(2)}R en ${hist!.total} cierres de ${sig.symbol} ${sig.interval}.`,
            risks: 'Patrón con historial perdedor en este mercado.',
            sentimentScore: 3,
            newsScore: 3,
          }),
        );
        continue;
      }

      // si la IA falla definitivamente (reintentos agotados) se registra un
      // skip conservador y el pipeline continúa con el resto de señales en
      // lugar de abortar toda la ejecución
      let verdict: AiVerdict;
      try {
        verdict = await step.do(`ia ${sig.sigKey}`, AI_RETRY, async () =>
          evaluateSignal(this.env.AI, this.env.AI_MODEL, dossier),
        );
      } catch {
        verdict = {
          action: 'skip',
          confidence: 0,
          thesis: 'IA no disponible tras varios reintentos; se descarta por prudencia.',
          risks: 'Evaluación IA no completada.',
          sentimentScore: 3,
          newsScore: 3,
        };
      }

      /* ---------- FASE 4 · Scoring ---------- */

      const overall = await step.do(`scoring ${sig.sigKey}`, RETRY, async () =>
        persistEvaluation(db, this.env.AI_MODEL, sig.sigKey, dossier, verdict),
      );

      evaluated++;
      topScore = Math.max(topScore, overall);
    }

    /* ---------- Resumen para el frontend ---------- */

    await step.do('publica resumen en KV', RETRY, async () => {
      await this.env.CACHE.put(
        'pipeline:last_run',
        JSON.stringify({
          finishedAt: new Date().toISOString(),
          trigger: event.payload.trigger,
          ingested,
          newSignals,
          evaluated,
          topScore,
        }),
      );
    });

    return { ingested, newSignals, evaluated, topScore };
  }
}

async function persistEvaluation(
  db: D1Database,
  model: string,
  sigKey: string,
  dossier: SignalContext,
  verdict: AiVerdict,
): Promise<number> {
  const { breakdown, overall } = scoreSignal(dossier, verdict);
  await db
    .prepare(
      `INSERT OR REPLACE INTO evaluations
       (sig_key, context_json, ai_action, ai_confidence, ai_thesis, ai_risks,
        scores_json, overall_score, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      sigKey,
      JSON.stringify(dossier),
      verdict.action,
      verdict.confidence,
      verdict.thesis,
      verdict.risks,
      JSON.stringify(breakdown),
      overall,
      model,
      Date.now(),
    )
    .run();
  return overall;
}
