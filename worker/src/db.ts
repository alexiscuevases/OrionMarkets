import type { Candle, DetectedSignal, Outcome, SignalRow } from './types';

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
         (sig_key, symbol, interval, ts, pattern, direction, entry, stop, target, rr, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        s.sigKey, s.symbol, s.interval, s.ts, s.pattern, s.direction,
        s.entry, s.stop, s.target, s.rr, s.confidence, now,
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

/** Rendimiento histórico por patrón (dossier IA, gate y scoring).
    avgRr permite calcular expectancia: tpRate·avgRr − (1 − tpRate). */
export async function getPatternStats(
  db: D1Database,
  symbol: string,
  interval: string,
): Promise<{ pattern: string; total: number; tpRate: number; avgRr: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT pattern,
              COUNT(*) AS total,
              ROUND(AVG(CASE WHEN outcome = 'tp_hit' THEN 1.0 ELSE 0 END), 2) AS tpRate,
              ROUND(AVG(rr), 2) AS avgRr
       FROM signals
       WHERE symbol = ? AND interval = ? AND outcome IN ('tp_hit', 'sl_hit')
       GROUP BY pattern`,
    )
    .bind(symbol, interval)
    .all<{ pattern: string; total: number; tpRate: number; avgRr: number }>();
  return results;
}
