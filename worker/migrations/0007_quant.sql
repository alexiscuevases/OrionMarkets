-- Plataforma cuantitativa: régimen de mercado por señal, salud de patrones
-- (walk-forward), pesos de scoring evolutivos, invalidación del veredicto IA
-- y revisiones deterministas de cada trade cerrado.

-- ---------- régimen de mercado (Mejora 1) ----------
-- Etiqueta calculada al detectar la señal (ADX + pendiente EMA + percentil
-- ATR): TRENDING_UP | TRENDING_DOWN | RANGE | HIGH_VOLATILITY | LOW_VOLATILITY.
-- NULL en filas antiguas; el pipeline las backfillea por lotes en cada run.

ALTER TABLE signals ADD COLUMN regime TEXT;

-- ---------- salida IA con invalidación (Mejora 6) ----------

ALTER TABLE evaluations ADD COLUMN ai_invalidation TEXT;
ALTER TABLE evaluations ADD COLUMN strategy_version TEXT;
ALTER TABLE evaluation_history ADD COLUMN ai_invalidation TEXT;

-- ---------- salud de patrones / walk-forward (Mejoras 3 y 5) ----------
-- Una fila por mercado+patrón, recalculada tras cada resolución de outcomes.
-- 'disabled' reproduce el gate binario actual; 'degrading' aplica un
-- multiplicador de confianza gradual en el scoring.

CREATE TABLE IF NOT EXISTS pattern_health (
  symbol                TEXT NOT NULL,
  interval              TEXT NOT NULL,
  pattern               TEXT NOT NULL,
  detector_version      TEXT,
  total_trades          INTEGER NOT NULL DEFAULT 0,
  win_rate              REAL NOT NULL DEFAULT 0,     -- tpRate sobre tp+sl
  avg_rr                REAL NOT NULL DEFAULT 0,
  expectancy            REAL NOT NULL DEFAULT 0,     -- tpRate·avgRr − (1−tpRate), en R
  recent_trades         INTEGER NOT NULL DEFAULT 0,  -- cierres de la ventana reciente
  recent_win_rate       REAL NOT NULL DEFAULT 0,
  recent_expectancy     REAL NOT NULL DEFAULT 0,
  degradation_score     REAL NOT NULL DEFAULT 0,     -- 0-1: deterioro reciente vs. histórico
  health                INTEGER NOT NULL DEFAULT 50, -- 0-100
  status                TEXT NOT NULL DEFAULT 'healthy'
    CHECK (status IN ('healthy', 'degrading', 'disabled')),
  confidence_multiplier REAL NOT NULL DEFAULT 1.0,   -- 0 (disabled) … 1 (healthy)
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (symbol, interval, pattern)
);

-- ---------- pesos de scoring evolutivos (Mejora 2) ----------
-- Fila única: los pesos vigentes de scoreSignal. Evolucionan de forma
-- determinista con los cierres reales (sin ML); la suma total se conserva
-- para que la escala 0-100 del score no se mueva.

CREATE TABLE IF NOT EXISTS scoring_weights (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  weights_json     TEXT NOT NULL,
  samples          INTEGER NOT NULL DEFAULT 0,       -- cierres usados en la última evolución
  strategy_version TEXT NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- ---------- evaluación continua por trade cerrado (Mejora 7) ----------
-- Clasificación determinista (sin IA) de cada cierre con evaluación:
-- ¿acertó la IA? ¿funcionó el patrón? ¿el régimen acompañaba?
-- Material estructurado para la reflexión y para auditoría.

CREATE TABLE IF NOT EXISTS trade_reviews (
  sig_key                TEXT PRIMARY KEY,
  symbol                 TEXT NOT NULL,
  interval               TEXT NOT NULL,
  pattern                TEXT NOT NULL,
  regime                 TEXT,
  outcome                TEXT NOT NULL,
  ai_action              TEXT,
  ai_confidence          INTEGER,
  overall_score          INTEGER,
  mistake_type           TEXT NOT NULL,              -- taxonomía de review.ts
  cause                  TEXT,                       -- heurística: primera causa observable
  ai_correct             INTEGER,                    -- 1 | 0 | NULL (expirada)
  pattern_worked         INTEGER NOT NULL,           -- 1 si tp_hit
  regime_aligned         INTEGER,                    -- 1 | 0 | NULL (RANGE/vol/sin régimen)
  confidence_calibrated  INTEGER,                    -- 1 | 0 | NULL
  affected_patterns      TEXT,                       -- JSON: patrones implicados
  created_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_created ON trade_reviews (created_at DESC);

-- ---------- lecciones con taxonomía (Mejora 7) ----------

ALTER TABLE lessons ADD COLUMN mistake_type TEXT;
ALTER TABLE lessons ADD COLUMN cause TEXT;
ALTER TABLE lessons ADD COLUMN affected_patterns TEXT;
