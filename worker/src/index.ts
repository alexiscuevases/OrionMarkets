import { INTERVALS, SYMBOLS, type Env } from './types';
export { OrionPipeline } from './workflow';

/* Punto de entrada del Worker:
   - scheduled: el cron horario crea una instancia del pipeline
   - fetch: API JSON de solo lectura para el frontend + trigger manual */

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
    await env.PIPELINE.create({
      id: `cron-${event.scheduledTime}`,
      params: { trigger: 'cron' },
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
               e.ai_thesis AS aiThesis, e.scores_json AS scoresJson,
               e.overall_score AS overallScore
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

    /* --- mejores oportunidades puntuadas --- */
    if (pathname === '/api/opportunities') {
      const limit = Math.min(Number(searchParams.get('limit')) || 20, 100);
      const { results } = await env.DB
        .prepare(
          `SELECT s.sig_key AS sigKey, s.symbol, s.interval, s.ts, s.pattern, s.direction,
                  s.entry, s.stop, s.target, s.rr, s.confidence, s.outcome,
                  e.ai_action AS aiAction, e.ai_confidence AS aiConfidence,
                  e.ai_thesis AS aiThesis, e.ai_risks AS aiRisks,
                  e.scores_json AS scoresJson, e.overall_score AS overallScore
           FROM evaluations e JOIN signals s ON s.sig_key = e.sig_key
           WHERE e.ai_action != 'skip'
           ORDER BY e.overall_score DESC, s.ts DESC LIMIT ?`,
        )
        .bind(limit)
        .all();
      return json({ opportunities: results });
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
