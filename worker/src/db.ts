import { DETECTOR_VERSION, STRATEGY_VERSION } from './versions';
import type { CalibrationBucket, Candle, DetectedSignal, Lesson, Outcome, SignalRow } from './types';
import type { MistakeCase } from './learn';
import type { PatternHealth } from './health';
import type { ScoringWeights } from './scoring';
import type { TradeReview } from './review';

/* Acceso a D1. Los inserts van en lotes: D1 limita los parámetros
   por sentencia, así que agrupamos 12 filas (96 binds) por INSERT. */

const ROWS_PER_INSERT = 12;
const STMTS_PER_BATCH = 40;

export async function upsertCandles(
  db: D1Database,
  symbol: string,
  interval: string,
  candles: Candle[],
): Promise<number> {
  if (candles.length === 0) return 0;

  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < candles.length; i += ROWS_PER_INSERT) {
    const chunk = candles.slice(i, i + ROWS_PER_INSERT);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const binds = chunk.flatMap((c) => [
      symbol, interval, c.ts, c.open, c.high, c.low, c.close, c.volume,
    ]);
    stmts.push(
      db.prepare(
        `INSERT INTO candles (symbol, interval, ts, open, high, low, close, volume)
         VALUES ${placeholders}
         ON CONFLICT (symbol, interval, ts) DO UPDATE SET
           open = excluded.open, high = excluded.high,
           low = excluded.low, close = excluded.close, volume = excluded.volume`,
      ).bind(...binds),
    );
  }

  for (let i = 0; i < stmts.length; i += STMTS_PER_BATCH) {
    await db.batch(stmts.slice(i, i + STMTS_PER_BATCH));
  }
  return candles.length;
}

export async function getCursor(
  db: D1Database,
  symbol: string,
  interval: string,
): Promise<number> {
  const row = await db
    .prepare('SELECT last_ts FROM sync_state WHERE symbol = ? AND interval = ?')
    .bind(symbol, interval)
    .first<{ last_ts: number }>();
  return row?.last_ts ?? 0;
}

export async function setCursor(
  db: D1Database,
  symbol: string,
  interval: string,
  lastTs: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_state (symbol, interval, last_ts, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (symbol, interval) DO UPDATE SET
         last_ts = excluded.last_ts, updated_at = excluded.updated_at`,
    )
    .bind(symbol, interval, lastTs, Date.now())
    .run();
}

export async function loadCandles(
  db: D1Database,
  symbol: string,
  interval: string,
  limit = 12000,
): Promise<Candle[]> {
  const { results } = await db
    .prepare(
      `SELECT ts, open, high, low, close, volume
       FROM candles WHERE symbol = ? AND interval = ?
       ORDER BY ts DESC LIMIT ?`,
    )
    .bind(symbol, interval, limit)
    .all<Candle>();
  return results.reverse(); // ascendente para los detectores
}

export async function insertSignals(
  db: D1Database,
  signals: DetectedSignal[],
): Promise<number> {
  if (signals.length === 0) return 0;
  const now = Date.now();

  const stmts = signals.map((s) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO signals
         (sig_key, symbol, interval, ts, pattern, direction, entry, stop, target, rr, confidence, created_at, detector_version, regime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        s.sigKey, s.symbol, s.interval, s.ts, s.pattern, s.direction,
        s.entry, s.stop, s.target, s.rr, s.confidence, now, DETECTOR_VERSION,
        s.regime ?? null,
      ),
  );

  let inserted = 0;
  for (let i = 0; i < stmts.length; i += STMTS_PER_BATCH) {
    const res = await db.batch(stmts.slice(i, i + STMTS_PER_BATCH));
    inserted += res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  }
  return inserted;
}

/** Resoluciones TP/SL/expiración en lote: una llamada D1 por cada 40 filas.
    (Un UPDATE individual por señal agotaba el límite de subrequests del
    Worker en intervalos con miles de señales abiertas.) */
export async function updateOutcomes(
  db: D1Database,
  updates: { sigKey: string; outcome: Outcome; outcomeTs: number | null }[],
): Promise<void> {
  if (updates.length === 0) return;
  const stmts = updates.map((u) =>
    db
      .prepare('UPDATE signals SET outcome = ?, outcome_ts = ? WHERE sig_key = ?')
      .bind(u.outcome, u.outcomeTs, u.sigKey),
  );
  for (let i = 0; i < stmts.length; i += STMTS_PER_BATCH) {
    await db.batch(stmts.slice(i, i + STMTS_PER_BATCH));
  }
}

export async function getOpenSignals(
  db: D1Database,
  symbol: string,
  interval: string,
): Promise<SignalRow[]> {
  const { results } = await db
    .prepare(
      `SELECT sig_key AS sigKey, symbol, interval, ts, pattern, direction,
              entry, stop, target, rr, confidence, outcome, outcome_ts AS outcomeTs
       FROM signals WHERE symbol = ? AND interval = ? AND outcome = 'open'`,
    )
    .bind(symbol, interval)
    .all<SignalRow>();
  return results;
}

/** Señales fiables pendientes de evaluación IA, mejores primero.
    Solo señales aún abiertas: evaluar una operación ya cerrada o expirada
    gasta cuota de IA sin producir nada accionable. */
export async function getUnevaluatedSignals(
  db: D1Database,
  minConfidence: number,
  limit: number,
): Promise<SignalRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.sig_key AS sigKey, s.symbol, s.interval, s.ts, s.pattern, s.direction,
              s.entry, s.stop, s.target, s.rr, s.confidence, s.outcome, s.outcome_ts AS outcomeTs
       FROM signals s
       LEFT JOIN evaluations e ON e.sig_key = s.sig_key
       WHERE e.sig_key IS NULL AND s.confidence >= ? AND s.outcome = 'open'
       ORDER BY s.ts DESC
       LIMIT ?`,
    )
    .bind(minConfidence, limit)
    .all<SignalRow>();
  return results;
}

/** Señal abierta candidata a re-evaluación, con el estado de su evaluación. */
export interface ReevaluableSignal extends SignalRow {
  evalTs: number;       // última evaluación (updated_at, o created_at si nunca se re-evaluó)
  evalCreatedAt: number;
  revision: number;
  aiAction: string;
  aiConfidence: number;
  aiThesis: string;
}

/** Señales abiertas ya evaluadas por la IA, las de evaluación más antigua
    primero. Excluye los descartes automáticos del gate (son decisiones por
    datos duros, no juicios de la IA que caduquen con el mercado). */
export async function getReevaluableSignals(
  db: D1Database,
  limit: number,
): Promise<ReevaluableSignal[]> {
  const { results } = await db
    .prepare(
      `SELECT s.sig_key AS sigKey, s.symbol, s.interval, s.ts, s.pattern, s.direction,
              s.entry, s.stop, s.target, s.rr, s.confidence, s.outcome, s.outcome_ts AS outcomeTs,
              COALESCE(e.updated_at, e.created_at) AS evalTs,
              e.created_at AS evalCreatedAt, e.revision,
              e.ai_action AS aiAction, e.ai_confidence AS aiConfidence, e.ai_thesis AS aiThesis
       FROM signals s
       JOIN evaluations e ON e.sig_key = s.sig_key
       WHERE s.outcome = 'open' AND e.model NOT LIKE 'gate:%'
       ORDER BY evalTs ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<ReevaluableSignal>();
  return results;
}

/** Rendimiento histórico por patrón (dossier IA, gate y scoring).
    avgRr permite calcular expectancia: tpRate·avgRr − (1 − tpRate).
    Con `sinceTs` restringe a cierres recientes (ventana walk-forward). */
export async function getPatternStats(
  db: D1Database,
  symbol: string,
  interval: string,
  sinceTs = 0,
): Promise<{ pattern: string; total: number; tpRate: number; avgRr: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT pattern,
              COUNT(*) AS total,
              ROUND(AVG(CASE WHEN outcome = 'tp_hit' THEN 1.0 ELSE 0 END), 2) AS tpRate,
              ROUND(AVG(rr), 2) AS avgRr
       FROM signals
       WHERE symbol = ? AND interval = ? AND outcome IN ('tp_hit', 'sl_hit')
         AND outcome_ts >= ?
       GROUP BY pattern`,
    )
    .bind(symbol, interval, sinceTs)
    .all<{ pattern: string; total: number; tpRate: number; avgRr: number }>();
  return results;
}

/** Rendimiento del patrón condicionado al régimen de mercado (Mejora 1/2):
    jurisprudencia para la dimensión regime del scoring y el dossier. */
export async function getPatternRegimeStats(
  db: D1Database,
  symbol: string,
  interval: string,
  pattern: string,
  regime: string,
): Promise<{ total: number; tpRate: number; avgRr: number } | null> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              ROUND(AVG(CASE WHEN outcome = 'tp_hit' THEN 1.0 ELSE 0 END), 2) AS tpRate,
              ROUND(AVG(rr), 2) AS avgRr
       FROM signals
       WHERE symbol = ? AND interval = ? AND pattern = ? AND regime = ?
         AND outcome IN ('tp_hit', 'sl_hit')`,
    )
    .bind(symbol, interval, pattern, regime)
    .first<{ total: number; tpRate: number | null; avgRr: number | null }>();
  if (!row || row.total === 0) return null;
  return { total: row.total, tpRate: row.tpRate ?? 0, avgRr: row.avgRr ?? 0 };
}

/* ---------- régimen de mercado: backfill incremental ---------- */

/** Señales de un mercado sin régimen anotado (filas previas a la 0007). */
export async function getSignalsMissingRegime(
  db: D1Database,
  symbol: string,
  interval: string,
  limit: number,
): Promise<{ sigKey: string; ts: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT sig_key AS sigKey, ts FROM signals
       WHERE symbol = ? AND interval = ? AND regime IS NULL
       ORDER BY ts DESC LIMIT ?`,
    )
    .bind(symbol, interval, limit)
    .all<{ sigKey: string; ts: number }>();
  return results;
}

export async function updateSignalRegimes(
  db: D1Database,
  updates: { sigKey: string; regime: string }[],
): Promise<void> {
  if (updates.length === 0) return;
  const stmts = updates.map((u) =>
    db.prepare('UPDATE signals SET regime = ? WHERE sig_key = ?').bind(u.regime, u.sigKey),
  );
  for (let i = 0; i < stmts.length; i += STMTS_PER_BATCH) {
    await db.batch(stmts.slice(i, i + STMTS_PER_BATCH));
  }
}

/* ---------- salud de patrones (Mejoras 3 y 5) ---------- */

export interface PatternHealthRow extends PatternHealth {
  updatedAt: number;
}

export async function upsertPatternHealth(
  db: D1Database,
  rows: PatternHealth[],
): Promise<void> {
  if (rows.length === 0) return;
  const now = Date.now();
  const stmts = rows.map((h) =>
    db
      .prepare(
        `INSERT INTO pattern_health
         (symbol, interval, pattern, detector_version, total_trades, win_rate,
          avg_rr, expectancy, recent_trades, recent_win_rate, recent_expectancy,
          degradation_score, health, status, confidence_multiplier, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (symbol, interval, pattern) DO UPDATE SET
           detector_version = excluded.detector_version,
           total_trades = excluded.total_trades,
           win_rate = excluded.win_rate,
           avg_rr = excluded.avg_rr,
           expectancy = excluded.expectancy,
           recent_trades = excluded.recent_trades,
           recent_win_rate = excluded.recent_win_rate,
           recent_expectancy = excluded.recent_expectancy,
           degradation_score = excluded.degradation_score,
           health = excluded.health,
           status = excluded.status,
           confidence_multiplier = excluded.confidence_multiplier,
           updated_at = excluded.updated_at`,
      )
      .bind(
        h.symbol, h.interval, h.pattern, DETECTOR_VERSION, h.totalTrades,
        h.winRate, h.avgRR, h.expectancy, h.recentTrades, h.recentWinRate,
        h.recentExpectancy, h.degradationScore, h.health, h.status,
        h.confidenceMultiplier, now,
      ),
  );
  for (let i = 0; i < stmts.length; i += STMTS_PER_BATCH) {
    await db.batch(stmts.slice(i, i + STMTS_PER_BATCH));
  }
}

/** Toda la tabla de salud como mapa 'symbol|interval|pattern' → fila. */
export async function getPatternHealthMap(
  db: D1Database,
): Promise<Map<string, PatternHealthRow>> {
  const { results } = await db
    .prepare(
      `SELECT symbol, interval, pattern,
              total_trades AS totalTrades, win_rate AS winRate, avg_rr AS avgRR,
              expectancy, recent_trades AS recentTrades,
              recent_win_rate AS recentWinRate, recent_expectancy AS recentExpectancy,
              degradation_score AS degradationScore, health, status,
              confidence_multiplier AS confidenceMultiplier, updated_at AS updatedAt
       FROM pattern_health`,
    )
    .all<PatternHealthRow>();
  const map = new Map<string, PatternHealthRow>();
  for (const r of results) map.set(`${r.symbol}|${r.interval}|${r.pattern}`, r);
  return map;
}

/* ---------- pesos de scoring evolutivos (Mejora 2) ---------- */

export async function getScoringWeights(
  db: D1Database,
): Promise<{ weights: ScoringWeights; samples: number; updatedAt: number } | null> {
  const row = await db
    .prepare('SELECT weights_json, samples, updated_at FROM scoring_weights WHERE id = 1')
    .first<{ weights_json: string; samples: number; updated_at: number }>();
  if (!row) return null;
  try {
    return {
      weights: JSON.parse(row.weights_json) as ScoringWeights,
      samples: row.samples,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

export async function saveScoringWeights(
  db: D1Database,
  weights: ScoringWeights,
  samples: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO scoring_weights (id, weights_json, samples, strategy_version, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         weights_json = excluded.weights_json,
         samples = excluded.samples,
         strategy_version = excluded.strategy_version,
         updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(weights), samples, STRATEGY_VERSION, Date.now())
    .run();
}

/** Desgloses de scoring de cierres reales (buy/sell, sin gates) para la
    evolución de pesos. Los más recientes primero. */
export async function getClosedBreakdowns(
  db: D1Database,
  limit: number,
): Promise<{ scoresJson: string; outcome: 'tp_hit' | 'sl_hit' }[]> {
  const { results } = await db
    .prepare(
      `SELECT e.scores_json AS scoresJson, s.outcome
       FROM evaluations e
       JOIN signals s ON s.sig_key = e.sig_key
       WHERE e.ai_action IN ('buy', 'sell')
         AND e.model NOT LIKE 'gate:%'
         AND s.outcome IN ('tp_hit', 'sl_hit')
       ORDER BY s.outcome_ts DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ scoresJson: string; outcome: 'tp_hit' | 'sl_hit' }>();
  return results;
}

/** Nº de cierres evaluados (cursor de la evolución de pesos). */
export async function countClosedEvaluated(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM evaluations e
       JOIN signals s ON s.sig_key = e.sig_key
       WHERE e.ai_action IN ('buy', 'sell')
         AND e.model NOT LIKE 'gate:%'
         AND s.outcome IN ('tp_hit', 'sl_hit')`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/* ---------- evaluación continua (Mejora 7) ---------- */

/** Cierres con evaluación aún sin revisión determinista (trade_reviews). */
export interface UnreviewedClosed extends SignalRow {
  aiAction: string | null;
  aiConfidence: number | null;
  overallScore: number | null;
  model: string | null;
  contextJson: string | null;
}

export async function getUnreviewedClosed(
  db: D1Database,
  limit: number,
): Promise<UnreviewedClosed[]> {
  const { results } = await db
    .prepare(
      `SELECT s.sig_key AS sigKey, s.symbol, s.interval, s.ts, s.pattern, s.direction,
              s.entry, s.stop, s.target, s.rr, s.confidence, s.outcome,
              s.outcome_ts AS outcomeTs, s.regime,
              e.ai_action AS aiAction, e.ai_confidence AS aiConfidence,
              e.overall_score AS overallScore, e.model, e.context_json AS contextJson
       FROM signals s
       JOIN evaluations e ON e.sig_key = s.sig_key
       LEFT JOIN trade_reviews tr ON tr.sig_key = s.sig_key
       WHERE s.outcome IN ('tp_hit', 'sl_hit', 'expired')
         AND tr.sig_key IS NULL
       ORDER BY s.outcome_ts ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<UnreviewedClosed>();
  return results;
}

export async function insertTradeReviews(
  db: D1Database,
  reviews: TradeReview[],
): Promise<void> {
  if (reviews.length === 0) return;
  const now = Date.now();
  const stmts = reviews.map((r) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO trade_reviews
         (sig_key, symbol, interval, pattern, regime, outcome, ai_action,
          ai_confidence, overall_score, mistake_type, cause, ai_correct,
          pattern_worked, regime_aligned, confidence_calibrated,
          affected_patterns, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        r.sigKey, r.symbol, r.interval, r.pattern, r.regime, r.outcome,
        r.aiAction, r.aiConfidence, r.overallScore, r.mistakeType, r.cause,
        r.aiCorrect === null ? null : r.aiCorrect ? 1 : 0,
        r.patternWorked ? 1 : 0,
        r.regimeAligned === null ? null : r.regimeAligned ? 1 : 0,
        r.confidenceCalibrated === null ? null : r.confidenceCalibrated ? 1 : 0,
        JSON.stringify(r.affectedPatterns), now,
      ),
  );
  for (let i = 0; i < stmts.length; i += STMTS_PER_BATCH) {
    await db.batch(stmts.slice(i, i + STMTS_PER_BATCH));
  }
}

/* ---------- aprendizaje continuo ---------- */

/** Calibración empírica de la confianza IA: acierto real por tramo de
    confianza declarada, solo veredictos buy/sell ya cerrados y excluyendo
    los descartes automáticos del gate. */
export async function getAiCalibration(db: D1Database): Promise<CalibrationBucket[]> {
  const { results } = await db
    .prepare(
      `SELECT CASE
                WHEN e.ai_confidence < 50 THEN 'lt50'
                WHEN e.ai_confidence < 65 THEN '50-64'
                WHEN e.ai_confidence < 80 THEN '65-79'
                ELSE '80plus'
              END AS bucket,
              COUNT(*) AS n,
              ROUND(AVG(CASE WHEN s.outcome = 'tp_hit' THEN 1.0 ELSE 0 END), 3) AS tpRate,
              ROUND(AVG(s.rr), 2) AS avgRr
       FROM evaluations e
       JOIN signals s ON s.sig_key = e.sig_key
       WHERE e.ai_action IN ('buy', 'sell')
         AND e.model NOT LIKE 'gate:%'
         AND s.outcome IN ('tp_hit', 'sl_hit')
       GROUP BY bucket`,
    )
    .all<{ bucket: string; n: number; tpRate: number; avgRr: number }>();
  return results.map((r) => ({
    ...r,
    expectancy: Math.round((r.tpRate * r.avgRr - (1 - r.tpRate)) * 100) / 100,
  }));
}

/** Lecciones vigentes, más recientes primero. */
export async function getLessons(db: D1Database, limit = 24): Promise<Lesson[]> {
  const { results } = await db
    .prepare(
      `SELECT id, scope, lesson, support, created_at AS createdAt
       FROM lessons ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<Lesson>();
  return results;
}

/** Inserta lecciones nuevas y poda: se conservan las 15 más recientes. */
export async function addLessons(
  db: D1Database,
  lessons: {
    scope: string; lesson: string; support: number;
    mistakeType?: string | null; cause?: string | null; affectedPatterns?: string[];
  }[],
): Promise<void> {
  if (lessons.length === 0) return;
  const now = Date.now();
  const stmts = lessons.map((l) =>
    db
      .prepare(
        `INSERT INTO lessons (scope, lesson, support, created_at, mistake_type, cause, affected_patterns)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        l.scope, l.lesson, l.support, now,
        l.mistakeType ?? null, l.cause ?? null,
        l.affectedPatterns && l.affectedPatterns.length > 0
          ? JSON.stringify(l.affectedPatterns) : null,
      ),
  );
  stmts.push(
    db.prepare(
      `DELETE FROM lessons WHERE id NOT IN
         (SELECT id FROM lessons ORDER BY created_at DESC, id DESC LIMIT 15)`,
    ),
  );
  await db.batch(stmts);
}

/** Errores de la IA cerrados después de `sinceTs`: validó y salió SL, o
    descartó (sin gate) y salió TP. Material de la reflexión. */
export async function getAiMistakes(
  db: D1Database,
  sinceTs: number,
  limit = 20,
): Promise<(MistakeCase & { outcomeTs: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT s.symbol, s.interval, s.pattern, s.direction, s.rr, s.regime,
              e.ai_action AS aiAction, e.ai_confidence AS aiConfidence,
              SUBSTR(e.ai_thesis, 1, 200) AS aiThesis,
              s.outcome, s.outcome_ts AS outcomeTs,
              tr.mistake_type AS mistakeType, tr.cause
       FROM evaluations e
       JOIN signals s ON s.sig_key = e.sig_key
       LEFT JOIN trade_reviews tr ON tr.sig_key = s.sig_key
       WHERE e.model NOT LIKE 'gate:%'
         AND s.outcome_ts > ?
         AND ((e.ai_action IN ('buy', 'sell') AND s.outcome = 'sl_hit')
           OR (e.ai_action = 'skip' AND s.outcome = 'tp_hit'))
       ORDER BY s.outcome_ts ASC
       LIMIT ?`,
    )
    .bind(sinceTs, limit)
    .all<MistakeCase & { outcomeTs: number }>();
  return results;
}

/** Señales cerradas pendientes de indexar en la memoria vectorial,
    con su evaluación IA si existe. Ordenadas para agrupar por mercado. */
export async function getUnindexedClosed(
  db: D1Database,
  limit: number,
): Promise<(SignalRow & {
  aiAction: string | null;
  aiConfidence: number | null;
  aiScore: number | null;
})[]> {
  const { results } = await db
    .prepare(
      `SELECT s.sig_key AS sigKey, s.symbol, s.interval, s.ts, s.pattern, s.direction,
              s.entry, s.stop, s.target, s.rr, s.confidence, s.outcome, s.outcome_ts AS outcomeTs,
              s.regime,
              e.ai_action AS aiAction, e.ai_confidence AS aiConfidence,
              e.overall_score AS aiScore
       FROM signals s
       LEFT JOIN evaluations e ON e.sig_key = s.sig_key
       WHERE s.outcome IN ('tp_hit', 'sl_hit') AND s.indexed_at IS NULL
       ORDER BY s.symbol, s.interval, s.ts
       LIMIT ?`,
    )
    .bind(limit)
    .all<SignalRow & { aiAction: string | null; aiConfidence: number | null; aiScore: number | null }>();
  return results;
}

export async function markIndexed(db: D1Database, sigKeys: string[]): Promise<void> {
  if (sigKeys.length === 0) return;
  const now = Date.now();
  const stmts = sigKeys.map((k) =>
    db.prepare('UPDATE signals SET indexed_at = ? WHERE sig_key = ?').bind(now, k),
  );
  for (let i = 0; i < stmts.length; i += STMTS_PER_BATCH) {
    await db.batch(stmts.slice(i, i + STMTS_PER_BATCH));
  }
}

/** Progreso de la memoria vectorial (para /api/learning). */
export async function getMemoryProgress(
  db: D1Database,
): Promise<{ indexed: number; totalClosed: number }> {
  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN indexed_at IS NOT NULL THEN 1 ELSE 0 END) AS indexed,
              COUNT(*) AS totalClosed
       FROM signals WHERE outcome IN ('tp_hit', 'sl_hit')`,
    )
    .first<{ indexed: number | null; totalClosed: number }>();
  return { indexed: row?.indexed ?? 0, totalClosed: row?.totalClosed ?? 0 };
}
