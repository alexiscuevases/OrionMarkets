-- Re-evaluación continua de señales abiertas: cada evaluación guarda su
-- nº de revisión y cuándo se actualizó por última vez. La fila se
-- sobreescribe con el veredicto más reciente (contexto + veredicto siempre
-- coherentes entre sí); created_at conserva la fecha de la primera evaluación.

ALTER TABLE evaluations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE evaluations ADD COLUMN updated_at INTEGER;
