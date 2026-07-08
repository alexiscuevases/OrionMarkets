import { aiUsage } from './aiLog';
import { runBacktest, type BacktestParams } from './backtest';
import { getAiCalibration, getLessons, getMemoryProgress, loadCandles } from './db';
import { clientIp, corsHeaders, jsonWith, rateLimit, readJsonBody, requireAdmin } from './http';
import { atr, ema, rsi, slopePct } from './indicators';
import { parseEvents, upsertEvents } from './marketContext';
import { healthReport, recentRuns, recordRunSkipped } from './observe';
import { accountSummary, DEFAULT_ACCOUNT_ID, resetAccount } from './paper';
import { positionSize } from './risk';
import { DETECTOR_VERSION, PROMPT_VERSION, STRATEGY_VERSION } from './versions';
import { PIPELINE_LOCK_KEY } from './workflow';
import { INTERVALS, SYMBOLS, type Env, type Interval } from './types';
export { OrionPipeline } from './workflow';

/* Punto de entrada del Worker.

   - scheduled: cron cada 15 min; salta el disparo si hay un pipeline en
     curso (lock KV) para no competir por la cuota de Twelve Data.
   - fetch: API JSON. Endpoints públicos de lectura con rate limiting por
     IP; endpoints mutantes/caros tras ADMIN_API_KEY (Fase 8). */

const CRON_INTERVALS: Record<number, Interval[]> = {
  0: ['1h'],
  15: ['5min', '15min'],
  30: ['30min'],
  45: ['45min'],
};

/** Peticiones/min por IP para la API pública de lectura. */
const PUBLIC_RATE_LIMIT = 120;

function validSymbol(s: string | null): s is (typeof SYMBOLS)[number] {
  return !!s && (SYMBOLS as readonly string[]).includes(s);
}

function validInterval(i: string | null): i is (typeof INTERVALS)[number] {
  return !!i && (INTERVALS as readonly string[]).includes(i);
}

export default {
  async scheduled(event, env) {
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    const id = `cron-${event.scheduledTime}`;

    // P0-4: sin lock, un run largo + el siguiente cron = dos ingestas
    // simultáneas repartiéndose 8 créditos/min → cascada de 429
    const running = await env.CACHE.get(PIPELINE_LOCK_KEY);
    if (running) {
      await recordRunSkipped(
        env.DB, id, 'cron', `saltado: pipeline ${running} aún en ejecución`,
      ).catch(() => {});
      return;
    }

    await env.PIPELINE.create({
      id,
      params: { trigger: 'cron', intervals: CRON_INTERVALS[minute] ?? [...INTERVALS] },
    });
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    const cors = corsHeaders(request, env);
    const json = (data: unknown, status = 200) => jsonWith(cors, data, status);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    try {
      /* ================= endpoints de administración ================= */

      if (pathname === '/api/run' && request.method === 'POST') {
        const auth = requireAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        const running = await env.CACHE.get(PIPELINE_LOCK_KEY);
        if (running) {
          return json({ error: `pipeline ${running} aún en ejecución`, running }, 409);
        }
        const instance = await env.PIPELINE.create({
          id: crypto.randomUUID(),
          params: { trigger: 'manual' },
        });
        return json({ id: instance.id, status: await instance.status() }, 202);
      }

      const runMatch = pathname.match(/^\/api\/run\/([a-zA-Z0-9-]+)$/);
      if (runMatch) {
        const auth = requireAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        try {
          const instance = await env.PIPELINE.get(runMatch[1]);
          return json({ id: runMatch[1], status: await instance.status() });
        } catch {
          return json({ error: 'instancia no encontrada' }, 404);
        }
      }

      /* --- backtesting (Fase 2): cómputo bajo demanda, separado de live --- */
      if (pathname === '/api/backtest' && request.method === 'POST') {
        const auth = requireAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        const body = await readJsonBody(request);
        const params = parseBacktestBody(body);
        if (!params) {
          return json({
            error: 'body inválido; se espera {symbol, interval, from, to, patterns?, minConfidence?, initialBalance?, riskPct?}',
          }, 400);
        }

        const candles = await loadCandles(env.DB, params.symbol, params.interval, 50_000);
        if (candles.length < 300) {
          return json({ error: `histórico insuficiente para ${params.symbol} ${params.interval}` }, 422);
        }

        const result = runBacktest(candles, params);
        const id = crypto.randomUUID();
        // se persiste el resumen (equity acotada); los trades solo viajan
        // en la respuesta para no inflar la fila
        const stored = {
          ...result,
          metrics: { ...result.metrics, equityCurve: downsample(result.metrics.equityCurve, 500) },
          trades: undefined,
        };
        await env.DB
          .prepare(
            `INSERT INTO backtests (id, created_at, symbol, interval, from_ts, to_ts,
                                    params_json, detector_version, metrics_json, trades)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id, Date.now(), params.symbol, params.interval, params.fromTs, params.toTs,
            JSON.stringify(result.params), result.detectorVersion,
            JSON.stringify(stored.metrics), result.metrics.totalTrades,
          )
          .run();

        return json({ id, ...result, trades: result.trades.slice(0, 1000) });
      }

      if (pathname === '/api/paper/reset' && request.method === 'POST') {
        const auth = requireAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        const body = (await readJsonBody(request)) as
          | { initialBalance?: number; riskPct?: number; minScore?: number }
          | null;
        await resetAccount(env.DB, DEFAULT_ACCOUNT_ID, {
          initialBalance: numberIn(body?.initialBalance, 100, 10_000_000),
          riskPct: numberIn(body?.riskPct, 0.1, 10),
          minScore: numberIn(body?.minScore, 0, 100),
        });
        return json({ ok: true });
      }

      if (pathname === '/api/admin/events' && request.method === 'POST') {
        const auth = requireAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        const events = parseEvents(await readJsonBody(request));
        if (!events) {
          return json({ error: 'body inválido; se espera {events: [{ts, currency, impact, title, ...}]} (máx. 500)' }, 400);
        }
        const inserted = await upsertEvents(env.DB, events);
        return json({ ok: true, received: events.length, upserted: inserted });
      }

      if (pathname === '/api/admin/metrics') {
        const auth = requireAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        const weekAgo = Date.now() - 7 * 86_400_000;
        const [health, usage7d, counts, backtests] = await Promise.all([
          healthReport(env),
          aiUsage(env.DB, weekAgo),
          tableCounts(env.DB),
          env.DB
            .prepare(
              `SELECT id, created_at AS createdAt, symbol, interval, trades, detector_version AS detectorVersion
               FROM backtests ORDER BY created_at DESC LIMIT 10`,
            )
            .all()
            .then((r) => r.results),
        ]);
        return json({
          health,
          ai7d: usage7d,
          tables: counts,
          recentBacktests: backtests,
          versions: {
            detector: DETECTOR_VERSION,
            prompt: PROMPT_VERSION,
            strategy: STRATEGY_VERSION,
            model: env.AI_MODEL,
          },
        });
      }

      /* --- dataset etiquetado: material de fine-tuning, no público --- */
      if (pathname === '/api/dataset') {
        const auth = requireAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        const limit = Math.min(Number(searchParams.get('limit')) || 200, 1000);
        const { results } = await env.DB
          .prepare(
            `SELECT e.context_json AS contextJson, e.ai_action AS aiAction,
                    e.ai_confidence AS aiConfidence, e.ai_thesis AS aiThesis,
                    e.prompt_version AS promptVersion, e.model,
                    s.outcome, s.rr, s.detector_version AS detectorVersion
             FROM evaluations e JOIN signals s ON s.sig_key = e.sig_key
             WHERE s.outcome IN ('tp_hit', 'sl_hit') AND e.model NOT LIKE 'gate:%'
             ORDER BY s.outcome_ts DESC LIMIT ?`,
          )
          .bind(limit)
          .all();
        return json({ examples: results });
      }

      /* ================= API pública (rate-limited) ================= */

      const rl = await rateLimit(env.CACHE, `${clientIp(request)}:public`, PUBLIC_RATE_LIMIT);
      if (!rl.allowed) {
        return jsonWith(cors, { error: 'demasiadas peticiones; inténtalo en un minuto' }, 429, {
          'Retry-After': '60',
        });
      }

      /* --- salud del sistema (Fase 7), cacheada 60 s --- */
      if (pathname === '/api/health') {
        const cached = await env.CACHE.get('health:report', 'json');
        if (cached) return json(cached);
        const report = await healthReport(env);
        await env.CACHE.put('health:report', JSON.stringify(report), { expirationTtl: 60 });
        return json(report);
      }

      /* --- historial de runs del pipeline (solo lectura) --- */
      if (pathname === '/api/runs') {
        const limit = Math.min(Number(searchParams.get('limit')) || 20, 100);
        return json({ runs: await recentRuns(env.DB, limit) });
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
                 s.detector_version AS detectorVersion,
                 e.ai_action AS aiAction, e.ai_confidence AS aiConfidence,
                 e.ai_thesis AS aiThesis, e.ai_risks AS aiRisks,
                 e.scores_json AS scoresJson, e.context_json AS contextJson,
                 e.overall_score AS overallScore, e.prompt_version AS promptVersion, e.model,
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

      /* --- auditoría de una señal: por qué la IA aceptó/rechazó --- */
      if (pathname === '/api/audit') {
        const sigKey = searchParams.get('sigKey') ?? '';
        if (!/^[A-Z]{6}\|[a-z0-9]+\|\d+\|.{1,80}$/.test(sigKey)) {
          return json({ error: 'sigKey inválida' }, 400);
        }
        const [history, calls] = await env.DB.batch([
          env.DB
            .prepare(
              `SELECT revision, ai_action AS aiAction, ai_confidence AS aiConfidence,
                      ai_thesis AS aiThesis, ai_risks AS aiRisks, overall_score AS overallScore,
                      model, prompt_version AS promptVersion, created_at AS createdAt
               FROM evaluation_history WHERE sig_key = ? ORDER BY revision ASC`,
            )
            .bind(sigKey),
          env.DB
            .prepare(
              `SELECT ts, kind, model, prompt_version AS promptVersion, latency_ms AS latencyMs,
                      tokens_in AS tokensIn, tokens_out AS tokensOut,
                      est_cost_usd AS estCostUsd, success, error
               FROM ai_calls WHERE sig_key = ? ORDER BY ts ASC`,
            )
            .bind(sigKey),
        ]);
        return json({ sigKey, evaluations: history.results, aiCalls: calls.results });
      }

      /* --- rendimiento real por patrón para el panel de estrategias --- */
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

      /* --- estado de mercado por símbolo, cacheado en KV --- */
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

          // próximo evento de alto impacto de las divisas del par (Fase 5)
          const nextEvent = await env.DB
            .prepare(
              `SELECT ts, currency, title FROM market_events
               WHERE currency IN (?, ?) AND impact = 'high' AND ts >= ?
               ORDER BY ts ASC LIMIT 1`,
            )
            .bind(symbol.slice(0, 3), symbol.slice(3), Date.now())
            .first<{ ts: number; currency: string; title: string }>();

          states.push({
            symbol,
            trend,
            trendStrength,
            volatility,
            atrPct,
            rsi14: Math.round(rsi(closes, 14)[last] ?? 50),
            aboveEma200: Number.isFinite(e200[last]) ? price > e200[last] : null,
            lastCandleTs: candles[candles.length - 1].ts,
            news: nextEvent
              ? `${nextEvent.currency}: ${nextEvent.title} (${new Date(nextEvent.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC)`
              : null,
          });
        }

        const payload = { states, generatedAt: Date.now() };
        await env.CACHE.put('market:state', JSON.stringify(payload), { expirationTtl: 300 });
        return json(payload);
      }

      /* --- calendario económico próximo (Fase 5) --- */
      if (pathname === '/api/events') {
        const symbol = searchParams.get('symbol');
        const currencies = validSymbol(symbol)
          ? [symbol.slice(0, 3), symbol.slice(3)]
          : null;
        const from = Date.now() - 12 * 3_600_000;
        const to = Date.now() + 7 * 86_400_000;
        const query = currencies
          ? env.DB
              .prepare(
                `SELECT ts, currency, impact, title, actual, forecast, previous
                 FROM market_events WHERE ts BETWEEN ? AND ? AND currency IN (?, ?)
                 ORDER BY ts ASC LIMIT 100`,
              )
              .bind(from, to, currencies[0], currencies[1])
          : env.DB
              .prepare(
                `SELECT ts, currency, impact, title, actual, forecast, previous
                 FROM market_events WHERE ts BETWEEN ? AND ?
                 ORDER BY ts ASC LIMIT 100`,
              )
              .bind(from, to);
        const { results } = await query.all();
        return json({ events: results });
      }

      /* --- estado del aprendizaje --- */
      if (pathname === '/api/learning') {
        const [lessons, calibration, memory] = await Promise.all([
          getLessons(env.DB, 20),
          getAiCalibration(env.DB),
          getMemoryProgress(env.DB),
        ]);
        return json({ lessons, calibration, memory });
      }

      /* --- riesgo (Fase 4): cálculo puro de tamaño de posición --- */
      if (pathname === '/api/risk/position-size') {
        const symbol = searchParams.get('symbol');
        if (!validSymbol(symbol)) return json({ error: 'symbol inválido' }, 400);
        const balance = Number(searchParams.get('balance'));
        const riskPct = Number(searchParams.get('riskPct'));
        const entry = Number(searchParams.get('entry'));
        const stop = Number(searchParams.get('stop'));
        try {
          return json({
            symbol,
            input: { balance, riskPct, entry, stop },
            ...positionSize({ balance, riskPct, entry, stop, symbol }),
          });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : 'parámetros inválidos' }, 400);
        }
      }

      /* --- paper trading (Fase 3): cuenta, posiciones y trades --- */
      if (pathname === '/api/paper/account') {
        const summary = await accountSummary(env.DB, DEFAULT_ACCOUNT_ID);
        if (!summary) return json({ error: 'cuenta aún no inicializada (se crea en el primer run del pipeline)' }, 404);
        return json(summary);
      }

      if (pathname === '/api/paper/trades') {
        const limit = Math.min(Number(searchParams.get('limit')) || 100, 500);
        const { results } = await env.DB
          .prepare(
            `SELECT sig_key AS sigKey, symbol, interval, direction, pattern, entry,
                    exit_price AS exitPrice, units, risk_amount AS riskAmount,
                    pl_amount AS plAmount, pl_r AS plR, outcome,
                    opened_at AS openedAt, closed_at AS closedAt, balance_after AS balanceAfter
             FROM paper_trades WHERE account_id = ?
             ORDER BY closed_at DESC LIMIT ?`,
          )
          .bind(DEFAULT_ACCOUNT_ID, limit)
          .all();
        return json({ trades: results });
      }

      /* --- backtests guardados (lectura pública; el cómputo es admin) --- */
      if (pathname === '/api/backtests') {
        const { results } = await env.DB
          .prepare(
            `SELECT id, created_at AS createdAt, symbol, interval, from_ts AS fromTs,
                    to_ts AS toTs, trades, detector_version AS detectorVersion, params_json AS paramsJson
             FROM backtests ORDER BY created_at DESC LIMIT 50`,
          )
          .all();
        return json({ backtests: results });
      }

      const btMatch = pathname.match(/^\/api\/backtests\/([a-f0-9-]{36})$/);
      if (btMatch) {
        const row = await env.DB
          .prepare(
            `SELECT id, created_at AS createdAt, symbol, interval, from_ts AS fromTs,
                    to_ts AS toTs, params_json AS paramsJson, detector_version AS detectorVersion,
                    metrics_json AS metricsJson, trades
             FROM backtests WHERE id = ?`,
          )
          .bind(btMatch[1])
          .first<{ metricsJson: string; paramsJson: string } & Record<string, unknown>>();
        if (!row) return json({ error: 'backtest no encontrado' }, 404);
        return json({
          ...row,
          metrics: JSON.parse(row.metricsJson),
          params: JSON.parse(row.paramsJson),
          metricsJson: undefined,
          paramsJson: undefined,
        });
      }

      return json({ error: 'ruta no encontrada' }, 404);
    } catch (e) {
      // los errores no controlados devuelven un 500 uniforme sin filtrar
      // internals; el detalle queda en observabilidad de Workers
      console.error('API error', pathname, e);
      return json({ error: 'error interno' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/* ---------- helpers ---------- */

function parseBacktestBody(body: unknown): (BacktestParams & { fromTs: number; toTs: number }) | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const symbol = String(b.symbol ?? '');
  const interval = String(b.interval ?? '');
  if (!validSymbol(symbol) || !validInterval(interval)) return null;

  const fromTs = parseTs(b.from);
  const toTs = parseTs(b.to);
  if (fromTs === null || toTs === null || fromTs >= toTs) return null;

  const patterns = Array.isArray(b.patterns)
    ? b.patterns.filter((p): p is string => typeof p === 'string').slice(0, 20)
    : undefined;

  return {
    symbol,
    interval,
    fromTs,
    toTs,
    patterns: patterns?.length ? patterns : undefined,
    minConfidence: numberIn(b.minConfidence, 0, 100),
    initialBalance: numberIn(b.initialBalance, 100, 10_000_000),
    riskPct: numberIn(b.riskPct, 0.05, 10),
  };
}

function parseTs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function numberIn(v: unknown, min: number, max: number): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

function downsample<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  out[out.length - 1] = points[points.length - 1];
  return out;
}

async function tableCounts(db: D1Database): Promise<Record<string, number>> {
  const tables = [
    'candles', 'signals', 'evaluations', 'evaluation_history', 'lessons',
    'ai_calls', 'pipeline_runs', 'backtests', 'paper_positions', 'paper_trades',
    'market_events',
  ];
  const res = await db.batch(tables.map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`)));
  const out: Record<string, number> = {};
  tables.forEach((t, i) => {
    out[t] = (res[i].results[0] as { n: number }).n;
  });
  return out;
}
