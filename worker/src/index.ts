import { getAiCalibration, getLessons, getMemoryProgress, loadCandles } from './db';
import { atr, ema, rsi, slopePct } from './indicators';
import { INTERVALS, SYMBOLS, type Env, type Interval } from './types';
export { OrionPipeline } from './workflow';

/* Punto de entrada del Worker:
   - scheduled: cron cada 15 min; cada disparo refresca solo los intervalos
     que le tocan (ver CRON_INTERVALS) para no agotar la cuota diaria
   - fetch: API JSON de solo lectura para el frontend + trigger manual */

/* Reparto por minuto del cron: los marcos rápidos se refrescan cada hora en
   el minuto 15 y el resto escalonado. Con 3 símbolos esto queda en ~360
   llamadas/día a Twelve Data (límite del plan: 800). */
const CRON_INTERVALS: Record<number, Interval[]> = {
  0: ['1h'],
  15: ['5min', '15min'],
  30: ['30min'],
  45: ['45min'],
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function validSymbol(s: string | null): s is (typeof SYMBOLS)[number] {
  return !!s && (SYMBOLS as readonly string[]).includes(s);
}

function validInterval(i: string | null): i is (typeof INTERVALS)[number] {
  return !!i && (INTERVALS as readonly string[]).includes(i);
}

export default {
  async scheduled(event, env) {
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    await env.PIPELINE.create({
      id: `cron-${event.scheduledTime}`,
      params: { trigger: 'cron', intervals: CRON_INTERVALS[minute] ?? [...INTERVALS] },
    });
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    /* --- salud + último resumen del pipeline --- */
    if (pathname === '/api/health') {
      const lastRun = await env.CACHE.get('pipeline:last_run', 'json');
      return json({ ok: true, universe: { symbols: SYMBOLS, intervals: INTERVALS }, lastRun });
    }

    /* --- velas para el gráfico --- */
    if (pathname === '/api/candles') {
      const symbol = searchParams.get('symbol');
      const interval = searchParams.get('interval');
      if (!validSymbol(symbol) || !validInterval(interval)) {
        return json({ error: 'symbol o interval inválidos' }, 400);
      }
      const limit = Math.min(Number(searchParams.get('limit')) || 500, 5000);
      const { results } = await env.DB
        .prepare(
          `SELECT ts, open, high, low, close, volume
           FROM candles WHERE symbol = ? AND interval = ?
           ORDER BY ts DESC LIMIT ?`,
        )
        .bind(symbol, interval, limit)
        .all();
      return json({ symbol, interval, candles: results.reverse() });
    }

    /* --- señales (históricas y actuales), con evaluación si existe --- */
    if (pathname === '/api/signals') {
      const symbol = searchParams.get('symbol');
      const interval = searchParams.get('interval');
      const limit = Math.min(Number(searchParams.get('limit')) || 100, 500);

      let query = `
        SELECT s.sig_key AS sigKey, s.symbol, s.interval, s.ts, s.pattern, s.direction,
               s.entry, s.stop, s.target, s.rr, s.confidence, s.outcome, s.outcome_ts AS outcomeTs,
               e.ai_action AS aiAction, e.ai_confidence AS aiConfidence,
               e.ai_thesis AS aiThesis, e.ai_risks AS aiRisks,
               e.scores_json AS scoresJson, e.context_json AS contextJson,
               e.overall_score AS overallScore,
               e.revision AS evalRevision, COALESCE(e.updated_at, e.created_at) AS evalUpdatedAt
        FROM signals s LEFT JOIN evaluations e ON e.sig_key = s.sig_key`;
      const binds: unknown[] = [];
      if (validSymbol(symbol) && validInterval(interval)) {
        query += ' WHERE s.symbol = ? AND s.interval = ?';
        binds.push(symbol, interval);
      }
      query += ' ORDER BY s.ts DESC LIMIT ?';
      binds.push(limit);

      const { results } = await env.DB.prepare(query).bind(...binds).all();
      return json({ signals: results });
    }

    /* --- rendimiento real por patrón para el panel de estrategias ---
       agregados de la ventana pedida + cierres ordenados para reconstruir
       la curva de resultados en múltiplos de R (TP = +rr, SL = -1) */
    if (pathname === '/api/strategies') {
      const days = Math.min(Math.max(Number(searchParams.get('days')) || 30, 1), 90);
      const since = Date.now() - days * 86_400_000;
      const [aggs, closed] = await env.DB.batch([
        env.DB.prepare(
          `SELECT pattern,
                  COUNT(*) AS total,
                  SUM(CASE WHEN outcome = 'open' THEN 1 ELSE 0 END) AS open,
                  SUM(CASE WHEN outcome = 'tp_hit' THEN 1 ELSE 0 END) AS tp,
                  SUM(CASE WHEN outcome = 'sl_hit' THEN 1 ELSE 0 END) AS sl,
                  SUM(CASE WHEN outcome = 'expired' THEN 1 ELSE 0 END) AS expired,
                  SUM(CASE WHEN outcome = 'tp_hit' THEN rr ELSE 0 END) AS grossR
           FROM signals WHERE ts >= ? GROUP BY pattern`,
        ).bind(since),
        env.DB.prepare(
          `SELECT pattern, outcome, rr, outcomeTs FROM (
             SELECT pattern, outcome, rr, outcome_ts AS outcomeTs
             FROM signals
             WHERE outcome IN ('tp_hit', 'sl_hit') AND outcome_ts >= ?
             ORDER BY outcome_ts DESC LIMIT 2000
           ) ORDER BY outcomeTs ASC`,
        ).bind(since),
      ]);
      return json({ days, patterns: aggs.results, closed: closed.results });
    }

    /* --- mejores oportunidades puntuadas --- */
    if (pathname === '/api/opportunities') {
      const limit = Math.min(Number(searchParams.get('limit')) || 20, 100);
      const { results } = await env.DB
        .prepare(
          `SELECT s.sig_key AS sigKey, s.symbol, s.interval, s.ts, s.pattern, s.direction,
                  s.entry, s.stop, s.target, s.rr, s.confidence, s.outcome,
                  e.ai_action AS aiAction, e.ai_confidence AS aiConfidence,
                  e.ai_thesis AS aiThesis, e.ai_risks AS aiRisks,
                  e.scores_json AS scoresJson, e.context_json AS contextJson,
                  e.overall_score AS overallScore,
                  e.revision AS evalRevision, COALESCE(e.updated_at, e.created_at) AS evalUpdatedAt
           FROM evaluations e JOIN signals s ON s.sig_key = e.sig_key
           WHERE e.ai_action != 'skip' AND s.outcome = 'open'
           ORDER BY e.overall_score DESC, s.ts DESC LIMIT ?`,
        )
        .bind(limit)
        .all();
      return json({ opportunities: results });
    }

    /* --- estado de mercado por símbolo (tendencia, volatilidad, RSI) ---
       calculado sobre la serie 1h y cacheado en KV; noticias queda null
       hasta conectar un proveedor (la UI muestra «Ninguna») */
    if (pathname === '/api/market-state') {
      const cached = await env.CACHE.get('market:state', 'json');
      if (cached) return json(cached);

      const states = [];
      for (const symbol of SYMBOLS) {
        const candles = await loadCandles(env.DB, symbol, '1h', 400);
        if (candles.length < 60) continue;
        const closes = candles.map((c) => c.close);
        const last = closes.length - 1;
        const price = closes[last];

        // misma lógica que el dossier de señales: pendiente de EMA50 en 1h
        const e50 = ema(closes, 50);
        const slope = slopePct(e50, last, 30);
        const trend = slope > 0.01 ? 'alcista' : slope < -0.01 ? 'bajista' : 'lateral';
        const mag = Math.abs(slope);
        const trendStrength =
          trend === 'lateral' ? null : mag >= 0.035 ? 'fuerte' : mag >= 0.018 ? 'moderada' : 'débil';

        const e200 = ema(closes, 200);
        const atrPct = Math.round(((atr(candles, 14)[last] ?? 0) / price) * 10000) / 100;
        const volatility =
          atrPct < 0.06 ? 'muy baja'
          : atrPct < 0.12 ? 'baja'
          : atrPct < 0.25 ? 'media'
          : atrPct < 0.4 ? 'alta' : 'muy alta';

        states.push({
          symbol,
          trend,
          trendStrength,
          volatility,
          atrPct,
          rsi14: Math.round(rsi(closes, 14)[last] ?? 50),
          aboveEma200: Number.isFinite(e200[last]) ? price > e200[last] : null,
          lastCandleTs: candles[candles.length - 1].ts,
          news: null,
        });
      }

      const payload = { states, generatedAt: Date.now() };
      await env.CACHE.put('market:state', JSON.stringify(payload), { expirationTtl: 300 });
      return json(payload);
    }

    /* --- estado del aprendizaje: lecciones, calibración y memoria --- */
    if (pathname === '/api/learning') {
      const [lessons, calibration, memory] = await Promise.all([
        getLessons(env.DB, 20),
        getAiCalibration(env.DB),
        getMemoryProgress(env.DB),
      ]);
      return json({ lessons, calibration, memory });
    }

    /* --- dataset etiquetado (contexto → veredicto IA → resultado real);
       base para un futuro fine-tuning LoRA cuando haya volumen --- */
    if (pathname === '/api/dataset') {
      const limit = Math.min(Number(searchParams.get('limit')) || 200, 1000);
      const { results } = await env.DB
        .prepare(
          `SELECT e.context_json AS contextJson, e.ai_action AS aiAction,
                  e.ai_confidence AS aiConfidence, e.ai_thesis AS aiThesis,
                  s.outcome, s.rr
           FROM evaluations e JOIN signals s ON s.sig_key = e.sig_key
           WHERE s.outcome IN ('tp_hit', 'sl_hit') AND e.model NOT LIKE 'gate:%'
           ORDER BY s.outcome_ts DESC LIMIT ?`,
        )
        .bind(limit)
        .all();
      return json({ examples: results });
    }

    /* --- disparo manual del pipeline + consulta de estado --- */
    if (pathname === '/api/run' && request.method === 'POST') {
      const instance = await env.PIPELINE.create({
        id: crypto.randomUUID(),
        params: { trigger: 'manual' },
      });
      return json({ id: instance.id, status: await instance.status() }, 202);
    }

    const runMatch = pathname.match(/^\/api\/run\/([a-zA-Z0-9-]+)$/);
    if (runMatch) {
      try {
        const instance = await env.PIPELINE.get(runMatch[1]);
        return json({ id: runMatch[1], status: await instance.status() });
      } catch {
        return json({ error: 'instancia no encontrada' }, 404);
      }
    }

    return json({ error: 'ruta no encontrada' }, 404);
  },
} satisfies ExportedHandler<Env>;
