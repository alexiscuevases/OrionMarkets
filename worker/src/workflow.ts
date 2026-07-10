import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import {
  addLessons, countClosedEvaluated, getAiCalibration, getAiMistakes,
  getClosedBreakdowns, getCursor, getLessons, getOpenSignals,
  getPatternHealthMap, getPatternStats, getReevaluableSignals,
  getScoringWeights, getSignalsMissingRegime, getUnevaluatedSignals,
  getUnindexedClosed, getUnreviewedClosed, insertSignals, insertTradeReviews,
  loadCandles, markIndexed, saveScoringWeights, setCursor, updateOutcomes,
  updateSignalRegimes, upsertCandles, upsertPatternHealth,
  type PatternHealthRow,
} from './db';
import { fetchSeries } from './twelvedata';
import { detectAll, profileFor, resolveOutcome } from './patterns';
import { buildContext } from './enrich';
import { evaluateSignal } from './ai';
import {
  calibrationFor, computeDimensionPerformance, DEFAULT_WEIGHTS, evolveWeights,
  scoreSignal, type ScoringWeights,
} from './scoring';
import {
  caseText, embedTexts, featuresFromCandles, featuresFromContext,
  reflectOnMistakes, summarizeSimilarCases,
} from './learn';
import { computePatternHealth, expectancyOf, HEALTH_THRESHOLDS } from './health';
import { makeRegimeCalculator } from './regime';
import { classifyTradeReview } from './review';
import { costRates, pruneAiCalls } from './aiLog';
import { recordRunEnd, recordRunStart } from './observe';
import {
  ensureAccount, openPaperPositions, resolvePaperPositions,
} from './paper';
import { PROMPT_VERSION, STRATEGY_VERSION } from './versions';
import {
  HISTORY_START, INTERVALS, INTERVAL_MS, SYMBOLS,
  type CalibrationBucket, type Env, type Interval, type Outcome,
  type SignalContext, type AiVerdict,
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

/** Lock best-effort para no solapar pipelines (P0-4): dos ingestas
    simultáneas compiten por los 8 créditos/min de Twelve Data. */
export const PIPELINE_LOCK_KEY = 'pipeline:lock';
const PIPELINE_LOCK_TTL = 25 * 60; // segundos; > duración normal de un run

export class OrionPipeline extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const db = this.env.DB;
    const intervals: readonly Interval[] =
      event.payload.intervals?.length ? event.payload.intervals : INTERVALS;
    const rates = costRates(this.env);

    await step.do('registra inicio del run', RETRY, async () => {
      await recordRunStart(db, event.instanceId, event.payload.trigger);
      await this.env.CACHE.put(PIPELINE_LOCK_KEY, event.instanceId, {
        expirationTtl: PIPELINE_LOCK_TTL,
      });
    });

    try {
      const result = await this.pipeline(event, step, intervals, rates);
      await step.do('registra fin del run', RETRY, async () => {
        await recordRunEnd(db, event.instanceId, 'success', result);
        await this.env.CACHE.delete(PIPELINE_LOCK_KEY);
      });
      return result;
    } catch (e) {
      // fuera de step: si esto falla, el run queda 'running' y el health
      // lo detecta por antigüedad; el lock caduca solo por TTL
      await recordRunEnd(
        db, event.instanceId, 'error', null,
        e instanceof Error ? e.message : String(e),
      ).catch(() => {});
      await this.env.CACHE.delete(PIPELINE_LOCK_KEY).catch(() => {});
      throw e;
    }
  }

  private async pipeline(
    event: WorkflowEvent<PipelineParams>,
    step: WorkflowStep,
    intervals: readonly Interval[],
    rates: ReturnType<typeof costRates>,
  ) {
    const db = this.env.DB;

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
    let regimeBackfilled = 0;
    for (const symbol of SYMBOLS) {
      for (const interval of intervals) {
        const res = await step.do(`detecta ${symbol} ${interval}`, RETRY, async () => {
          const candles = await loadCandles(db, symbol, interval, 50_000);
          if (candles.length === 0) return { inserted: 0, resolved: 0, regimes: 0 };

          // régimen de mercado por señal (Mejora 1): un clasificador por
          // mercado y pasada, compartiendo las velas ya cargadas (P1-3)
          const regimeOf = makeRegimeCalculator(candles);
          const idxByTs = new Map(candles.map((c, i) => [c.ts, i]));

          // detección sobre todo el histórico → también señales pasadas
          const signals = detectAll(symbol, interval, candles).map((s) => ({
            ...s,
            regime: regimeOf(idxByTs.get(s.ts))?.regime ?? null,
          }));
          const inserted = await insertSignals(db, signals);

          // backfill incremental de régimen en señales previas a la 0007;
          // las incomputables (fuera de ventana o sin muestra) se marcan
          // 'UNKNOWN' para que el backfill converja en vez de reintentarlas
          const missing = await getSignalsMissingRegime(db, symbol, interval, 300);
          const regimeUpdates = missing.map((m) => {
            const idx = idxByTs.get(m.ts);
            const info = idx !== undefined ? regimeOf(idx) : null;
            return { sigKey: m.sigKey, regime: info?.regime ?? 'UNKNOWN' };
          });
          await updateSignalRegimes(db, regimeUpdates);

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
          return { inserted, resolved: resolutions.length, regimes: regimeUpdates.length };
        });
        newSignals += res.inserted;
        regimeBackfilled += res.regimes;
      }
    }

    /* ---------- FASE 2b · Salud de patrones (walk-forward) ----------
       Tras resolver outcomes se recalcula pattern_health para los mercados
       refrescados: ventana completa vs. reciente, degradación y estado.
       SQL puro, cero llamadas IA; el gate y el scoring la consumen. */

    const healthPatterns = await step.do('salud de patrones', RETRY, async () => {
      const since = Date.now() - HEALTH_THRESHOLDS.recentWindowDays * 86_400_000;
      const rows = [];
      for (const symbol of SYMBOLS) {
        for (const interval of intervals) {
          const full = await getPatternStats(db, symbol, interval);
          if (full.length === 0) continue;
          const recent = new Map(
            (await getPatternStats(db, symbol, interval, since)).map((r) => [r.pattern, r]),
          );
          for (const f of full) {
            const r = recent.get(f.pattern);
            rows.push(computePatternHealth(
              { symbol, interval, pattern: f.pattern },
              { total: f.total, tpRate: f.tpRate, avgRr: f.avgRr },
              r ? { total: r.total, tpRate: r.tpRate, avgRr: r.avgRr }
                : { total: 0, tpRate: 0, avgRr: 0 },
            ));
          }
        }
      }
      await upsertPatternHealth(db, rows);
      return rows.length;
    });

    /* ---------- FASE 3 · Evaluación IA (solo patrones fiables) ---------- */

    const minConfidence = Number(this.env.AI_MIN_CONFIDENCE) || 65;
    const maxPerRun = Number(this.env.AI_MAX_PER_RUN) || 8;

    const pending = await step.do('selecciona señales para IA', async () =>
      getUnevaluatedSignals(db, minConfidence, maxPerRun),
    );

    // conocimiento acumulado del sistema: lecciones destiladas de errores
    // pasados + calibración empírica de la confianza de la IA + pesos de
    // scoring vigentes + salud de patrones (arrays: el resultado de un step
    // se persiste como JSON, un Map no sobreviviría al replay)
    const knowledge = await step.do('carga lecciones y calibración', RETRY, async () => ({
      lessons: await getLessons(db),
      calibration: await getAiCalibration(db),
      weights: (await getScoringWeights(db))?.weights ?? null,
      health: [...(await getPatternHealthMap(db)).values()],
    }));
    const healthMap = new Map<string, PatternHealthRow>(
      knowledge.health.map((h) => [`${h.symbol}|${h.interval}|${h.pattern}`, h]),
    );
    const weights: ScoringWeights = knowledge.weights ?? DEFAULT_WEIGHTS;

    let evaluated = 0;
    let topScore = 0;

    for (const sig of pending) {
      const dossier = await step.do(`dossier ${sig.sigKey}`, RETRY, async () => {
        const candles = await loadCandles(db, sig.symbol, sig.interval, 3000);
        return buildContext(db, sig, candles);
      });

      // memoria de casos: situaciones históricas casi idénticas y su
      // resultado real; primero filtrada por marco y régimen (metadata
      // indexes de Vectorize) y, si no hay vecinos suficientes o los
      // índices de metadata no existen aún, la búsqueda global de siempre
      dossier.similarCases = await step.do(`similares ${sig.sigKey}`, async () => {
        try {
          const [vector] = await embedTexts(
            this.env.AI, [caseText(featuresFromContext(dossier))],
            { db, kind: 'embed', sigKey: sig.sigKey, rates },
          );
          return summarizeSimilarCases(
            await this.querySimilar(vector, sig.interval, dossier.marketRegime),
          );
        } catch {
          return null;
        }
      });

      // gate por salud del patrón (pattern_health): 'disabled' = expectancia
      // histórica negativa o degradación reciente severa → descarte sin
      // gastar cuota de IA. Sin fila de salud aún (primeras pasadas tras la
      // migración) se cae al gate clásico por expectancia inline
      const health = healthMap.get(`${sig.symbol}|${sig.interval}|${sig.pattern}`);
      if (health?.status === 'disabled') {
        await step.do(`gate ${sig.sigKey}`, RETRY, async () =>
          persistEvaluation(db, 'gate:salud', sig.sigKey, dossier, {
            action: 'skip',
            confidence: 0,
            thesis: `Descartada sin IA: "${sig.pattern}" está desactivado por salud (expectancia ${health.expectancy.toFixed(2)}R en ${health.totalTrades} cierres; reciente ${health.recentExpectancy.toFixed(2)}R en ${health.recentTrades}).`,
            risks: 'Patrón desactivado por rendimiento real en este mercado.',
            invalidation: '',
            sentimentScore: 3,
            newsScore: 3,
          }),
        );
        continue;
      }
      if (!health) {
        const hist = dossier.recentOutcomes.find((o) => o.pattern === sig.pattern);
        const expectancy =
          hist && hist.total >= 15
            ? expectancyOf(hist.tpRate, hist.avgRr || sig.rr)
            : null;
        if (expectancy !== null && expectancy <= 0) {
          await step.do(`gate ${sig.sigKey}`, RETRY, async () =>
            persistEvaluation(db, 'gate:historial', sig.sigKey, dossier, {
              action: 'skip',
              confidence: 0,
              thesis: `Descartada sin IA: "${sig.pattern}" acumula expectancia ${expectancy.toFixed(2)}R en ${hist!.total} cierres de ${sig.symbol} ${sig.interval}.`,
              risks: 'Patrón con historial perdedor en este mercado.',
              invalidation: '',
              sentimentScore: 3,
              newsScore: 3,
            }),
          );
          continue;
        }
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
          evaluateSignal(this.env.AI, this.env.AI_MODEL, dossier, lessons, {
            db, kind: 'evaluate', sigKey: sig.sigKey, rates,
          }),
        );
      } catch {
        verdict = {
          action: 'skip',
          confidence: 0,
          thesis: 'IA no disponible tras varios reintentos; se descarta por prudencia.',
          risks: 'Evaluación IA no completada.',
          invalidation: '',
          sentimentScore: 3,
          newsScore: 3,
        };
      }

      /* ---------- FASE 4 · Scoring adaptativo ---------- */

      const overall = await step.do(`scoring ${sig.sigKey}`, RETRY, async () =>
        persistEvaluation(
          db, this.env.AI_MODEL, sig.sigKey, dossier, verdict,
          calibrationFor(verdict.confidence, knowledge.calibration),
          null,
          { weights, healthMultiplier: health?.confidenceMultiplier ?? 1 },
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
            { db, kind: 'embed', sigKey: sig.sigKey, rates },
          );
          return summarizeSimilarCases(
            await this.querySimilar(vector, sig.interval, dossier.marketRegime),
          );
        } catch {
          return null;
        }
      });

      const prior = { createdAt: sig.evalCreatedAt, revision: sig.revision };

      // el gate por salud también se re-aplica: el patrón puede haberse
      // desactivado desde la evaluación original
      const health = healthMap.get(`${sig.symbol}|${sig.interval}|${sig.pattern}`);
      if (health?.status === 'disabled') {
        await step.do(`re-gate ${sig.sigKey}`, RETRY, async () =>
          persistEvaluation(db, 'gate:salud', sig.sigKey, dossier, {
            action: 'skip',
            confidence: 0,
            thesis: `Retirada en re-evaluación: "${sig.pattern}" está desactivado por salud (expectancia ${health.expectancy.toFixed(2)}R en ${health.totalTrades} cierres; reciente ${health.recentExpectancy.toFixed(2)}R en ${health.recentTrades}).`,
            risks: 'Patrón desactivado por rendimiento real en este mercado.',
            invalidation: '',
            sentimentScore: 3,
            newsScore: 3,
          }, null, prior),
        );
        reevaluated++;
        continue;
      }
      if (!health) {
        const hist = dossier.recentOutcomes.find((o) => o.pattern === sig.pattern);
        const expectancy =
          hist && hist.total >= 15
            ? expectancyOf(hist.tpRate, hist.avgRr || sig.rr)
            : null;
        if (expectancy !== null && expectancy <= 0) {
          await step.do(`re-gate ${sig.sigKey}`, RETRY, async () =>
            persistEvaluation(db, 'gate:historial', sig.sigKey, dossier, {
              action: 'skip',
              confidence: 0,
              thesis: `Retirada en re-evaluación: "${sig.pattern}" acumula expectancia ${expectancy.toFixed(2)}R en ${hist!.total} cierres de ${sig.symbol} ${sig.interval}.`,
              risks: 'Patrón con historial perdedor en este mercado.',
              invalidation: '',
              sentimentScore: 3,
              newsScore: 3,
            }, null, prior),
          );
          reevaluated++;
          continue;
        }
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
          evaluateSignal(this.env.AI, this.env.AI_MODEL, dossier, lessons, {
            db, kind: 'reevaluate', sigKey: sig.sigKey, rates,
          }),
        );
      } catch {
        continue;
      }

      const overall = await step.do(`re-scoring ${sig.sigKey}`, RETRY, async () =>
        persistEvaluation(
          db, this.env.AI_MODEL, sig.sigKey, dossier, verdict,
          calibrationFor(verdict.confidence, knowledge.calibration), prior,
          { weights, healthMultiplier: health?.confidenceMultiplier ?? 1 },
        ),
      );

      reevaluated++;
      topScore = Math.max(topScore, overall);
    }

    /* ---------- FASE 4b · Paper trading ----------
       Primero se liquidan las posiciones cuyas señales cerraron (libera
       slots y actualiza el balance) y después se abren posiciones para
       las señales recién validadas por la IA. Todo queda auditado en
       paper_orders aunque se rechace. */

    const paper = await step.do('paper trading', RETRY, async () => {
      const account = await ensureAccount(db, {
        initialBalance: Number(this.env.PAPER_INITIAL_BALANCE) || 10_000,
        riskPct: Number(this.env.PAPER_RISK_PCT) || 1,
        minScore: Number(this.env.PAPER_MIN_SCORE) || 65,
      });
      const closed = await resolvePaperPositions(db, account);
      const { opened, rejected } = await openPaperPositions(db, account);
      return { closed, opened, rejected };
    });

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
          // metadata enriquecida (Mejora 4): régimen, tendencia, volatilidad
          // y score IA permiten filtrar la búsqueda de similares por
          // condiciones de mercado, no solo por cercanía del embedding
          const meta: Record<string, string | number> = {
            outcome: s.outcome,
            pattern: s.pattern,
            symbol: s.symbol,
            interval: s.interval,
            direction: s.direction,
            rr: s.rr,
            trend: f.emaSlope,
            volatility: f.atrBucket,
          };
          if (s.regime && s.regime !== ('UNKNOWN' as string)) {
            meta.regime = s.regime;
            meta.marketCondition = `${s.regime}|${f.atrBucket}`;
          }
          if (s.aiAction) {
            meta.aiAction = s.aiAction;
            meta.aiConfidence = s.aiConfidence ?? 0;
          }
          if (s.aiScore !== null && s.aiScore !== undefined) {
            meta.aiScore = s.aiScore;
          }
          cases.push({ sigKey: s.sigKey, text: caseText(f), meta });
        }
        if (cases.length > 0) {
          const embeddings = await embedTexts(
            this.env.AI, cases.map((c) => c.text),
            { db, kind: 'embed', sigKey: null, rates },
          );
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

    // 5b. evaluación continua (Mejora 7): clasificación determinista de
    // cada cierre con evaluación — ¿acertó la IA? ¿funcionó el patrón?
    // ¿el régimen acompañaba? — persistida en trade_reviews (cero IA)
    const tradeReviews = await step.do('revisa trades cerrados', RETRY, async () => {
      const pendingReviews = await getUnreviewedClosed(db, 120);
      if (pendingReviews.length === 0) return 0;
      const rows = pendingReviews.map((p) => {
        let ctxFields: Parameters<typeof classifyTradeReview>[0]['context'] = null;
        if (p.contextJson) {
          try {
            const c = JSON.parse(p.contextJson) as SignalContext;
            ctxFields = {
              trendHigherTf: c.trendHigherTf,
              rsi14: c.rsi14,
              atrPct: c.atrPct,
              marketWarnings: c.marketWarnings ?? null,
              session: c.session,
            };
          } catch { ctxFields = null; }
        }
        return classifyTradeReview({
          sigKey: p.sigKey,
          symbol: p.symbol,
          interval: p.interval,
          pattern: p.pattern,
          direction: p.direction,
          rr: p.rr,
          outcome: p.outcome as Exclude<Outcome, 'open'>,
          regime: p.regime && p.regime !== ('UNKNOWN' as string) ? p.regime : null,
          aiAction: p.aiAction,
          aiConfidence: p.aiConfidence,
          overallScore: p.overallScore,
          isGate: (p.model ?? '').startsWith('gate:'),
          context: ctxFields,
        });
      });
      await insertTradeReviews(db, rows);
      return rows.length;
    });

    // 5c. reflexión: destilar lecciones de los errores IA cerrados desde la
    // última reflexión, ahora con régimen y taxonomía de trade_reviews;
    // un fallo aquí nunca tumba el pipeline
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
            // sin outcomeTs: es el cursor interno, no material de reflexión
            mistakes.map(({ symbol, interval, pattern, direction, rr, aiAction, aiConfidence, aiThesis, outcome, regime, mistakeType, cause }) =>
              ({ symbol, interval, pattern, direction, rr, aiAction, aiConfidence, aiThesis, outcome, regime, mistakeType, cause })),
            { db, kind: 'reflect', sigKey: null, rates },
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

    // 5d. evolución de pesos (Mejora 2): cuando se acumulan cierres nuevos
    // suficientes, las dimensiones que separan ganadores de perdedores
    // ganan peso de forma acotada y determinista (sin ML, cero IA)
    let weightsUpdated = false;
    try {
      const closedCount = await step.do('cursor de pesos', RETRY, async () =>
        countClosedEvaluated(db),
      );
      const lastCount = await step.do('lee cursor de pesos', async () =>
        Number((await this.env.CACHE.get('scoring:weights_cursor')) ?? '0'),
      );
      if (closedCount >= 40 && closedCount - lastCount >= 25) {
        weightsUpdated = await step.do('evolución de pesos', RETRY, async () => {
          const rows = await getClosedBreakdowns(db, 400);
          const parsed = rows.flatMap((r) => {
            try {
              return [{ breakdown: JSON.parse(r.scoresJson), outcome: r.outcome }];
            } catch { return []; }
          });
          if (parsed.length < 40) return false;
          const current = (await getScoringWeights(db))?.weights ?? DEFAULT_WEIGHTS;
          const next = evolveWeights(current, computeDimensionPerformance(parsed));
          await saveScoringWeights(db, next, parsed.length);
          await this.env.CACHE.put('scoring:weights_cursor', String(closedCount));
          return true;
        });
      }
    } catch {
      weightsUpdated = false;
    }

    /* ---------- Retención y resumen ---------- */

    // retención: los registros de llamadas IA de más de 30 días se podan
    // (el agregado histórico vive en la calibración, no en el log crudo)
    await step.do('retención ai_calls', RETRY, async () => {
      await pruneAiCalls(db, Date.now() - 30 * 86_400_000);
    });

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
          paperOpened: paper.opened,
          paperClosed: paper.closed,
          healthPatterns,
          tradeReviews,
          regimeBackfilled,
          weightsUpdated: weightsUpdated ? 1 : 0,
        }),
      );
    });

    return {
      ingested, newSignals, evaluated, reevaluated, topScore, indexedCases, newLessons,
      paperOpened: paper.opened, paperClosed: paper.closed, paperRejected: paper.rejected,
      healthPatterns, tradeReviews, regimeBackfilled,
      weightsUpdated: weightsUpdated ? 1 : 0,
    };
  }

  /** Búsqueda de casos similares: primero filtrada por marco temporal y
      régimen (requiere metadata indexes en Vectorize); si los índices no
      existen o los vecinos son pocos, cae a la búsqueda global clásica. */
  private async querySimilar(
    vector: number[],
    interval: string,
    regime: string | null | undefined,
  ): Promise<{ score: number; metadata?: Record<string, unknown> | null }[]> {
    if (regime) {
      try {
        const res = await this.env.VECTOR_INDEX.query(vector, {
          topK: 8,
          returnMetadata: 'all',
          filter: { interval, regime },
        });
        if (res.matches.length >= 3) return res.matches;
      } catch {
        // sin metadata indexes creados aún → búsqueda global
      }
    }
    const res = await this.env.VECTOR_INDEX.query(vector, {
      topK: 8,
      returnMetadata: 'all',
    });
    return res.matches;
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
  /** Scoring adaptativo: pesos vigentes y multiplicador de salud del patrón. */
  score: { weights?: ScoringWeights; healthMultiplier?: number } = {},
): Promise<number> {
  const { breakdown, overall } = scoreSignal(dossier, verdict, calib, score);
  const now = Date.now();
  const revision = prior ? prior.revision + 1 : 1;
  // los descartes automáticos del gate no pasan por el prompt
  const promptVersion = model.startsWith('gate:') ? null : PROMPT_VERSION;

  await db.batch([
    db
      .prepare(
        `INSERT OR REPLACE INTO evaluations
         (sig_key, context_json, ai_action, ai_confidence, ai_thesis, ai_risks,
          scores_json, overall_score, model, created_at, revision, updated_at,
          prompt_version, ai_invalidation, strategy_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        revision,
        now,
        promptVersion,
        verdict.invalidation || null,
        STRATEGY_VERSION,
      ),
    // historial append-only (P1-1): cada veredicto queda auditable aunque
    // evaluations solo conserve la revisión vigente
    db
      .prepare(
        `INSERT INTO evaluation_history
         (sig_key, revision, ai_action, ai_confidence, ai_thesis, ai_risks,
          overall_score, model, prompt_version, created_at, ai_invalidation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        sigKey, revision, verdict.action, verdict.confidence,
        verdict.thesis, verdict.risks, overall, model, promptVersion, now,
        verdict.invalidation || null,
      ),
  ]);
  return overall;
}
