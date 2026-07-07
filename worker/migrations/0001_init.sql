-- Orion Markets — esquema base

-- Velas OHLC por símbolo + intervalo. ts en epoch ms (UTC).
CREATE TABLE IF NOT EXISTS candles (
  symbol   TEXT NOT NULL,
  interval TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  open     REAL NOT NULL,
  high     REAL NOT NULL,
  low      REAL NOT NULL,
  close    REAL NOT NULL,
  volume   REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, interval, ts)
);

CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles (symbol, interval, ts DESC);

-- Cursor de ingesta incremental por símbolo + intervalo.
CREATE TABLE IF NOT EXISTS sync_state (
  symbol     TEXT NOT NULL,
  interval   TEXT NOT NULL,
  last_ts    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, interval)
);

-- Señales detectadas por algoritmos deterministas (histórico completo).
-- sig_key = symbol|interval|ts|pattern → idempotente entre ejecuciones.
CREATE TABLE IF NOT EXISTS signals (
  sig_key    TEXT PRIMARY KEY,
  symbol     TEXT NOT NULL,
  interval   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  pattern    TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
  entry      REAL NOT NULL,
  stop       REAL NOT NULL,
  target     REAL NOT NULL,
  rr         REAL NOT NULL,
  confidence INTEGER NOT NULL,           -- 0-100, regla determinista
  outcome    TEXT NOT NULL DEFAULT 'open' -- open | tp_hit | sl_hit | expired
    CHECK (outcome IN ('open', 'tp_hit', 'sl_hit', 'expired')),
  outcome_ts INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signals_lookup ON signals (symbol, interval, ts DESC);
CREATE INDEX IF NOT EXISTS idx_signals_outcome ON signals (outcome, confidence DESC);

-- Evaluación IA + scoring por señal.
CREATE TABLE IF NOT EXISTS evaluations (
  sig_key       TEXT PRIMARY KEY REFERENCES signals (sig_key),
  context_json  TEXT NOT NULL,  -- dossier determinista que se pasó a la IA
  ai_action     TEXT NOT NULL CHECK (ai_action IN ('buy', 'sell', 'skip')),
  ai_confidence INTEGER NOT NULL, -- 0-100 según la IA
  ai_thesis     TEXT NOT NULL,
  ai_risks      TEXT NOT NULL,
  scores_json   TEXT NOT NULL,  -- desglose por dimensión (0-5 cada una)
  overall_score INTEGER NOT NULL, -- 0-100
  model         TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_score ON evaluations (overall_score DESC);
