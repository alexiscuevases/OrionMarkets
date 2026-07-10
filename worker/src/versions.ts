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

/** System prompt de evaluación de señales (ai.ts).
    3.1.0: régimen de mercado, walk-forward del patrón y campo invalidation. */
export const PROMPT_VERSION = '3.1.0';

/** Prompt de reflexión sobre errores (learn.ts).
    1.1.0: casos con regime/mistakeType/cause y salida con taxonomía. */
export const REFLECT_PROMPT_VERSION = '1.1.0';

/** Estrategia global de scoring (scoring.ts: pesos y dimensiones).
    2.0.0: pesos adaptativos (scoring_weights), dimensión regime y
    multiplicador de salud del patrón (pattern_health). */
export const STRATEGY_VERSION = '2.0.0';
