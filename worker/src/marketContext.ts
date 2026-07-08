/* Capa de contexto de mercado (Fase 5) — calendario económico y avisos.

   La tabla market_events es agnóstica del proveedor: cualquier fuente
   (ForexFactory, FMP, un cron externo…) puede volcar eventos vía
   POST /api/admin/events. El dossier de la IA y el scoring consumen esta
   capa sin saber de dónde vienen los datos; hasta conectar un proveedor,
   news queda null y la IA puntúa neutral (comportamiento actual intacto). */

export interface MarketEvent {
  id?: number;
  ts: number;
  currency: string;   // USD, EUR, GBP, JPY...
  impact: 'low' | 'medium' | 'high';
  title: string;
  source?: string;
  actual?: string | null;
  forecast?: string | null;
  previous?: string | null;
}

export interface MarketContext {
  /** Eventos próximos (siguientes 36 h) que afectan a las divisas del par. */
  upcomingEvents: MarketEvent[];
  /** Resumen legible para el dossier IA; null sin eventos. */
  newsSummary: string | null;
  /** Avisos operativos (evento de alto impacto inminente). */
  warnings: string[];
}

/** Divisas de un par: EURUSD → [EUR, USD]. */
export function pairCurrencies(symbol: string): [string, string] {
  return [symbol.slice(0, 3), symbol.slice(3, 6)];
}

const UPCOMING_MS = 36 * 3_600_000;
const IMMINENT_MS = 4 * 3_600_000;

/**
 * Contexto de eventos para un símbolo en el momento `asOf`. Solo mira el
 * futuro cercano respecto a asOf: en re-evaluaciones asOf es el presente,
 * en evaluaciones iniciales el momento de la señal (sin look-ahead: un
 * evento CONOCIDO con antelación en el calendario no es información futura).
 */
export async function getMarketContext(
  db: D1Database,
  symbol: string,
  asOf: number,
): Promise<MarketContext> {
  const [base, quote] = pairCurrencies(symbol);
  const { results } = await db
    .prepare(
      `SELECT ts, currency, impact, title, actual, forecast, previous
       FROM market_events
       WHERE currency IN (?, ?) AND ts >= ? AND ts <= ? AND impact IN ('medium', 'high')
       ORDER BY ts ASC LIMIT 12`,
    )
    .bind(base, quote, asOf - 3_600_000, asOf + UPCOMING_MS)
    .all<MarketEvent>();

  const warnings: string[] = [];
  for (const e of results) {
    if (e.impact === 'high' && e.ts >= asOf && e.ts - asOf <= IMMINENT_MS) {
      const hours = Math.max(1, Math.round((e.ts - asOf) / 3_600_000));
      warnings.push(
        `Evento de ALTO impacto en ${e.currency} dentro de ~${hours} h: ${e.title}. ` +
        'Volatilidad y spreads pueden barrer stops.',
      );
    }
  }

  let newsSummary: string | null = null;
  if (results.length > 0) {
    newsSummary = results
      .slice(0, 6)
      .map((e) => {
        const when = new Date(e.ts).toISOString().slice(0, 16).replace('T', ' ');
        const fc = e.forecast ? ` (previsión ${e.forecast}, anterior ${e.previous ?? '—'})` : '';
        return `${when} UTC · ${e.currency} · impacto ${e.impact}: ${e.title}${fc}`;
      })
      .join(' | ');
  }

  return { upcomingEvents: results, newsSummary, warnings };
}

/** Inserta eventos (idempotente por ts+currency+title). Devuelve insertados. */
export async function upsertEvents(db: D1Database, events: MarketEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const now = Date.now();
  const stmts = events.map((e) =>
    db
      .prepare(
        `INSERT INTO market_events (ts, currency, impact, title, source, actual, forecast, previous, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (ts, currency, title) DO UPDATE SET
           impact = excluded.impact, actual = excluded.actual,
           forecast = excluded.forecast, previous = excluded.previous`,
      )
      .bind(
        e.ts, e.currency.toUpperCase(), e.impact, e.title.slice(0, 200),
        e.source ?? 'manual', e.actual ?? null, e.forecast ?? null, e.previous ?? null, now,
      ),
  );
  let n = 0;
  for (let i = 0; i < stmts.length; i += 40) {
    const res = await db.batch(stmts.slice(i, i + 40));
    n += res.reduce((s, r) => s + (r.meta.changes ?? 0), 0);
  }
  return n;
}

/** Validación estricta del payload de POST /api/admin/events. */
export function parseEvents(body: unknown): MarketEvent[] | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { events?: unknown }).events)) {
    return null;
  }
  const raw = (body as { events: unknown[] }).events;
  if (raw.length === 0 || raw.length > 500) return null;

  const out: MarketEvent[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') return null;
    const ev = e as Record<string, unknown>;
    const ts = Number(ev.ts);
    const currency = String(ev.currency ?? '');
    const impact = ev.impact;
    const title = String(ev.title ?? '').trim();
    if (
      !Number.isFinite(ts) || ts <= 0 ||
      !/^[A-Za-z]{3}$/.test(currency) ||
      (impact !== 'low' && impact !== 'medium' && impact !== 'high') ||
      title.length < 3 || title.length > 200
    ) {
      return null;
    }
    out.push({
      ts,
      currency,
      impact,
      title,
      source: typeof ev.source === 'string' ? ev.source.slice(0, 40) : 'manual',
      actual: typeof ev.actual === 'string' ? ev.actual.slice(0, 40) : null,
      forecast: typeof ev.forecast === 'string' ? ev.forecast.slice(0, 40) : null,
      previous: typeof ev.previous === 'string' ? ev.previous.slice(0, 40) : null,
    });
  }
  return out;
}
