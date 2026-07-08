import { checkExposure, positionPl, positionSize } from './risk';
import { INTERVAL_MS, type Interval } from './types';

/* Paper trading (Fase 3) — simulación de ejecución sobre las señales que
   la IA valida, con cuenta virtual, sizing por riesgo y resolución TP/SL.

   Flujo (dentro del pipeline, tras el scoring):
     señal → veredicto IA buy/sell → score >= min_score de la cuenta
       → orden market simulada (filled o rejected con motivo)
       → posición virtual con tamaño = riesgo % del balance
       → al cerrar la señal (tp/sl/expired) la posición se liquida al
         nivel correspondiente y el P/L impacta el balance

   Honestidad de la simulación:
   - solo se ejecutan señales RECIENTES (<= maxAgeBars velas desde su
     detección): entrar al precio de entrada de una señal antigua sería
     rellenar con un precio que ya no existe;
   - las expiradas se liquidan al cierre de la vela de expiración (si la
     vela no está en D1, al precio de entrada → 0 R, caso marcado);
   - una posición por señal y cuenta (UNIQUE en el esquema). */

export const DEFAULT_ACCOUNT_ID = 1;
const MAX_AGE_BARS = 6; // frescura máxima de una señal para ejecutarla

export interface PaperAccount {
  id: number;
  name: string;
  initialBalance: number;
  balance: number;
  riskPct: number;
  minScore: number;
  maxOpenPositions: number;
  maxTotalRiskPct: number;
  createdAt: number;
  updatedAt: number;
}

export interface PaperDefaults {
  initialBalance: number;
  riskPct: number;
  minScore: number;
}

/** Crea la cuenta por defecto si no existe y la devuelve. */
export async function ensureAccount(
  db: D1Database,
  defaults: PaperDefaults,
): Promise<PaperAccount> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT OR IGNORE INTO paper_accounts
       (id, name, initial_balance, balance, risk_pct, min_score, created_at, updated_at)
       VALUES (?, 'Cuenta principal', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      DEFAULT_ACCOUNT_ID, defaults.initialBalance, defaults.initialBalance,
      defaults.riskPct, defaults.minScore, now, now,
    )
    .run();
  return (await getAccount(db, DEFAULT_ACCOUNT_ID))!;
}

export async function getAccount(db: D1Database, id: number): Promise<PaperAccount | null> {
  return db
    .prepare(
      `SELECT id, name, initial_balance AS initialBalance, balance,
              risk_pct AS riskPct, min_score AS minScore,
              max_open_positions AS maxOpenPositions,
              max_total_risk_pct AS maxTotalRiskPct,
              created_at AS createdAt, updated_at AS updatedAt
       FROM paper_accounts WHERE id = ?`,
    )
    .bind(id)
    .first<PaperAccount>();
}

interface Candidate {
  sigKey: string;
  symbol: string;
  interval: string;
  ts: number;
  pattern: string;
  direction: 'buy' | 'sell';
  entry: number;
  stop: number;
  target: number;
  overallScore: number;
}

/**
 * Abre posiciones para las señales validadas por la IA que aún no tienen
 * posición en esta cuenta. Devuelve cuántas se abrieron y cuántas se
 * rechazaron (todas quedan auditadas en paper_orders).
 */
export async function openPaperPositions(
  db: D1Database,
  account: PaperAccount,
  now = Date.now(),
): Promise<{ opened: number; rejected: number }> {
  const { results: candidates } = await db
    .prepare(
      `SELECT s.sig_key AS sigKey, s.symbol, s.interval, s.ts, s.pattern,
              s.direction, s.entry, s.stop, s.target, e.overall_score AS overallScore
       FROM evaluations e
       JOIN signals s ON s.sig_key = e.sig_key
       WHERE e.ai_action IN ('buy', 'sell')
         AND e.overall_score >= ?
         AND s.outcome = 'open'
         AND NOT EXISTS (
           SELECT 1 FROM paper_positions p
           WHERE p.account_id = ? AND p.sig_key = s.sig_key
         )
       ORDER BY e.overall_score DESC
       LIMIT 20`,
    )
    .bind(account.minScore, account.id)
    .all<Candidate>();

  if (candidates.length === 0) return { opened: 0, rejected: 0 };

  const open = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(risk_amount), 0) AS risk
       FROM paper_positions WHERE account_id = ? AND status = 'open'`,
    )
    .bind(account.id)
    .first<{ n: number; risk: number }>();

  let openCount = open?.n ?? 0;
  let openRisk = open?.risk ?? 0;
  let opened = 0;
  let rejected = 0;

  for (const c of candidates) {
    const barMs = INTERVAL_MS[c.interval as Interval] ?? 3_600_000;
    let rejection: string | null = null;
    let size: ReturnType<typeof positionSize> | null = null;

    if (now - c.ts > MAX_AGE_BARS * barMs) {
      rejection = `señal antigua (${Math.round((now - c.ts) / barMs)} velas): el precio de entrada ya no es ejecutable`;
    } else {
      try {
        size = positionSize({
          balance: account.balance,
          riskPct: account.riskPct,
          entry: c.entry,
          stop: c.stop,
          symbol: c.symbol,
        });
        if (size.units <= 0) rejection = 'tamaño calculado nulo (stop demasiado lejano para el riesgo)';
      } catch (e) {
        rejection = `sizing inválido: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!rejection && size) {
        const exp = checkExposure({
          openPositions: openCount,
          openRiskAmount: openRisk,
          newRiskAmount: size.riskAmount,
          balance: account.balance,
          maxOpenPositions: account.maxOpenPositions,
          maxTotalRiskPct: account.maxTotalRiskPct,
        });
        if (!exp.allowed) rejection = exp.reason;
      }
    }

    if (rejection || !size) {
      rejected++;
      await db
        .prepare(
          `INSERT INTO paper_orders (account_id, sig_key, ts, symbol, direction, units, status, reason)
           VALUES (?, ?, ?, ?, ?, 0, 'rejected', ?)`,
        )
        .bind(account.id, c.sigKey, now, c.symbol, c.direction, rejection ?? 'sin tamaño')
        .run();
      continue;
    }

    await db.batch([
      db
        .prepare(
          `INSERT INTO paper_orders (account_id, sig_key, ts, symbol, direction, units, status, reason)
           VALUES (?, ?, ?, ?, ?, ?, 'filled', NULL)`,
        )
        .bind(account.id, c.sigKey, now, c.symbol, c.direction, size.units),
      db
        .prepare(
          `INSERT OR IGNORE INTO paper_positions
           (account_id, sig_key, symbol, interval, direction, entry, stop, target,
            units, lots, risk_amount, risk_pct, opened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          account.id, c.sigKey, c.symbol, c.interval, c.direction,
          c.entry, c.stop, c.target, size.units, size.lots,
          size.riskAmount, account.riskPct, now,
        ),
    ]);
    opened++;
    openCount++;
    openRisk += size.riskAmount;
  }

  return { opened, rejected };
}

interface OpenPositionRow {
  id: number;
  sigKey: string;
  symbol: string;
  interval: string;
  direction: 'buy' | 'sell';
  entry: number;
  stop: number;
  target: number;
  units: number;
  riskAmount: number;
  openedAt: number;
  pattern: string;
  outcome: string;
  outcomeTs: number | null;
}

/**
 * Liquida las posiciones cuya señal ya cerró (TP/SL/expirada), en orden de
 * cierre, actualizando el balance de la cuenta y dejando el trade en el
 * historial. Devuelve cuántas se cerraron.
 */
export async function resolvePaperPositions(
  db: D1Database,
  account: PaperAccount,
): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.sig_key AS sigKey, p.symbol, p.interval, p.direction,
              p.entry, p.stop, p.target, p.units, p.risk_amount AS riskAmount,
              p.opened_at AS openedAt, s.pattern, s.outcome, s.outcome_ts AS outcomeTs
       FROM paper_positions p
       JOIN signals s ON s.sig_key = p.sig_key
       WHERE p.account_id = ? AND p.status = 'open' AND s.outcome != 'open'
       ORDER BY s.outcome_ts ASC`,
    )
    .bind(account.id)
    .all<OpenPositionRow>();

  if (results.length === 0) return 0;

  let balance = account.balance;
  const now = Date.now();

  for (const p of results) {
    let exit: number;
    if (p.outcome === 'tp_hit') exit = p.target;
    else if (p.outcome === 'sl_hit') exit = p.stop;
    else {
      // expirada: cierre de la vela de expiración; sin vela → entrada (0 R)
      const candle = await db
        .prepare('SELECT close FROM candles WHERE symbol = ? AND interval = ? AND ts = ?')
        .bind(p.symbol, p.interval, p.outcomeTs)
        .first<{ close: number }>();
      exit = candle?.close ?? p.entry;
    }

    const pl = positionPl(p.symbol, p.direction, p.entry, exit, p.units);
    const plR = p.riskAmount > 0 ? Math.round((pl / p.riskAmount) * 100) / 100 : 0;
    balance = Math.round((balance + pl) * 100) / 100;
    const closedAt = p.outcomeTs ?? now;

    await db.batch([
      db
        .prepare(
          `UPDATE paper_positions
           SET status = 'closed', closed_at = ?, close_price = ?, pl_amount = ?, pl_r = ?
           WHERE id = ?`,
        )
        .bind(closedAt, exit, pl, plR, p.id),
      db
        .prepare(
          `INSERT INTO paper_trades
           (account_id, position_id, sig_key, symbol, interval, direction, pattern,
            entry, exit_price, units, risk_amount, pl_amount, pl_r, outcome,
            opened_at, closed_at, balance_after)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          account.id, p.id, p.sigKey, p.symbol, p.interval, p.direction, p.pattern,
          p.entry, exit, p.units, p.riskAmount, pl, plR, p.outcome,
          p.openedAt, closedAt, balance,
        ),
      db
        .prepare('UPDATE paper_accounts SET balance = ?, updated_at = ? WHERE id = ?')
        .bind(balance, now, account.id),
    ]);
  }

  account.balance = balance;
  return results.length;
}

/** Resumen completo de la cuenta para la API. */
export async function accountSummary(db: D1Database, accountId: number) {
  const account = await getAccount(db, accountId);
  if (!account) return null;

  const [positions, trades] = await db.batch([
    db
      .prepare(
        `SELECT sig_key AS sigKey, symbol, interval, direction, entry, stop, target,
                units, lots, risk_amount AS riskAmount, risk_pct AS riskPct,
                opened_at AS openedAt
         FROM paper_positions WHERE account_id = ? AND status = 'open'
         ORDER BY opened_at DESC`,
      )
      .bind(accountId),
    db
      .prepare(
        `SELECT symbol, interval, direction, pattern, entry, exit_price AS exitPrice,
                pl_amount AS plAmount, pl_r AS plR, outcome,
                opened_at AS openedAt, closed_at AS closedAt, balance_after AS balanceAfter
         FROM paper_trades WHERE account_id = ?
         ORDER BY closed_at DESC LIMIT 500`,
      )
      .bind(accountId),
  ]);

  const closed = trades.results as {
    plAmount: number; plR: number; outcome: string; balanceAfter: number; closedAt: number;
  }[];

  let wins = 0;
  let losses = 0;
  let netPl = 0;
  let netR = 0;
  let peak = account.initialBalance;
  let maxDdPct = 0;
  // los trades vienen DESC; el drawdown se calcula en orden temporal
  for (const t of [...closed].reverse()) {
    if (t.outcome === 'tp_hit') wins++;
    else if (t.outcome === 'sl_hit') losses++;
    netPl += t.plAmount;
    netR += t.plR;
    peak = Math.max(peak, t.balanceAfter);
    maxDdPct = Math.max(maxDdPct, (peak - t.balanceAfter) / peak);
  }
  const decided = wins + losses;

  return {
    account,
    openPositions: positions.results,
    stats: {
      totalTrades: closed.length,
      wins,
      losses,
      expired: closed.length - decided,
      winRate: decided > 0 ? Math.round((wins / decided) * 100) / 100 : null,
      netPl: Math.round(netPl * 100) / 100,
      netR: Math.round(netR * 100) / 100,
      maxDrawdownPct: Math.round(maxDdPct * 10000) / 100,
      returnPct:
        Math.round(((account.balance - account.initialBalance) / account.initialBalance) * 10000) / 100,
    },
    equityCurve: [...closed].reverse().map((t) => ({ ts: t.closedAt, balance: t.balanceAfter })),
  };
}

/** Resetea la cuenta: borra posiciones/órdenes/trades y restaura el balance. */
export async function resetAccount(
  db: D1Database,
  accountId: number,
  overrides?: Partial<Pick<PaperAccount, 'initialBalance' | 'riskPct' | 'minScore'>>,
): Promise<void> {
  const account = await getAccount(db, accountId);
  if (!account) return;
  const initial = overrides?.initialBalance ?? account.initialBalance;
  await db.batch([
    db.prepare('DELETE FROM paper_trades WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM paper_positions WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM paper_orders WHERE account_id = ?').bind(accountId),
    db
      .prepare(
        `UPDATE paper_accounts
         SET initial_balance = ?, balance = ?, risk_pct = ?, min_score = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        initial, initial,
        overrides?.riskPct ?? account.riskPct,
        overrides?.minScore ?? account.minScore,
        Date.now(), accountId,
      ),
  ]);
}
