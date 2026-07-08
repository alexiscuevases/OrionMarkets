import { aiUsage } from './aiLog';
import { INTERVAL_MS, INTERVALS, SYMBOLS, type Env, type Interval } from './types';

/* Observabilidad (Fase 7): historial de runs del pipeline, frescura de
   datos por mercado, uso de IA y progreso de la memoria vectorial.

   pipeline_runs registra CADA ejecución (incluidas las fallidas y las
   saltadas por lock) — el KV pipeline:last_run se mantiene por
   compatibilidad con el frontend actual. */

export async function recordRunStart(
  db: D1Database,
  id: string,
  trigger: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO pipeline_runs (id, trigger, started_at, status)
       VALUES (?, ?, ?, 'running')`,
    )
    .bind(id, trigger, Date.now())
    .run();
}

export async function recordRunEnd(
  db: D1Database,
  id: string,
  status: 'success' | 'error',
  counters: Record<string, number> | null,
  error?: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE pipeline_runs SET finished_at = ?, status = ?, counters_json = ?, error = ?
       WHERE id = ?`,
    )
    .bind(
      Date.now(), status,
      counters ? JSON.stringify(counters) : null,
      error ? error.slice(0, 500) : null,
      id,
    )
    .run();
}

export async function recordRunSkipped(
  db: D1Database,
  id: string,
  trigger: string,
  reason: string,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT OR REPLACE INTO pipeline_runs (id, trigger, started_at, finished_at, status, error)
       VALUES (?, ?, ?, ?, 'skipped', ?)`,
    )
    .bind(id, trigger, now, now, reason)
    .run();
}

export interface RunSummary {
  id: string;
  trigger: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  status: string;
  error: string | null;
  counters: Record<string, number> | null;
}

export async function recentRuns(db: D1Database, limit = 10): Promise<RunSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT id, trigger, started_at AS startedAt, finished_at AS finishedAt,
              status, error, counters_json AS countersJson
       FROM pipeline_runs ORDER BY started_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{
      id: string; trigger: string; startedAt: number; finishedAt: number | null;
      status: string; error: string | null; countersJson: string | null;
    }>();
  return results.map((r) => ({
    id: r.id,
    trigger: r.trigger,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.finishedAt !== null ? r.finishedAt - r.startedAt : null,
    status: r.status,
    error: r.error,
    counters: r.countersJson ? (JSON.parse(r.countersJson) as Record<string, number>) : null,
  }));
}

export interface DataFreshness {
  symbol: string;
  interval: string;
  lastCandleTs: number | null;
  ageMs: number | null;
  /** true si la última vela es más vieja que 3 barras + margen de mercado cerrado. */
  stale: boolean;
}

/** Frescura por símbolo+intervalo. El mercado FX cierra el fin de semana:
    durante sábado/domingo (y los bordes del viernes noche y lunes de
    madrugada UTC) la tolerancia sube a 60 h para no dar falsas alarmas. */
const WEEKEND_GRACE_MS = 60 * 3_600_000;

function staleAllowanceMs(barMs: number, now: number): number {
  const d = new Date(now);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  const weekend =
    day === 6 || day === 0 || (day === 5 && hour >= 21) || (day === 1 && hour < 2);
  const normal = barMs * 3 + 30 * 60_000;
  return weekend ? Math.max(normal, WEEKEND_GRACE_MS) : normal;
}

export async function dataFreshness(db: D1Database): Promise<DataFreshness[]> {
  const { results } = await db
    .prepare(
      `SELECT symbol, interval, MAX(ts) AS lastTs
       FROM candles GROUP BY symbol, interval`,
    )
    .all<{ symbol: string; interval: string; lastTs: number }>();

  const byKey = new Map(results.map((r) => [`${r.symbol}|${r.interval}`, r.lastTs]));
  const now = Date.now();
  const out: DataFreshness[] = [];
  for (const symbol of SYMBOLS) {
    for (const interval of INTERVALS) {
      const lastTs = byKey.get(`${symbol}|${interval}`) ?? null;
      const ageMs = lastTs !== null ? now - lastTs : null;
      const bar = INTERVAL_MS[interval as Interval];
      out.push({
        symbol,
        interval,
        lastCandleTs: lastTs,
        ageMs,
        stale: ageMs === null || ageMs > staleAllowanceMs(bar, now),
      });
    }
  }
  return out;
}

/** Salud completa del sistema; cacheada en KV 60 s por el handler. */
export async function healthReport(env: Env) {
  const db = env.DB;
  const dayAgo = Date.now() - 86_400_000;

  const [runs, freshness, usage, lastRunKv, memory, openSignals] = await Promise.all([
    recentRuns(db, 10),
    dataFreshness(db),
    aiUsage(db, dayAgo),
    env.CACHE.get('pipeline:last_run', 'json'),
    db
      .prepare(
        `SELECT SUM(CASE WHEN indexed_at IS NOT NULL THEN 1 ELSE 0 END) AS indexed,
                COUNT(*) AS totalClosed
         FROM signals WHERE outcome IN ('tp_hit', 'sl_hit')`,
      )
      .first<{ indexed: number | null; totalClosed: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM signals WHERE outcome = 'open'`)
      .first<{ n: number }>(),
  ]);

  const lastSuccess = runs.find((r) => r.status === 'success') ?? null;
  const lastError = runs.find((r) => r.status === 'error') ?? null;
  const staleMarkets = freshness.filter((f) => f.stale);

  // semáforo global: error si no hay run exitoso en 2 h o hay mercados stale
  const now = Date.now();
  const pipelineOk = lastSuccess !== null && now - (lastSuccess.finishedAt ?? 0) < 2 * 3_600_000;
  const dataOk = staleMarkets.length === 0;
  const aiOk = usage.calls === 0 || usage.errors / usage.calls < 0.3;

  return {
    ok: pipelineOk && dataOk && aiOk,
    generatedAt: now,
    universe: { symbols: SYMBOLS, intervals: INTERVALS },
    lastRun: lastRunKv,
    pipeline: {
      ok: pipelineOk,
      lastSuccess,
      lastError,
      recentRuns: runs,
    },
    data: {
      ok: dataOk,
      staleMarkets,
      freshness,
      openSignals: openSignals?.n ?? 0,
    },
    ai: { ok: aiOk, last24h: usage },
    vector: {
      indexed: memory?.indexed ?? 0,
      totalClosed: memory?.totalClosed ?? 0,
    },
  };
}
