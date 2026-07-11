# orion-markets-worker — pipeline de análisis FX en Cloudflare

Un solo Worker con un **Cloudflare Workflow** de 4 fases que se ejecuta cada hora
(cron `0 * * * *`). Workflows garantiza el orden entre fases, reintenta cada paso
con backoff y persiste el estado — no hacen falta varios workers coordinados.

```
cron (1 h)
  └─ OrionPipeline (Workflow)
       1. INGESTA     Twelve Data → D1 (EURUSD, GBPUSD, USDJPY ×
                      5min, 15min, 30min, 45min, 1h; incremental desde 2026-01-01,
                      espaciado 9 s/petición para el límite de 8 créditos/min)
       2. DETECCIÓN   algoritmos deterministas sobre TODO el histórico:
                      cruce EMA 20/50, divergencia RSI, envolventes, pin bar,
                      doble suelo/techo, banderas, ruptura de rango.
                      + resolución TP/SL de señales abiertas (backtesting continuo)
       3. IA          dossier de contexto (tendencia superior, EMA200, RSI, ATR,
                      volumen, correlaciones, histórico del patrón) → Workers AI.
                      Solo se invoca si la confianza determinista >= AI_MIN_CONFIDENCE:
                      el patrón fiable es la puerta; la IA valida, nunca inventa.
       4. SCORING     9 dimensiones 0-5 (trend, momentum, volumen, volatilidad,
                      macro, noticias, sentimiento, institucional, risk/reward)
                      → overall 0-100 con ajuste ±10 de la IA. Resumen en KV.
```

La detección recorre el histórico completo, así que también registra
compras/ventas **pasadas**, y cada ejecución resuelve si tocaron TP o SL —
la tasa de acierto por patrón se realimenta al dossier de la IA.

## Despliegue (primera vez)

```bash
cd worker
npm install
npx wrangler login

# 1. Crear recursos
npx wrangler d1 create orion-db          # → copiar database_id a wrangler.jsonc
npx wrangler kv namespace create CACHE   # → copiar id a wrangler.jsonc

# 2. Esquema
npm run db:remote

# 3. Secreto de Twelve Data (https://twelvedata.com — plan free vale)
npx wrangler secret put TWELVEDATA_API_KEY

# 4. Desplegar
npm run deploy

# 5. Primera ejecución sin esperar al cron
curl -X POST https://orion-markets-worker.<tu-subdominio>.workers.dev/api/run
```

El backfill desde 2026-01-01 converge en unas horas de ejecuciones
(máx. 2 páginas × 5000 velas por símbolo+intervalo y ejecución, ~720
créditos/día en el peor caso, dentro de los 800 del plan free).

## Desarrollo local

```bash
cp .dev.vars.example .dev.vars   # añade tu API key
npm run db:local
npm run dev                      # wrangler dev --test-scheduled
# cron local:  curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
npm run test                     # smoke test de la lógica pura
npm run typecheck
```

## API (para el frontend)

| Ruta                                                   | Descripción                                       |
| ------------------------------------------------------ | ------------------------------------------------- |
| `GET /api/health`                                      | estado + resumen de la última ejecución (KV)      |
| `GET /api/candles?symbol=EURUSD&interval=1h&limit=500` | velas OHLC                                        |
| `GET /api/signals?symbol=&interval=&limit=`            | señales (históricas y abiertas) con su evaluación |
| `GET /api/opportunities?limit=20`                      | mejores señales validadas por IA, por score       |
| `POST /api/run`                                        | dispara el pipeline manualmente                   |
| `GET /api/run/:id`                                     | estado de una instancia del workflow              |

Monitorización: `npm run tail`, o el panel de Workflows en el dashboard
(`npx wrangler workflows instances list orion-pipeline`).

## Variables

| Variable             | Dónde  | Uso                                                   |
| -------------------- | ------ | ----------------------------------------------------- |
| `TWELVEDATA_API_KEY` | secret | API key de Twelve Data                                |
| `TWELVEDATA_PLAN`    | vars   | plan de Twelve Data: `free`\|`grow`\|`pro`\|`expert`\|`enterprise`; marca ritmo y páginas de ingesta (`src/plans.ts`) |
| `CLOUDFLARE_WORKERS_PLAN` | vars | plan de Workers: `free`\|`paid`; en `free` se minimizan los puts de KV (1000/día) |
| `AI_MODEL`           | vars   | modelo de Workers AI (por defecto llama-3.3-70b fp8)  |
| `AI_MIN_CONFIDENCE`  | vars   | confianza determinista mínima para activar la IA (65) |
| `AI_MAX_PER_RUN`     | vars   | señales evaluadas por IA por ejecución (8)            |

## Pendiente / siguiente fase

- Proveedor de **noticias** y **sentimiento** reales (los campos ya viajan en el
  dossier como `null`; la IA puntúa neutral 3 mientras tanto).
- Archivado de históricos fríos a **R2** cuando D1 crezca.
- WebSocket / Durable Object para empujar señales nuevas al frontend.
- Conectar la UI de `../src` a `/api/*` (sustituir `src/data/market.ts`).
