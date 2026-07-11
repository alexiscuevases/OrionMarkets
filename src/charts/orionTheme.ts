import Highcharts from 'highcharts/highstock';
import 'highcharts/indicators/indicators'; // incluye SMA + EMA
import 'highcharts/indicators/rsi';
import 'highcharts/modules/accessibility';

/* Tema Orion para Highcharts — espejo de los tokens de src/index.css.
   Highcharts no lee variables CSS por sí solo, así que los tokens se
   copian aquí desde getComputedStyle; applyOrionTheme() se vuelve a
   llamar al cambiar de tema (src/theme.ts) para refrescarlos. */

export const ORION = {
  surface: '#10151f',
  raised: '#161d2b',
  gridLine: '#1b2231',
  hairline: 'rgba(148, 170, 210, 0.10)',
  strongLine: 'rgba(148, 170, 210, 0.20)',
  inkHi: '#eef2f9',
  inkMid: '#9aa7bd',
  inkLow: '#5c6880',
  star: '#f0b429',
  nebula: '#8b7cf6',
  nebulaInk: '#b9affb',
  buy: '#2bab63',
  buyInk: '#4cc38a',
  sell: '#e5484d',
  sellInk: '#f2726f',
  series1: '#2b9fd8',
  series2: '#c98500',
  series3: '#8b7cf6',
  series4: '#d55181',
  fontUI: "'Space Grotesk', system-ui, sans-serif",
  fontData: "'JetBrains Mono', ui-monospace, monospace",
};

/** Token de ORION → variable CSS de la que se copia su valor. */
const TOKEN_VARS: Record<string, string> = {
  surface: '--bg-panel',
  raised: '--bg-raised',
  gridLine: '--line-grid',
  hairline: '--line-hair',
  strongLine: '--line-strong',
  inkHi: '--ink-hi',
  inkMid: '--ink-mid',
  inkLow: '--ink-low',
  star: '--star',
  nebula: '--nebula',
  nebulaInk: '--nebula-ink',
  buy: '--buy',
  buyInk: '--buy-ink',
  sell: '--sell',
  sellInk: '--sell-ink',
  series1: '--series-1',
  series2: '--series-2',
  series3: '--series-3',
  series4: '--series-4',
};

function readTokens(): void {
  const style = getComputedStyle(document.documentElement);
  for (const [token, cssVar] of Object.entries(TOKEN_VARS)) {
    const value = style.getPropertyValue(cssVar).trim();
    if (value) (ORION as Record<string, string>)[token] = value;
  }
}

export function applyOrionTheme(): void {
  readTokens();

  Highcharts.setOptions({
    lang: {
      months: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio',
        'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
      shortMonths: ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago',
        'Sep', 'Oct', 'Nov', 'Dic'],
      weekdays: ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'],
    },
    chart: {
      backgroundColor: 'transparent',
      style: { fontFamily: ORION.fontUI },
      animation: false,
      spacing: [8, 4, 4, 4],
    },
    title: { text: undefined },
    credits: {
      style: { color: ORION.inkLow, fontSize: '9px' },
    },
    xAxis: {
      lineColor: ORION.hairline,
      tickColor: ORION.hairline,
      gridLineColor: ORION.gridLine,
      labels: {
        style: { color: ORION.inkLow, fontSize: '10px', fontFamily: ORION.fontData },
      },
      crosshair: {
        color: ORION.strongLine,
        dashStyle: 'Dash',
        label: {
          enabled: true,
          backgroundColor: ORION.raised,
          borderColor: ORION.strongLine,
          borderWidth: 1,
          borderRadius: 4,
          style: { color: ORION.inkHi, fontSize: '10px', fontFamily: ORION.fontData },
          padding: 5,
        },
      },
    },
    yAxis: {
      gridLineColor: ORION.gridLine,
      lineColor: 'transparent',
      tickColor: 'transparent',
      labels: {
        style: { color: ORION.inkLow, fontSize: '10px', fontFamily: ORION.fontData },
      },
    },
    tooltip: {
      backgroundColor: ORION.raised,
      borderColor: ORION.strongLine,
      borderRadius: 10,
      shadow: false,
      style: { color: ORION.inkHi, fontSize: '11px' },
      useHTML: true,
    },
    legend: {
      itemStyle: { color: ORION.inkMid, fontSize: '10px', fontWeight: '500' },
      itemHoverStyle: { color: ORION.inkHi },
    },
    navigator: {
      height: 34,
      margin: 12,
      maskFill: 'rgba(43, 159, 216, 0.10)',
      outlineColor: ORION.hairline,
      handles: {
        backgroundColor: ORION.raised,
        borderColor: ORION.strongLine,
      },
      series: {
        color: ORION.series1,
        lineWidth: 1,
        fillOpacity: 0.06,
      },
      xAxis: {
        gridLineColor: ORION.gridLine,
        labels: { style: { color: ORION.inkLow, fontSize: '9px' } },
      },
    },
    scrollbar: { enabled: false },
    rangeSelector: { enabled: false },
  });
}

export default Highcharts;
