-- Endurecimiento de producción: índices que faltaban, versionado,
-- historial de evaluaciones, tracking de IA, observabilidad del pipeline,
-- backtesting, paper trading y calendario económico.

-- ---------- índices que faltaban (P1-2) ----------

-- /api/strategies y /api/dataset filtran cierres por outcome_ts
CREATE INDEX IF NOT EXISTS idx_signals_closed
  ON signals (outcome, outcome_ts DESC);

-- getReevaluableSignals ordena por la última evaluación; se backfillea
-- updated_at para que el índice sirva (el código sigue usando COALESCE
-- por si quedara alguna fila antigua)
UPDATE evaluations SET updated_at = created_at WHERE updated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_eval_updated ON evaluations (updated_at ASC);

-- ---------- versionado (Fase 11) ----------

ALTER TABLE signals ADD COLUMN detector_version TEXT;
ALTER TABLE evaluations ADD COLUMN prompt_version TEXT;

-- ---------- historial de evaluaciones append-only (P1-1) ----------
-- evaluations conserva su contrato (última revisión por señal); cada
-- veredicto (inicial o re-evaluación) se archiva aquí para auditoría.

CREATE TABLE IF NOT EXISTS evaluation_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sig_key       TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  ai_action     TEXT NOT NULL,
  ai_confidence INTEGER NOT NULL,
  ai_thesis     TEXT NOT NULL,
  ai_risks      TEXT NOT NULL,
  overall_score INTEGER NOT NULL,
  model         TEXT NOT NULL,
  prompt_version TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evalhist_sig ON evaluation_history (sig_key, revision);

-- ---------- tracking de llamadas IA (Fase 6) ----------

CREATE TABLE IF NOT EXISTS ai_calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  kind           TEXT NOT NULL,             -- evaluate | reevaluate | reflect | embed
  model          TEXT NOT NULL,
  prompt_version TEXT,
  sig_key        TEXT,
  latency_ms     INTEGER NOT NULL,
  tokens_in      INTEGER NOT NULL DEFAULT 0,  -- reales si el modelo los reporta; estimados si no
  tokens_out     INTEGER NOT NULL DEFAULT 0,
  est_cost_usd   REAL NOT NULL DEFAULT 0,
  success        INTEGER NOT NULL,          -- 1 | 0
  error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_aicalls_ts ON ai_calls (ts DESC);

-- ---------- observabilidad del pipeline (Fase 7) ----------

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id            TEXT PRIMARY KEY,           -- id de la instancia del Workflow
  trigger       TEXT NOT NULL,              -- cron | manual
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'error', 'skipped')),
  error         TEXT,
  counters_json TEXT                        -- {ingested, newSignals, evaluated, ...}
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON pipeline_runs (started_at DESC);

-- ---------- backtesting (Fase 2) ----------
-- Separación clara de señales live: un backtest es una simulación bajo
-- demanda; nunca escribe en signals/evaluations.

CREATE TABLE IF NOT EXISTS backtests (
  id            TEXT PRIMARY KEY,           -- uuid
  created_at    INTEGER NOT NULL,
  symbol        TEXT NOT NULL,
  interval      TEXT NOT NULL,
  from_ts       INTEGER NOT NULL,
  to_ts         INTEGER NOT NULL,
  params_json   TEXT NOT NULL,              -- filtros, riesgo, balance inicial
  detector_version TEXT NOT NULL,
  metrics_json  TEXT NOT NULL,              -- resumen completo (equity, mensual, por patrón)
  trades        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backtests_created ON backtests (created_at DESC);

-- ---------- paper trading (Fase 3) ----------

CREATE TABLE IF NOT EXISTS paper_accounts (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,
  initial_balance    REAL NOT NULL,
  balance            REAL NOT NULL,
  risk_pct           REAL NOT NULL DEFAULT 1.0,   -- % del balance arriesgado por operación
  min_score          INTEGER NOT NULL DEFAULT 65, -- overall_score mínimo para ejecutar
  max_open_positions INTEGER NOT NULL DEFAULT 6,
  max_total_risk_pct REAL NOT NULL DEFAULT 6.0,   -- exposición máxima simultánea
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- registro de cada intento de ejecución (auditable incluso si se rechaza)
CREATE TABLE IF NOT EXISTS paper_orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES paper_accounts (id),
  sig_key    TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  symbol     TEXT NOT NULL,
  direction  TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'market',
  units      REAL NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('filled', 'rejected')),
  reason     TEXT                                  -- motivo del rechazo si aplica
);

CREATE INDEX IF NOT EXISTS idx_porders_account ON paper_orders (account_id, ts DESC);

CREATE TABLE IF NOT EXISTS paper_positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES paper_accounts (id),
  sig_key     TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  interval    TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
  entry       REAL NOT NULL,
  stop        REAL NOT NULL,
  target      REAL NOT NULL,
  units       REAL NOT NULL,
  lots        REAL NOT NULL,
  risk_amount REAL NOT NULL,                       -- USD arriesgado hasta el stop
  risk_pct    REAL NOT NULL,
  opened_at   INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at   INTEGER,
  close_price REAL,
  pl_amount   REAL,
  pl_r        REAL,
  UNIQUE (account_id, sig_key)                     -- una posición por señal y cuenta
);

CREATE INDEX IF NOT EXISTS idx_ppos_open ON paper_positions (account_id, status);

-- historial cerrado, base del P/L, win rate y drawdown de la cuenta
CREATE TABLE IF NOT EXISTS paper_trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES paper_accounts (id),
  position_id INTEGER NOT NULL,
  sig_key     TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  interval    TEXT NOT NULL,
  direction   TEXT NOT NULL,
  pattern     TEXT NOT NULL,
  entry       REAL NOT NULL,
  exit_price  REAL NOT NULL,
  units       REAL NOT NULL,
  risk_amount REAL NOT NULL,
  pl_amount   REAL NOT NULL,
  pl_r        REAL NOT NULL,
  outcome     TEXT NOT NULL,                       -- tp_hit | sl_hit | expired
  opened_at   INTEGER NOT NULL,
  closed_at   INTEGER NOT NULL,
  balance_after REAL NOT NULL                      -- equity curve sin recomputar
);

CREATE INDEX IF NOT EXISTS idx_ptrades_account ON paper_trades (account_id, closed_at DESC);

-- ---------- calendario económico / contexto de mercado (Fase 5) ----------

CREATE TABLE IF NOT EXISTS market_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,                     -- momento del evento (epoch ms UTC)
  currency   TEXT NOT NULL,                        -- USD, EUR, GBP, JPY...
  impact     TEXT NOT NULL CHECK (impact IN ('low', 'medium', 'high')),
  title      TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'manual',
  actual     TEXT,
  forecast   TEXT,
  previous   TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (ts, currency, title)
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON market_events (ts);
