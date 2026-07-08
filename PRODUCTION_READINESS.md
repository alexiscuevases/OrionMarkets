# PRODUCTION_READINESS — Auditoría Orion Markets

> Fecha: 2026-07-08 · Auditor: revisión completa del repositorio (frontend + worker)
> Alcance: arquitectura, datos, seguridad, costes, escalabilidad, fiabilidad, UX.

---

## 1. Estado actual

### Arquitectura

```
Frontend (Vite + React 19 + Highcharts)  →  Cloudflare Pages
        │  fetch JSON (polling 60 s)
        ▼
Worker (orion-markets-worker)
  ├─ fetch: API JSON de solo lectura + POST /api/run
  ├─ scheduled: cron cada 15 min → crea instancia del Workflow
  └─ OrionPipeline (Cloudflare Workflow, 5 fases)
       1. INGESTA     Twelve Data → D1 (incremental, cursor por símbolo+intervalo)
       2. DETECCIÓN   7 detectores deterministas sobre todo el histórico + resolución TP/SL
       3. IA          dossier + gate por expectancia + memoria vectorial → Workers AI
       3c. RE-EVAL    re-evaluación de señales abiertas con dossier al presente
       4. SCORING     10 dimensiones ponderadas 0-100, ajuste IA calibrado
       5. APRENDIZAJE Vectorize (memoria de casos) + reflexión sobre errores → lecciones

Almacenamiento: D1 (candles, signals, evaluations, lessons, sync_state),
                KV (cache de resúmenes), Vectorize (embeddings bge-m3)
```

### Lo que está bien (no tocar a la ligera)

- **Pipeline como Workflow único**: orden garantizado, retry por paso con backoff,
  estado persistido. Diseño correcto para Cloudflare.
- **Idempotencia real**: `sig_key = symbol|interval|ts|pattern` + `INSERT OR IGNORE`;
  cursores de ingesta con semántica correcta para huecos de fin de semana.
- **Sin look-ahead bias en la evaluación**: `buildContext` corta las velas en `asOf`;
  los detectores nunca confirman sobre la última vela (puede estar en formación);
  `resolveOutcome` es conservador (si TP y SL caben en la misma vela, gana SL).
- **Aprendizaje con fundamento**: calibración empírica de la confianza IA por tramos,
  gate por expectancia real, lecciones destiladas de errores reales.
- **Batching D1 correcto**: inserts de 12 filas/sentencia, lotes de 40 sentencias.
- **Parseo defensivo del veredicto IA**: clamps, la IA no puede invertir la dirección,
  fallo de formato → retry del step, no un skip persistido.

---

## 2. Riesgos y problemas encontrados

### P0 — Críticos (bloquean un lanzamiento con usuarios reales)

| # | Problema | Detalle | Impacto |
|---|----------|---------|---------|
| P0-1 | **`POST /api/run` sin autenticación** | Cualquiera puede disparar el pipeline. Cada run consume cuota Twelve Data (800 req/día), cuota Workers AI y CPU. | Denegación de servicio por agotamiento de cuota; coste. |
| P0-2 | **Cero autenticación/autorización** | Todos los endpoints son públicos, incluido `/api/dataset` (datos de entrenamiento) y `/api/learning`. CORS `*`. | Cualquier web puede consumir la API; scraping; abuso. |
| P0-3 | **Sin rate limiting** | Ningún límite por IP/cliente. `/api/candles?limit=5000` y `/api/market-state` (miss de caché = 1.200 filas + cálculo) son caros. | Amplificación de coste D1/CPU; caída bajo carga. |
| P0-4 | **Instancias de Workflow concurrentes** | Cron cada 15 min + `/api/run` manual sin lock. Dos pipelines simultáneos comparten el límite de 8 créditos/min de Twelve Data → cascada de 429 y reintentos. | Runs fallidos, datos parciales, agujeros de ingesta. |
| P0-5 | **Sin observabilidad de fallos** | Solo se guarda `pipeline:last_run` (el último éxito) en KV. Un pipeline que falla no deja rastro consultable; no hay historial de runs, ni errores por paso, ni detección de gaps de datos. | Fallos silenciosos: el sistema puede llevar días sin ingerir y nadie lo sabe. |
| P0-6 | **Sin tracking de la IA** | No se registra latencia, tokens, coste ni tasa de error de llamadas a Workers AI. No hay versionado de prompts: cambiar el prompt invalida silenciosamente la calibración y las lecciones acumuladas. | Imposible auditar por qué la IA decidió algo, ni atribuir degradaciones a un cambio de prompt/modelo. |

### P1 — Importantes (degradan calidad/operación)

| # | Problema | Detalle |
|---|----------|---------|
| P1-1 | **Historial de evaluaciones destruido** | `INSERT OR REPLACE INTO evaluations` en cada re-evaluación pisa el veredicto anterior. Solo queda `revision` (contador). Sin historial no se puede auditar la evolución del juicio IA ni entrenar con él. |
| P1-2 | **Índices D1 incompletos** | `/api/strategies` y `/api/dataset` filtran por `outcome_ts` sin índice; `getReevaluableSignals` ordena por `COALESCE(updated_at, created_at)` sin índice. Con cientos de miles de señales serán full scans. |
| P1-3 | **`detectAll` re-procesa todo el histórico cada run** | `loadCandles(…, 50_000)` + detección completa por símbolo+intervalo cada 15 min. Coste D1 (filas leídas) y CPU crece linealmente con el histórico. Funciona hoy; no escala a más símbolos/años. |
| P1-4 | **Frontend traga errores** | Todos los loaders hacen `catch → EMPTY/null`. Un fallo de API es indistinguible de "no hay datos". Sin estados de error ni reintento visible. |
| P1-5 | **Sin tests de indicadores ni de riesgo** | `smoke.ts` es bueno pero no cubre `ema/rsi/atr` con casos borde (series cortas, NaN), ni existe módulo de riesgo. No hay CI. |
| P1-6 | **Sin backtesting ni paper trading** | La detección histórica + resolución TP/SL es un backtest continuo implícito, pero no hay motor consultable (rango de fechas, métricas, equity curve) ni simulación de cuenta. |
| P1-7 | **`news`/`sentiment` siempre null** | El prompt pide a la IA valorar noticias sin datos → `newsScore` es ruido con peso 0.8 en el scoring. |
| P1-8 | **Cliente Twelve Data sin timeout** | `fetch` sin `AbortSignal`; un cuelgue del proveedor consume el timeout del step completo (2 min). |
| P1-9 | **`/api/run/:id` expone estado interno sin auth** | Enumeración de UUIDs improbable, pero el endpoint de estado no debería ser público. |
| P1-10 | **Sin límites de tamaño de payload/validación estricta** | `limit` se acota, pero no hay validación central; los endpoints nuevos la necesitarán desde el diseño. |

### P2 — Mejoras futuras

| # | Mejora |
|---|--------|
| P2-1 | Multi-tenancy real (usuarios, cuentas, planes) — requiere D1 por tenant o claves de partición. |
| P2-2 | Streaming de precios (Durable Objects + WebSockets) en lugar de polling de 60 s. |
| P2-3 | Fine-tuning LoRA con el dataset etiquetado (ya previsto en `/api/dataset`). |
| P2-4 | Archivado de velas antiguas a R2 (D1 tiene límite de 10 GB). |
| P2-5 | Proveedor real de calendario económico (la capa de contexto queda preparada). |
| P2-6 | Detección incremental (solo velas nuevas) con ventana de solape, cuando el universo crezca. |
| P2-7 | Dashboard admin visual (los datos quedan expuestos vía `/api/admin/metrics`). |

### Costes (estimación actual)

- **Twelve Data free**: ~360 req/día de cron (límite 800) — sin margen para más símbolos.
- **Workers AI**: ≤ 12 evaluaciones + 4 re-evaluaciones por run × 96 runs/día máx teórico,
  en la práctica acotado por señales nuevas. Sin tracking, el coste real es una incógnita → P0-6.
- **D1**: lecturas dominadas por `detectAll` (50k filas × 15 combinaciones × 96 runs/día
  potenciales). Es el primer coste que explotará al escalar → P1-3.
- **Workers/Workflows/KV/Vectorize**: dentro de free tier con el universo actual.

### Puntos críticos de fallo

1. Twelve Data caído/limitado → ingesta se detiene. Mitigado por retries; sin alerta (P0-5).
2. Workers AI degradado → evaluaciones fallan; mitigado (skip conservador / conserva veredicto).
3. D1 no disponible → todo cae; sin circuito de degradación en frontend (P1-4).
4. Workflow colgado/solapado → P0-4.

---

## 3. Plan de implementación (este repositorio)

| Fase | Contenido | Prioridad |
|------|-----------|-----------|
| 2 | Motor de backtesting (mismo detector, sin look-ahead) + `POST /api/backtest` + tabla `backtests` | P1-6 |
| 3 | Paper trading: `paper_accounts/positions/trades`, ejecución desde señales validadas, resolución TP/SL en pipeline | P1-6 |
| 4 | Módulo de riesgo puro (`risk.ts`): position size, lot size, exposición máxima + endpoint | P1 |
| 5 | Capa de contexto de mercado: tabla `market_events`, integración en dossier, warnings | P1-7 |
| 6 | IA hardening: `ai_calls` (latencia, tokens, coste, error), `PROMPT_VERSION`, auditoría de decisiones | P0-6 |
| 7 | Observabilidad: tabla `pipeline_runs`, `/api/health` ampliado (gaps, staleness, IA, vector), `/api/admin/metrics` | P0-5 |
| 8 | Seguridad: `ADMIN_API_KEY` para endpoints mutantes/sensibles, rate limiting KV por IP, CORS configurable, lock de pipeline | P0-1..4 |
| 9 | Migración D1: índices que faltan, tablas nuevas, retención de `ai_calls` | P1-2 |
| 10 | Tests: unit (indicadores, riesgo, backtest, paper), regresión con dataset sintético determinista | P1-5 |
| 11 | Versionado: `DETECTOR_VERSION`, `PROMPT_VERSION`, `STRATEGY_VERSION` persistidos en señales/evaluaciones | P0-6 |
| 12 | UX: estados de error, casos similares e info de riesgo en el análisis de señal | P1-4 |
| 13 | `README_PRODUCTION.md` | — |

**Decisiones tomadas** (criterio estabilidad > features):

- La autenticación de esta fase es **API key de administrador** (secret de Worker) para
  endpoints mutantes/sensibles + rate limiting para el resto. La autenticación de usuarios
  finales (multi-tenant, sesiones, planes) es P2-1: requiere decisión de producto
  (Cloudflare Access, Clerk, D1 propio) y no se improvisa en esta pasada.
- El historial de evaluaciones (P1-1) se preserva a partir de ahora en una tabla
  `evaluation_history` (append-only) sin cambiar el contrato actual de `evaluations`.
- La detección completa por run (P1-3) se mantiene: es correcta y el universo actual la
  soporta; se documenta como límite de escala con su mitigación (P2-6).
