import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import {
  addLessons, getAiCalibration, getAiMistakes, getCursor, getLessons,
  getOpenSignals, getReevaluableSignals, getUnevaluatedSignals,
  getUnindexedClosed, insertSignals, loadCandles, markIndexed, setCursor,
  updateOutcomes, upsertCandles,
} from './db';
import { fetchSeries } from './twelvedata';
import { detectAll, profileFor, resolveOutcome } from './patterns';
import { buildContext } from './enrich';
import { evaluateSignal } from './ai';
import { calibrationFor, scoreSignal } from './scoring';
import {
  caseText, embedTexts, featuresFromCandles, featuresFromContext,
  reflectOnMistakes, summarizeSimilarCases,
} from './learn';
import {
  HISTORY_START, INTERVALS, INTERVAL_MS, SYMBOLS,
  type CalibrationBucket, type Env, type Interval, type SignalContext, type AiVerdict,
} from './types';

export interface PipelineParams {
  trigger: 'cron' | 'manual';
  /** Intervalos a refrescar en esta pasada; ausente/vacío → todos. */
  intervals?: Interval[];
}

/* Pipeline horario en 5 fases (un solo workflow → orden garantizado,
   reintentos por paso y estado persistido):

   1. INGESTA      Twelve Data → D1 (incremental por símbolo+intervalo,
                   espaciado para respetar 8 créditos/min del plan free)
   2. DETECCIÓN    algoritmos deterministas sobre TODO el histórico
                   + resolución de resultados de señales abiertas (TP/SL)
   3. IA           dossier + gate por expectancia + memoria de casos
                   similares + lecciones aprendidas → Workers AI, solo
                   señales con confianza determinista >= AI_MIN_CONFIDENCE;
                   además re-evalúa señales abiertas cuya evaluación caducó
                   con la llegada de velas nuevas (dossier al presente)
   4. SCORING      puntuación multidimensional 0-100 (ajuste IA calibrado
                   con su acierto real) → D1 + resumen en KV
   5. APRENDIZAJE  indexa cierres en Vectorize (memoria de casos) y
                   destila lecciones de los errores IA (reflexión) */

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

    // conocimiento acumulado del sistema: lecciones destiladas de errores
    // pasados + calibración empírica de la confianza de la IA
    const knowledge = await step.do('carga lecciones y calibración', RETRY, async () => ({
      lessons: await getLessons(db),
      calibration: await getAiCalibration(db),
    }));

    let evaluated = 0;
    let topScore = 0;

    for (const sig of pending) {
      const dossier = await step.do(`dossier ${sig.sigKey}`, RETRY, async () => {
        const candles = await loadCandles(db, sig.symbol, sig.interval, 3000);
        return buildContext(db, sig, candles);
      });

      // memoria de casos: situaciones históricas casi idénticas y su
      // resultado real; si el índice aún no existe se evalúa sin memoria
      dossier.similarCases = await step.do(`similares ${sig.sigKey}`, async () => {
        try {
          const [vector] = await embedTexts(
            this.env.AI, [caseText(featuresFromContext(dossier))],
          );
          const res = await this.env.VECTOR_INDEX.query(vector, {
            topK: 8,
            returnMetadata: 'all',
          });
          return summarizeSimilarCases(res.matches);
        } catch {
          return null;
        }
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

      // lecciones aplicables a esta señal: globales + las de su mercado
      const lessons = knowledge.lessons
        .filter((l) => l.scope === 'global' || l.scope === `${sig.symbol}|${sig.interval}`)
        .map((l) => l.lesson)
        .slice(0, 8);

      // si la IA falla definitivamente (reintentos agotados) se registra un
      // skip conservador y el pipeline continúa con el resto de señales en
      // lugar de abortar toda la ejecución
      let verdict: AiVerdict;
      try {
        verdict = await step.do(`ia ${sig.sigKey}`, AI_RETRY, async () =>
          evaluateSignal(this.env.AI, this.env.AI_MODEL, dossier, lessons),
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
        persistEvaluation(
          db, this.env.AI_MODEL, sig.sigKey, dossier, verdict,
          calibrationFor(verdict.confidence, knowledge.calibration),
        ),
      );

      evaluated++;
      topScore = Math.max(topScore, overall);
    }

    /* ---------- FASE 3c · Re-evaluación de señales abiertas ----------
       Un veredicto emitido al detectar la señal caduca a medida que llegan
       velas nuevas. Cada pasada re-analiza las evaluaciones más antiguas
       con el dossier recalculado al presente (la señal sigue abierta, así
       que aquí no hay look-ahead) y sobreescribe el veredicto con una
       revisión nueva: la confianza puede subir, bajar o pasar a skip. */

    const maxReeval = Number(this.env.AI_MAX_REEVAL) || 4;

    const stale = await step.do('selecciona re-evaluaciones', async () => {
      const now = Date.now();
      return (await getReevaluableSignals(db, 32))
        // caduca al cerrar una vela nueva de su intervalo; mínimo 15 min
        // para que M5 no se re-evalúe en cada pasada del cron
        .filter((c) => {
          const bar = INTERVAL_MS[c.interval as Interval] ?? 3_600_000;
          return now - c.evalTs >= Math.max(bar, 15 * 60_000);
        })
        .slice(0, maxReeval);
    });

    let reevaluated = 0;
    for (const sig of stale) {
      const dossier = await step.do(`re-dossier ${sig.sigKey}`, RETRY, async () => {
        const candles = await loadCandles(db, sig.symbol, sig.interval, 3000);
        const lastTs = candles.length > 0 ? candles[candles.length - 1].ts : sig.ts;
        const ctx = await buildContext(db, sig, candles, lastTs);

        // seguimiento desde la detección: la IA decide sabiendo dónde está
        // el precio respecto a la entrada y qué dictaminó la vez anterior
        const bar = INTERVAL_MS[sig.interval as Interval] ?? 3_600_000;
        const price = candles.length > 0 ? candles[candles.length - 1].close : sig.entry;
        const span = Math.abs(sig.target - sig.entry);
        const signedMove = sig.direction === 'buy' ? price - sig.entry : sig.entry - price;
        ctx.tracking = {
          revision: sig.revision + 1,
          barsSinceDetected: Math.max(0, Math.round((lastTs - sig.ts) / bar)),
          currentPrice: price,
          progressToTargetPct: span > 0 ? Math.round((signedMove / span) * 100) : 0,
          previousVerdict: {
            action: sig.aiAction,
            confidence: sig.aiConfidence,
            thesis: sig.aiThesis,
          },
        };
        return ctx;
      });

      dossier.similarCases = await step.do(`re-similares ${sig.sigKey}`, async () => {
        try {
          const [vector] = await embedTexts(
            this.env.AI, [caseText(featuresFromContext(dossier))],
          );
          const res = await this.env.VECTOR_INDEX.query(vector, {
            topK: 8,
            returnMetadata: 'all',
          });
          return summarizeSimilarCases(res.matches);
        } catch {
          return null;
        }
      });

      const prior = { createdAt: sig.evalCreatedAt, revision: sig.revision };

      // el gate por expectancia también se re-aplica: el historial del
      // patrón puede haberse vuelto negativo desde la evaluación original
      const hist = dossier.recentOutcomes.find((o) => o.pattern === sig.pattern);
      const expectancy =
        hist && hist.total >= 15
          ? hist.tpRate * (hist.avgRr || sig.rr) - (1 - hist.tpRate)
          : null;
      if (expectancy !== null && expectancy <= 0) {
        await step.do(`re-gate ${sig.sigKey}`, RETRY, async () =>
          persistEvaluation(db, 'gate:historial', sig.sigKey, dossier, {
            action: 'skip',
            confidence: 0,
            thesis: `Retirada en re-evaluación: "${sig.pattern}" acumula expectancia ${expectancy.toFixed(2)}R en ${hist!.total} cierres de ${sig.symbol} ${sig.interval}.`,
            risks: 'Patrón con historial perdedor en este mercado.',
            sentimentScore: 3,
            newsScore: 3,
          }, null, prior),
        );
        reevaluated++;
        continue;
      }

      const lessons = knowledge.lessons
        .filter((l) => l.scope === 'global' || l.scope === `${sig.symbol}|${sig.interval}`)
        .map((l) => l.lesson)
        .slice(0, 8);

      // si la IA no responde se conserva el veredicto anterior: mejor una
      // evaluación algo desfasada que sobrescribirla con un skip técnico
      let verdict: AiVerdict;
      try {
        verdict = await step.do(`re-ia ${sig.sigKey}`, AI_RETRY, async () =>
          evaluateSignal(this.env.AI, this.env.AI_MODEL, dossier, lessons),
        );
      } catch {
        continue;
      }

      const overall = await step.do(`re-scoring ${sig.sigKey}`, RETRY, async () =>
        persistEvaluation(
          db, this.env.AI_MODEL, sig.sigKey, dossier, verdict,
          calibrationFor(verdict.confidence, knowledge.calibration), prior,
        ),
      );

      reevaluated++;
      topScore = Math.max(topScore, overall);
    }

    /* ---------- FASE 5 · Aprendizaje ---------- */

    // 5a. memoria de casos: embeber e indexar señales cerradas pendientes
    // (backfill incremental del histórico + los cierres nuevos de cada run)
    const indexedCases = await step.do('indexa casos cerrados', RETRY, async () => {
      const pendingIdx = await getUnindexedClosed(db, 80);
      if (pendingIdx.length === 0) return 0;

      // agrupadas por mercado para cargar las velas una sola vez por grupo
      const groups = new Map<string, typeof pendingIdx>();
      for (const s of pendingIdx) {
        const k = `${s.symbol}|${s.interval}`;
        let g = groups.get(k);
        if (!g) { g = []; groups.set(k, g); }
        g.push(s);
      }

      const vectors: VectorizeVector[] = [];
      const done: string[] = [];
      for (const group of groups.values()) {
        const candles = await loadCandles(db, group[0].symbol, group[0].interval, 50_000);
        const cases: { sigKey: string; text: string; meta: Record<string, string | number> }[] = [];
        for (const s of group) {
          // sin velas suficientes para las features → se marca igualmente
          // como indexada para no reintentarla en cada pasada
          done.push(s.sigKey);
          const f = featuresFromCandles(s, candles);
          if (!f) continue;
          const meta: Record<string, string | number> = {
            outcome: s.outcome,
            pattern: s.pattern,
            symbol: s.symbol,
            interval: s.interval,
            direction: s.direction,
            rr: s.rr,
          };
          if (s.aiAction) {
            meta.aiAction = s.aiAction;
            meta.aiConfidence = s.aiConfidence ?? 0;
          }
          cases.push({ sigKey: s.sigKey, text: caseText(f), meta });
        }
        if (cases.length > 0) {
          const embeddings = await embedTexts(this.env.AI, cases.map((c) => c.text));
          cases.forEach((c, i) => {
            vectors.push({ id: c.sigKey, values: embeddings[i], metadata: c.meta });
          });
        }
      }

      try {
        if (vectors.length > 0) await this.env.VECTOR_INDEX.upsert(vectors);
      } catch {
        return 0; // índice aún no creado: se reintenta en la próxima pasada
      }
      await markIndexed(db, done);
      return vectors.length;
    });

    // 5b. reflexión: destilar lecciones de los errores IA cerrados desde la
    // última reflexión; un fallo aquí nunca tumba el pipeline
    let newLessons = 0;
    try {
      const cursor = await step.do('cursor de reflexión', async () =>
        Number((await this.env.CACHE.get('learn:reflect_cursor')) ?? '0'),
      );
      const mistakes = await step.do('busca errores IA', RETRY, async () =>
        getAiMistakes(db, cursor, 20),
      );
      if (mistakes.length >= 4) {
        newLessons = await step.do('reflexión sobre errores', AI_RETRY, async () => {
          const lessons = await reflectOnMistakes(
            this.env.AI,
            this.env.AI_MODEL,
            mistakes.map(({ outcomeTs: _ts, ...c }) => c),
          );
          if (lessons.length > 0) {
            await addLessons(db, lessons.map((l) => ({ ...l, support: mistakes.length })));
          }
          // el cursor avanza aunque no salgan lecciones: esos casos ya se vieron
          await this.env.CACHE.put(
            'learn:reflect_cursor',
            String(mistakes[mistakes.length - 1].outcomeTs),
          );
          return lessons.length;
        });
      }
    } catch {
      newLessons = 0;
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
          reevaluated,
          topScore,
          indexedCases,
          newLessons,
        }),
      );
    });

    return { ingested, newSignals, evaluated, reevaluated, topScore, indexedCases, newLessons };
  }
}

async function persistEvaluation(
  db: D1Database,
  model: string,
  sigKey: string,
  dossier: SignalContext,
  verdict: AiVerdict,
  calib: CalibrationBucket | null = null,
  /** En re-evaluaciones: conserva created_at original e incrementa la revisión. */
  prior: { createdAt: number; revision: number } | null = null,
): Promise<number> {
  const { breakdown, overall } = scoreSignal(dossier, verdict, calib);
  const now = Date.now();
  await db
    .prepare(
      `INSERT OR REPLACE INTO evaluations
       (sig_key, context_json, ai_action, ai_confidence, ai_thesis, ai_risks,
        scores_json, overall_score, model, created_at, revision, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      prior?.createdAt ?? now,
      prior ? prior.revision + 1 : 1,
      now,
    )
    .run();
  return overall;
}
