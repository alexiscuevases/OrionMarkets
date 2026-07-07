import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import {
  getCursor, getOpenSignals, getUnevaluatedSignals, insertSignals,
  loadCandles, setCursor, updateOutcome, upsertCandles,
} from './db';
import { fetchSeries } from './twelvedata';
import { detectAll, resolveOutcome } from './patterns';
import { buildContext } from './enrich';
import { evaluateSignal } from './ai';
import { scoreSignal } from './scoring';
import {
  HISTORY_START, INTERVALS, SYMBOLS,
  type Env, type SignalContext, type AiVerdict,
} from './types';

export interface PipelineParams {
  trigger: 'cron' | 'manual';
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

    /* ---------- FASE 1 · Ingesta ---------- */

    let ingested = 0;
    for (const symbol of SYMBOLS) {
      for (const interval of INTERVALS) {
        // hasta 2 páginas por combinación y ejecución: el backfill desde
        // HISTORY_START converge en pocas horas sin agotar la cuota diaria
        for (const page of [1, 2] as const) {
          const res = await step.do(
            `ingesta ${symbol} ${interval} p${page}`,
            RETRY,
            async () => {
              const cursor = await getCursor(db, symbol, interval);
              const startTs = cursor > 0 ? cursor + 1000 : Date.parse(`${HISTORY_START}T00:00:00Z`);
              const { candles, hasMore } = await fetchSeries(
                this.env.TWELVEDATA_API_KEY, symbol, interval, startTs,
              );
              if (candles.length > 0) {
                await upsertCandles(db, symbol, interval, candles);
                await setCursor(db, symbol, interval, candles[candles.length - 1].ts);
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
      for (const interval of INTERVALS) {
        const res = await step.do(`detecta ${symbol} ${interval}`, RETRY, async () => {
          const candles = await loadCandles(db, symbol, interval, 50_000);
          if (candles.length === 0) return { inserted: 0, resolved: 0 };

          // detección sobre todo el histórico → también señales pasadas
          const signals = detectAll(symbol, interval, candles);
          const inserted = await insertSignals(db, signals);

          // resolver TP/SL de señales aún abiertas con las velas nuevas
          let resolved = 0;
          for (const open of await getOpenSignals(db, symbol, interval)) {
            const r = resolveOutcome(open, candles);
            if (r.outcome !== 'open') {
              await updateOutcome(db, open.sigKey, r.outcome, r.outcomeTs);
              resolved++;
            }
          }
          return { inserted, resolved };
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

      const verdict = await step.do(`ia ${sig.sigKey}`, AI_RETRY, async () =>
        evaluateSignal(this.env.AI, this.env.AI_MODEL, dossier),
      );

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
