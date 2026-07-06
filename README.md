# Orion Markets — Terminal FX

Plataforma de análisis Forex con identidad propia ("Orion": constelación / terminal profundo).
Esta fase es **solo diseño visual**: todos los datos son simulados de forma determinista en el
cliente. La infraestructura real irá sobre Cloudflare (Workers, D1, R2, KV, Workers AI).

## Ejecutar

```bash
npm install
npm run dev      # http://localhost:5173
```

## Qué incluye

- **Gráfico principal** con Highcharts Stock: velas / OHLC / línea / área, volumen coloreado
  por dirección, EMA 20/50, panel RSI 14, crosshair con etiquetas, navegador de rango y
  línea de último precio.
- **Temporalidades** M1 · M5 · M15 · M30 · H1 · H4 · D1 · W1 (series generadas por par + TF).
- **Watchlist** con sparklines, grupos (Mayores/Menores/Exóticos) y búsqueda.
- **Estrategias activables** (panel derecho): cards con interruptor, riesgo, % acierto,
  profit factor y curva de resultados.
- **Orion AI**: escáner de patrones simulado con señales (patrón, confianza, entrada/SL/TP,
  R:R). «Ver en gráfico» pinta banderas y niveles sobre el chart.
- **Tabla de oportunidades** detectadas por el escáner (panel inferior).
- Sesiones de mercado en vivo (Sídney/Tokio/Londres/NY) y reloj UTC en la barra superior.

## Identidad

- Tokens en `src/index.css` (fondo `#070a10`, panel `#10151f`, ámbar estelar `#f0b429`,
  nebulosa IA `#8b7cf6`, compra `#2bab63`, venta `#e5484d`).
- Tipografía: Space Grotesk (UI) + JetBrains Mono (datos).
- Paleta de series del gráfico validada para daltonismo y contraste sobre superficie oscura.
- Tema Highcharts en `src/charts/orionTheme.ts` (espejo de los tokens).

## Estructura

```
src/
  data/market.ts        # pares, velas (RNG con semilla), señales IA, estrategias
  charts/orionTheme.ts  # tema global de Highcharts
  components/           # TopBar, Watchlist, ChartPanel, MainChart, SidePanel,
                        # StrategyPanel, AIPanel, BottomPanel, Sparkline, icons
```

## Siguiente fase (Cloudflare)

- Workers + Hono para la API de precios y señales.
- D1 (estrategias, historial), KV (cotizaciones calientes), R2 (históricos OHLC).
- Workers AI / modelo propio para el escáner de patrones real.
- Durable Objects / WebSockets para streaming de ticks.
