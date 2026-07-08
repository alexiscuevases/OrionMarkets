import { useEffect, useRef } from 'react';
import Highcharts, { ORION, applyOrionTheme } from '../charts/orionTheme';
import { computeSmc, drawSmc } from '../charts/smc';
import {
  pairBySymbol, fmtDateTime,
  type AISignal, type SeriesData,
} from '../data/market';

applyOrionTheme();

export type ChartKind = 'candlestick' | 'ohlc' | 'line' | 'area';

/** Indicadores superpuestos al gráfico, activables uno a uno. */
export interface Indicators {
  ema20: boolean;
  ema50: boolean;
  rsi14: boolean;
}

interface Props {
  symbol: string;
  tf: string;
  kind: ChartKind;
  showSignals: boolean;
  showSmc: boolean;
  indicators: Indicators;
  activeSignal: AISignal | null;
  series: SeriesData;
  signals: AISignal[];
}

export default function MainChart({
  symbol, tf, kind, showSignals, showSmc, indicators, activeSignal, series, signals,
}: Props) {
  const { ema20, ema50, rsi14 } = indicators;
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Highcharts.Chart | null>(null);

  useEffect(() => {
    if (!ref.current) return;

    const pair = pairBySymbol(symbol);
    const { candles, volume } = series;
    if (candles.length < 2) return;
    const last = candles[candles.length - 1];
    const lastUp = last[4] >= last[1];
    const stepMs = candles[1][0] - candles[0][0];

    // forex real no trae volumen (Twelve Data lo da a 0) → sin panel
    const hasVolume = volume.some(([, v]) => v > 0);

    // el volumen hereda la dirección de su vela
    const volumeData = volume.map(([t, v], i) => ({
      x: t,
      y: v,
      color: candles[i][4] >= candles[i][1]
        ? 'rgba(43, 171, 99, 0.35)'
        : 'rgba(229, 72, 77, 0.35)',
    }));

    // en modo foco solo se dibuja la señal activa; el resto ensucia la lectura
    const visibleSignals = activeSignal ? [activeSignal] : signals;

    // capa Smart Money: zonas institucionales, liquidez y movimiento
    // probable; con señal en foco la proyección hereda su dirección
    const smc = showSmc
      ? computeSmc(
          candles,
          pair.pip,
          activeSignal && activeSignal.outcome === 'open' ? activeSignal.direction : null,
        )
      : null;

    const outcomeLabel = (s: AISignal): string => {
      const pips =
        s.resultPips !== undefined
          ? ` · ${s.resultPips >= 0 ? '+' : ''}${s.resultPips} pips`
          : '';
      switch (s.outcome) {
        case 'tp_hit': return `<span style="color:${ORION.buyInk}">TP alcanzado${pips}</span>`;
        case 'sl_hit': return `<span style="color:${ORION.sellInk}">SL tocado${pips}</span>`;
        case 'expired': return 'Expirada sin tocar TP/SL';
        default: return `<span style="color:${ORION.star}">Activa</span>`;
      }
    };

    const flagPoints = (dir: 'buy' | 'sell') =>
      visibleSignals
        .filter((s) => s.direction === dir)
        .map((s) => ({
          x: s.time,
          title: dir === 'buy' ? '▲' : '▼',
          text: `<b>${s.pattern}</b><br/>Confianza ${s.confidence}% · ${fmtDateTime(s.time)}<br/>${outcomeLabel(s)}`,
        }));

    const priceHeight = rsi14 ? (hasVolume ? '56%' : '68%') : hasVolume ? '78%' : '96%';
    const volTop = rsi14 ? '58%' : '80%';
    const rsiAxisIndex = hasVolume ? 2 : 1;

    const signalPlotLines: Highcharts.YAxisPlotLinesOptions[] = activeSignal
      ? [
          {
            value: activeSignal.entry, color: ORION.star, width: 1, dashStyle: 'Dash', zIndex: 4,
            label: { text: 'ENTRADA', align: 'left', x: 8, style: { color: ORION.star, fontSize: '9px', fontFamily: ORION.fontData } },
          },
          {
            value: activeSignal.stop, color: ORION.sell, width: 1, dashStyle: 'Dot', zIndex: 4,
            label: { text: 'SL', align: 'left', x: 8, style: { color: ORION.sellInk, fontSize: '9px', fontFamily: ORION.fontData } },
          },
          {
            value: activeSignal.target, color: ORION.buy, width: 1, dashStyle: 'Dot', zIndex: 4,
            label: { text: 'TP', align: 'left', x: 8, style: { color: ORION.buyInk, fontSize: '9px', fontFamily: ORION.fontData } },
          },
        ]
      : [];

    const priceSeries: Highcharts.SeriesOptionsType =
      kind === 'candlestick' || kind === 'ohlc'
        ? {
            type: kind,
            id: 'price',
            name: symbol,
            data: candles,
            color: ORION.sell,
            upColor: ORION.buy,
            lineColor: ORION.sell,
            upLineColor: ORION.buy,
            showInLegend: false,
          }
        : {
            type: kind,
            id: 'price',
            name: symbol,
            data: candles.map((c) => [c[0], c[4]]),
            color: ORION.series1,
            lineWidth: 1.6,
            showInLegend: false,
            ...(kind === 'area' && {
              fillColor: {
                linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
                stops: [
                  [0, 'rgba(43, 159, 216, 0.22)'],
                  [1, 'rgba(43, 159, 216, 0)'],
                ] as [number, string][],
              },
            }),
          };

    const chartSeries: Highcharts.SeriesOptionsType[] = [priceSeries];

    if (hasVolume) {
      chartSeries.push({
        type: 'column',
        id: 'volume',
        name: 'Volumen',
        data: volumeData,
        yAxis: 1,
        borderWidth: 0,
        showInLegend: false,
      });
    }

    if (ema20) {
      chartSeries.push({
        type: 'ema', linkedTo: 'price', params: { period: 20 },
        name: 'EMA 20', color: ORION.series1, lineWidth: 1.4,
        marker: { enabled: false },
      });
    }

    if (ema50) {
      chartSeries.push({
        type: 'ema', linkedTo: 'price', params: { period: 50 },
        name: 'EMA 50', color: ORION.series2, lineWidth: 1.4,
        marker: { enabled: false },
      });
    }

    if (rsi14) {
      chartSeries.push({
        type: 'rsi', linkedTo: 'price', yAxis: rsiAxisIndex,
        name: 'RSI 14', color: ORION.series3, lineWidth: 1.4,
        marker: { enabled: false },
      });
    }

    // la bandera de la señal activa se muestra aunque los patrones estén ocultos
    if (showSignals || activeSignal) {
      chartSeries.push(
        {
          type: 'flags',
          name: 'Señales compra',
          data: flagPoints('buy'),
          onSeries: 'price',
          shape: 'squarepin',
          width: 18,
          fillColor: ORION.buy,
          color: ORION.buy,
          lineColor: ORION.buy,
          y: -34,
          style: { color: '#ffffff', fontSize: '9px' },
          states: { hover: { fillColor: ORION.buyInk } },
          showInLegend: false,
        },
        {
          type: 'flags',
          name: 'Señales venta',
          data: flagPoints('sell'),
          onSeries: 'price',
          shape: 'squarepin',
          width: 18,
          fillColor: ORION.sell,
          color: ORION.sell,
          lineColor: ORION.sell,
          y: -34,
          style: { color: '#ffffff', fontSize: '9px' },
          states: { hover: { fillColor: ORION.sellInk } },
          showInLegend: false,
        },
      );
    }

    const yAxes: Highcharts.YAxisOptions[] = [
      {
        // precio — etiquetas fuera del área de velas para que no las pise la serie
        height: priceHeight,
        labels: { align: 'left', x: 8, format: `{value:.${pair.decimals}f}` },
        crosshair: {
          color: ORION.strongLine,
          dashStyle: 'Dash',
          snap: false,
          label: {
            enabled: true,
            backgroundColor: ORION.raised,
            borderColor: ORION.strongLine,
            borderWidth: 1,
            borderRadius: 4,
            format: `{value:.${pair.decimals}f}`,
            style: { color: ORION.inkHi, fontSize: '10px', fontFamily: ORION.fontData },
            padding: 5,
          },
        },
        plotLines: [
          {
            // línea de último precio
            value: last[4],
            color: lastUp ? ORION.buy : ORION.sell,
            width: 1,
            dashStyle: 'Dash',
            zIndex: 5,
            label: {
              text: last[4].toFixed(pair.decimals),
              align: 'right',
              textAlign: 'left',
              x: 6,
              y: 3,
              useHTML: true,
              style: {
                color: '#ffffff',
                fontSize: '9px',
                fontFamily: ORION.fontData,
                backgroundColor: lastUp ? ORION.buy : ORION.sell,
                padding: '1px 5px',
                borderRadius: '3px',
              } as Highcharts.CSSObject,
            },
          },
          ...signalPlotLines,
        ],
      },
    ];

    if (hasVolume) {
      yAxes.push({
        // volumen
        top: volTop,
        height: '12%',
        labels: { enabled: false },
        gridLineWidth: 0,
      });
    }

    if (rsi14) {
      yAxes.push({
        top: hasVolume ? '74%' : '72%',
        height: hasVolume ? '26%' : '28%',
        min: 0,
        max: 100,
        tickPositions: [30, 50, 70],
        labels: { align: 'left', x: 8 },
        plotLines: [
          { value: 70, color: ORION.hairline, width: 1, dashStyle: 'Dash' },
          { value: 30, color: ORION.hairline, width: 1, dashStyle: 'Dash' },
        ],
      });
    }

    const chart = Highcharts.stockChart(ref.current, {
      chart: {
        backgroundColor: 'transparent',
        events: {
          // la capa SMC se redibuja en cada render (zoom, pan, reflow)
          render() {
            drawSmc(this, smc, stepMs);
          },
        },
      },
      // overscroll deja aire a la derecha de la última vela, estilo TradingView
      xAxis: { gridLineWidth: 1, range: stepMs * 110, overscroll: stepMs * 6 },
      yAxis: yAxes,
      legend: { enabled: false },
      tooltip: {
        split: false,
        shared: true,
        formatter: function () {
          const points = this.points ?? [];
          const head = `<div style="font-family:${ORION.fontData};font-size:10px;color:${ORION.inkMid};margin-bottom:4px">${fmtDateTime(this.x as number)}</div>`;
          const rows = points
            .map((p) => {
              const anyPoint = p as unknown as {
                open?: number; high?: number; low?: number; close?: number; y?: number;
              };
              if (p.series.options.id === 'price' && anyPoint.open !== undefined) {
                const up = (anyPoint.close ?? 0) >= (anyPoint.open ?? 0);
                const tone = up ? ORION.buyInk : ORION.sellInk;
                const f = (v?: number) => (v ?? 0).toFixed(pair.decimals);
                return `<div style="font-family:${ORION.fontData};font-size:10px;line-height:1.7">
                  <span style="color:${ORION.inkLow}">A</span> <span style="color:${tone}">${f(anyPoint.open)}</span>
                  <span style="color:${ORION.inkLow}">M</span> <span style="color:${tone}">${f(anyPoint.high)}</span>
                  <span style="color:${ORION.inkLow}">m</span> <span style="color:${tone}">${f(anyPoint.low)}</span>
                  <span style="color:${ORION.inkLow}">C</span> <span style="color:${tone}">${f(anyPoint.close)}</span>
                </div>`;
              }
              if (p.series.options.id === 'volume') return '';
              return `<div style="font-size:10px;line-height:1.7">
                <span style="display:inline-block;width:7px;height:7px;border-radius:2px;background:${p.color};margin-right:5px"></span>
                <span style="color:${ORION.inkMid}">${p.series.name}</span>
                <span style="font-family:${ORION.fontData};color:${ORION.inkHi};margin-left:5px">${(p.y ?? 0).toFixed(pair.decimals)}</span>
              </div>`;
            })
            .join('');
          return `<div style="padding:2px">${head}${rows}</div>`;
        },
      },
      navigator: { enabled: true },
      series: chartSeries,
    });

    // si la señal activa cae fuera del rango visible, se trae a pantalla
    if (activeSignal) {
      const dataMax = candles[candles.length - 1][0];
      if (activeSignal.time < dataMax - stepMs * 110) {
        chart.xAxis[0].setExtremes(activeSignal.time - stepMs * 20, dataMax + stepMs * 6);
      }
    }

    chartRef.current = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
  }, [symbol, tf, kind, showSignals, showSmc, ema20, ema50, rsi14, activeSignal, series, signals]);

  // el gráfico debe seguir el tamaño de su contenedor
  useEffect(() => {
    if (!ref.current) return;
    const obs = new ResizeObserver(() => chartRef.current?.reflow());
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  return <div ref={ref} className="main-chart" />;
}
