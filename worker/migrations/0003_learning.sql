-- Aprendizaje continuo: lecciones destiladas de errores IA + estado de
-- indexación vectorial de casos cerrados.

-- Lecciones que la IA extrae de sus propios fallos (falsos positivos que
-- tocaron SL, descartes que tocaron TP). Se inyectan en el prompt de las
-- evaluaciones futuras. scope = 'global' o 'SYMBOL|interval'.
CREATE TABLE IF NOT EXISTS lessons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,
  lesson     TEXT NOT NULL,
  support    INTEGER NOT NULL DEFAULT 1, -- nº de casos que la respaldan
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lessons_scope ON lessons (scope, created_at DESC);

-- Marca de indexación en la memoria vectorial (Vectorize): las señales
-- cerradas con indexed_at NULL están pendientes de embeber e indexar.
ALTER TABLE signals ADD COLUMN indexed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_signals_unindexed
  ON signals (outcome, indexed_at) WHERE indexed_at IS NULL;
