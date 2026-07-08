# README_PRODUCTION — Orion Markets

Guía de operación en producción. Complementa a `PRODUCTION_READINESS.md`
(auditoría y decisiones) y a los README de cada paquete.

---

## 1. Arquitectura

```
Cloudflare Pages (frontend React)          Cloudflare Worker (orion-markets-worker)
┌──────────────────────────────┐            ┌─────────────────────────────────────────┐
│ Vite + React 19 + Highcharts │── fetch ──▶│ API JSON (rate-limited + admin auth)     │
│ polling 60 s                 │            │                                          │
└──────────────────────────────┘            │ cron 15 min ─▶ OrionPipeline (Workflow)  │
                                            │  1 INGESTA    Twelve Data → D1           │
     Recursos Cloudflare                    │  2 DETECCIÓN  7 detectores + TP/SL       │
     ────────────────────                   │  3 IA         dossier → Workers AI       │
     D1     orion-db (SQL)                  │  3c RE-EVAL   señales abiertas           │
     KV     CACHE (resúmenes, locks, RL)    │  4 SCORING    10 dimensiones → 0-100     │
     Vectorize orion-cases (memoria)        │  4b PAPER     cuenta virtual TP/SL       │
     Workers AI (llama 3.3 70B + bge-m3)    │  5 APRENDIZAJE Vectorize + lecciones     │
                                            └─────────────────────────────────────────┘
```

**Tablas D1**: `candles`, `sync_state`, `signals`, `evaluations`,
`evaluation_history` (auditoría append-only), `lessons`, `ai_calls`
(telemetría IA), `pipeline_runs` (observabilidad), `backtests`,
`paper_accounts/orders/positions/trades`, `market_events` (calendario).

**Separación live/simulación**: los backtests nunca escriben en
`signals`/`evaluations`; el paper trading solo lee señales y escribe en sus
propias tablas.

**Versionado**: cada señal guarda `detector_version` y cada evaluación
`prompt_version` + `model` (ver `worker/src/versions.ts`). Al cambiar un
detector o un prompt **hay que subir la versión** — la calibración y las
estadísticas dependen de poder separar datos de versiones distintas.

## 2. Instalación y despliegue

```bash
# Frontend
npm install
npm run build          # tsc + vite
npm run deploy         # wrangler pages deploy dist

# Worker
cd worker
npm install
npx wrangler login

# Recursos (primera vez)
npx wrangler d1 create orion-db                 # → database_id a wrangler.jsonc
npx wrangler kv namespace create CACHE          # → id a wrangler.jsonc
npx wrangler vectorize create orion-cases --dimensions=1024 --metric=cosine

# Esquema (5 migraciones)
npm run db:remote

# Secretos
npx wrangler secret put TWELVEDATA_API_KEY
npx wrangler secret put ADMIN_API_KEY           # openssl rand -hex 32

npm run deploy
```

Desarrollo local: copiar `worker/.dev.vars.example` → `.dev.vars`,
`npm run db:local`, `npm run dev` (worker) y `npm run dev` (frontend con
`VITE_API_URL=http://localhost:8787`).

## 3. Variables de entorno (worker/wrangler.jsonc)

| Variable | Default | Descripción |
|---|---|---|
| `AI_MODEL` | llama-3.3-70b-fp8-fast | Modelo de evaluación |
| `AI_MIN_CONFIDENCE` | 65 | Confianza determinista mínima para invocar IA |
| `AI_MAX_PER_RUN` / `AI_MAX_REEVAL` | 8 / 4 | Presupuesto IA por run |
| `ALLOWED_ORIGINS` | `*` | CORS; en producción, el dominio del frontend |
| `AI_COST_IN_PER_M` / `AI_COST_OUT_PER_M` | 0.29 / 2.25 | Tarifas USD/M tokens para el coste estimado |
| `PAPER_INITIAL_BALANCE` / `PAPER_RISK_PCT` / `PAPER_MIN_SCORE` | 10000 / 1 / 65 | Cuenta paper por defecto |

Secretos: `TWELVEDATA_API_KEY`, `ADMIN_API_KEY` (sin él, los endpoints admin
devuelven 503 — cerrado por defecto).

## 4. API

Endpoints públicos (**rate limit 120 req/min/IP**):

| Endpoint | Descripción |
|---|---|
| `GET /api/health` | Salud completa: pipeline, frescura de datos, IA, vector (caché 60 s) |
| `GET /api/runs` | Historial de ejecuciones del pipeline |
| `GET /api/candles?symbol=&interval=&limit=` | Velas OHLC |
| `GET /api/signals?symbol=&interval=` | Señales + evaluación IA |
| `GET /api/audit?sigKey=` | Auditoría de una señal: historial de veredictos + llamadas IA |
| `GET /api/opportunities` | Mejores señales abiertas puntuadas |
| `GET /api/strategies?days=` | Rendimiento real por patrón |
| `GET /api/market-state` | Tendencia/volatilidad/RSI por símbolo + próximo evento macro |
| `GET /api/events?symbol=` | Calendario económico próximo |
| `GET /api/learning` | Lecciones, calibración IA, progreso de memoria |
| `GET /api/risk/position-size?symbol=&balance=&riskPct=&entry=&stop=` | Cálculo de tamaño de posición |
| `GET /api/paper/account` · `GET /api/paper/trades` | Cuenta paper: posiciones, stats, equity |
| `GET /api/backtests` · `GET /api/backtests/:id` | Backtests guardados |

Endpoints de administración (**`Authorization: Bearer <ADMIN_API_KEY>`**):

| Endpoint | Descripción |
|---|---|
| `POST /api/run` | Dispara el pipeline (409 si ya hay uno en curso) |
| `GET /api/run/:id` | Estado de una instancia del Workflow |
| `POST /api/backtest` | Ejecuta un backtest: `{symbol, interval, from, to, patterns?, minConfidence?, initialBalance?, riskPct?}` |
| `POST /api/paper/reset` | Resetea la cuenta paper (`{initialBalance?, riskPct?, minScore?}`) |
| `POST /api/admin/events` | Carga eventos del calendario: `{events: [{ts, currency, impact, title, forecast?…}]}` |
| `GET /api/admin/metrics` | Dashboard interno: salud, IA 7 días, tamaño de tablas, versiones |
| `GET /api/dataset` | Dataset etiquetado (material de fine-tuning) |

Ejemplo de backtest:

```bash
curl -X POST https://<worker>/api/backtest \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"symbol":"EURUSD","interval":"1h","from":"2026-02-01","to":"2026-06-30","riskPct":1}'
```

Devuelve: total trades, win rate, profit factor, expectancy (R), avg RR,
max drawdown (R y %), equity curve, rendimiento mensual, mejor/peor patrón.
Usa **exactamente** el detector live (`detectAll` + `resolveOutcome`) con
corte duro en `to` (sin look-ahead; hay test de regresión que lo verifica).

## 5. Seguridad

- Endpoints mutantes/caros tras `ADMIN_API_KEY` (comparación en tiempo constante).
- Rate limiting KV por IP (ventana fija 60 s; best-effort — para un ataque
  dirigido, añadir WAF/Durable Objects).
- CORS restringible por `ALLOWED_ORIGINS`.
- Lock de pipeline en KV: el cron se salta el tick si hay un run en curso
  (evita competir por los 8 créditos/min de Twelve Data); `/api/run` devuelve 409.
- Validación de inputs en todos los endpoints; body JSON limitado a 256 KB;
  errores internos devuelven 500 genérico sin filtrar detalles.
- **Pendiente (P2)**: autenticación de usuarios finales multi-tenant
  (Cloudflare Access / Clerk / D1 propio) — decisión de producto.

## 6. Observabilidad

- `GET /api/health`: semáforo global (`ok`) + detalle de pipeline (último
  éxito/error, duración), datos (última vela por mercado, staleness con
  tolerancia de fin de semana), IA (llamadas/errores/coste 24 h) y vector.
- `pipeline_runs`: cada ejecución con estado, error y contadores;
  las saltadas por lock quedan como `skipped`.
- `ai_calls`: latencia, tokens y coste por llamada (retención 30 días).
- `wrangler tail` para logs en vivo; `observability.enabled` ya activo.
- Alerta recomendada: monitor externo (p. ej. cron de Better Uptime) sobre
  `/api/health` comprobando `ok: true`.

## 7. Mantenimiento

| Tarea | Frecuencia | Cómo |
|---|---|---|
| Revisar `/api/admin/metrics` | semanal | costes IA, tablas, errores |
| Backup D1 | — | D1 Time Travel (30 días) incluido; export puntual: `wrangler d1 export orion-db --remote` |
| Poda `ai_calls` | automática | el pipeline borra > 30 días |
| Subir versión detector/prompt | al cambiar lógica | `worker/src/versions.ts` + reset de derivados si cambian niveles (patrón migración 0002) |
| Añadir símbolo/intervalo | según plan Twelve Data | `worker/src/types.ts` (SYMBOLS/INTERVALS) + revisar cuota del cron |
| Calendario económico | diario/semanal | `POST /api/admin/events` desde el proveedor elegido |

## 8. Troubleshooting

| Síntoma | Diagnóstico | Acción |
|---|---|---|
| `health.pipeline.ok = false` | sin run exitoso en 2 h | `GET /api/runs` → error del último run; `wrangler tail` |
| Mercados `stale` en health | ingesta parada | revisar cuota Twelve Data (800/día); el cursor se recupera solo |
| Muchos `skipped` en runs | pipelines lentos solapando el cron | normal con backfill; si persiste, revisar latencia Twelve Data |
| `ai.ok = false` | > 30 % errores IA 24 h | modelo caído/renombrado → probar otro `AI_MODEL` |
| 429 en la API pública | rate limit | subir `PUBLIC_RATE_LIMIT` (index.ts) o cachear en el cliente |
| 503 en endpoints admin | falta `ADMIN_API_KEY` | `wrangler secret put ADMIN_API_KEY` |
| Backtest 422 | histórico insuficiente | esperar backfill (ver `/api/health` freshness) |
| Paper sin operaciones | score < `PAPER_MIN_SCORE` o señales viejas | ver `paper_orders` (motivos de rechazo auditados) |

## 9. Costes estimados (universo actual: 3 símbolos × 5 intervalos)

| Recurso | Uso | Coste |
|---|---|---|
| Twelve Data free | ~360 req/día de 800 | $0 (el límite real para escalar) |
| Workers (plan Paid recomendado) | cron + API | $5/mes base |
| Workers AI | ≤ ~50 evaluaciones/día × ~3k tokens | ~$0.2-1/mes (medido en `ai_calls`) |
| D1 | lecturas dominadas por detección | free tier hoy; vigilar `admin/metrics` |
| KV / Vectorize / Workflows | resúmenes, RL, embeddings | free tier |

Escalar símbolos multiplica la ingesta (cuota Twelve Data) y la detección
(filas D1): ver P1-3/P2-6 en `PRODUCTION_READINESS.md` antes de crecer.

## 10. Tests

```bash
cd worker
npm run typecheck
npm test            # smoke (detectores, scoring, SMC) + unit (indicadores,
                    # riesgo, backtest anti-look-ahead, regresión, eventos)
```

El test de regresión fija un snapshot del detector sobre un dataset
sintético determinista: si cambia sin haber tocado los detectores, algo se
rompió; si los cambiaste a propósito, sube `DETECTOR_VERSION` y actualiza
el snapshot.
