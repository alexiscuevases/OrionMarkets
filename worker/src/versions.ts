/* Versionado del sistema (Fase 11).

   Cada señal guarda la versión del detector que la produjo y cada
   evaluación la versión del prompt y el modelo. Sin esto, cambiar un
   detector o un prompt invalida silenciosamente la calibración, las
   lecciones y las estadísticas por patrón: los datos viejos y nuevos
   quedarían mezclados sin forma de separarlos.

   Reglas de subida (semver):
   - DETECTOR_VERSION: mayor si cambian niveles/universo de señales
     (requiere reset de derivados, ver migración 0002); menor si se añade
     un detector; parche para ajustes que no cambian señales existentes.
   - PROMPT_VERSION: cualquier cambio de texto del system prompt sube la
     versión — la calibración empírica se filtra por versión en el futuro. */

/** Detectores deterministas (patterns.ts + filtros globales + SMC en dossier). */
export const DETECTOR_VERSION = '2.1.0';

/** System prompt de evaluación de señales (ai.ts). */
export const PROMPT_VERSION = '3.0.0';

/** Prompt de reflexión sobre errores (learn.ts). */
export const REFLECT_PROMPT_VERSION = '1.0.0';

/** Estrategia global de scoring (scoring.ts: pesos y dimensiones). */
export const STRATEGY_VERSION = '1.2.0';
