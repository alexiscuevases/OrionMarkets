/* Tracking de llamadas a Workers AI (Fase 6): latencia, tokens, coste
   estimado y errores, por tipo de llamada y señal. Base de la auditoría
   («¿por qué la IA aceptó/rechazó?») junto con evaluation_history.

   Los tokens son reales si el modelo reporta `usage`; si no, se estiman
   (≈ 4 caracteres/token). El coste usa tarifas configurables por env
   (USD por millón de tokens) para no fosilizar precios en el código. */

export type AiCallKind = 'evaluate' | 'reevaluate' | 'reflect' | 'embed';

export interface AiCallLog {
  kind: AiCallKind;
  model: string;
  promptVersion: string | null;
  sigKey: string | null;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  success: boolean;
  error: string | null;
}

export interface AiCostRates {
  inPerM: number;  // USD por millón de tokens de entrada
  outPerM: number; // USD por millón de tokens de salida
}

/** Tarifas desde env; por defecto las de llama-3.3-70b fp8 (ajustables
    con AI_COST_IN_PER_M / AI_COST_OUT_PER_M sin tocar código). */
export function costRates(env: { AI_COST_IN_PER_M?: string; AI_COST_OUT_PER_M?: string }): AiCostRates {
  return {
    inPerM: Number(env.AI_COST_IN_PER_M) || 0.29,
    outPerM: Number(env.AI_COST_OUT_PER_M) || 2.25,
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateCost(tokensIn: number, tokensOut: number, rates: AiCostRates): number {
  return (tokensIn * rates.inPerM + tokensOut * rates.outPerM) / 1_000_000;
}

/** Nunca lanza: el logging jamás debe tumbar una evaluación. */
export async function logAiCall(db: D1Database, log: AiCallLog): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO ai_calls
         (ts, kind, model, prompt_version, sig_key, latency_ms, tokens_in, tokens_out,
          est_cost_usd, success, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        Date.now(), log.kind, log.model, log.promptVersion, log.sigKey,
        log.latencyMs, log.tokensIn, log.tokensOut,
        Math.round(log.estCostUsd * 1e6) / 1e6,
        log.success ? 1 : 0, log.error ? log.error.slice(0, 300) : null,
      )
      .run();
  } catch {
    // sin logging antes que sin evaluación
  }
}

export interface AiUsageStats {
  calls: number;
  errors: number;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  avgLatencyMs: number | null;
  byKind: { kind: string; calls: number; errors: number; estCostUsd: number }[];
}

/** Agregado de uso IA desde `sinceTs` (para /api/health y admin). */
export async function aiUsage(db: D1Database, sinceTs: number): Promise<AiUsageStats> {
  const [totals, byKind] = await db.batch([
    db
      .prepare(
        `SELECT COUNT(*) AS calls,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(tokens_in), 0) AS tokensIn,
                COALESCE(SUM(tokens_out), 0) AS tokensOut,
                COALESCE(SUM(est_cost_usd), 0) AS estCostUsd,
                AVG(latency_ms) AS avgLatencyMs
         FROM ai_calls WHERE ts >= ?`,
      )
      .bind(sinceTs),
    db
      .prepare(
        `SELECT kind, COUNT(*) AS calls,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(est_cost_usd), 0) AS estCostUsd
         FROM ai_calls WHERE ts >= ? GROUP BY kind`,
      )
      .bind(sinceTs),
  ]);

  const t = totals.results[0] as {
    calls: number; errors: number | null; tokensIn: number; tokensOut: number;
    estCostUsd: number; avgLatencyMs: number | null;
  };
  return {
    calls: t.calls,
    errors: t.errors ?? 0,
    tokensIn: t.tokensIn,
    tokensOut: t.tokensOut,
    estCostUsd: Math.round(t.estCostUsd * 10000) / 10000,
    avgLatencyMs: t.avgLatencyMs !== null ? Math.round(t.avgLatencyMs) : null,
    byKind: (byKind.results as AiUsageStats['byKind']).map((k) => ({
      ...k,
      estCostUsd: Math.round(k.estCostUsd * 10000) / 10000,
    })),
  };
}

/** Retención: borra registros de llamadas anteriores a `beforeTs`. */
export async function pruneAiCalls(db: D1Database, beforeTs: number): Promise<void> {
  await db.prepare('DELETE FROM ai_calls WHERE ts < ?').bind(beforeTs).run();
}
