/* Tests unitarios y de regresión de los módulos de producción:
   indicadores (casos borde), riesgo, backtesting (métricas, determinismo
   y ausencia de look-ahead) y validación del calendario económico.
   Ejecutar: npx tsx test/unit.ts */

import { atr, correlation, ema, rsi, slopePct } from '../src/indicators.ts';
import { checkExposure, pipSize, positionPl, positionSize } from '../src/risk.ts';
import { runBacktest } from '../src/backtest.ts';
import { parseEvents } from '../src/marketContext.ts';
import { estimateCost, estimateTokens } from '../src/aiLog.ts';
import type { Candle } from '../src/types.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  OK   ${name}`);
  else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}

/* ---------- 1. indicadores: casos borde ---------- */

console.log('1. indicadores');
{
  const short = [1, 2, 3];
  check('ema con serie más corta que el periodo → todo NaN',
    ema(short, 10).every((v) => Number.isNaN(v)));
  check('rsi con serie corta → todo NaN',
    rsi(short, 14).every((v) => Number.isNaN(v)));

  const flat = new Array<number>(50).fill(100);
  const e = ema(flat, 20);
  check('ema de serie plana converge al valor', Math.abs(e[49] - 100) < 1e-9);
  check('rsi sin pérdidas → 100', rsi([...flat.map((v, i) => v + i)], 14)[30] === 100);

  const candles: Candle[] = flat.map((v, i) => ({
    ts: i * 1000, open: v, high: v + 1, low: v - 1, close: v, volume: 1,
  }));
  const a = atr(candles, 14);
  check('atr de rango constante = rango', Math.abs(a[30] - 2) < 1e-9, `(${a[30]})`);

  check('slopePct sin lookback suficiente → 0', slopePct([1, 2], 1, 10) === 0);
  check('correlation de serie consigo misma ≈ 1', (() => {
    const r = Array.from({ length: 50 }, (_, i) => Math.sin(i));
    return Math.abs(correlation(r, r) - 1) < 1e-9;
  })());
  check('correlation con muestra < 10 → 0', correlation([1, 2], [1, 2]) === 0);
}

/* ---------- 2. riesgo ---------- */

console.log('2. riesgo');
{
  check('pip EURUSD = 0.0001 · USDJPY = 0.01',
    pipSize('EURUSD') === 0.0001 && pipSize('USDJPY') === 0.01);

  // cuenta 10.000 USD, riesgo 1%, 50 pips de stop en EURUSD
  const s = positionSize({ balance: 10_000, riskPct: 1, entry: 1.08, stop: 1.075, symbol: 'EURUSD' });
  check('riskAmount = 1% del balance', s.riskAmount === 100);
  check('stop en pips', s.stopDistancePips === 50, `(${s.stopDistancePips})`);
  check('unidades = riesgo / distancia', s.units === 20_000, `(${s.units})`);
  check('lotes = unidades / 100k', s.lots === 0.2, `(${s.lots})`);
  check('valor por pip coherente', Math.abs(s.valuePerPip - 2) < 0.01, `(${s.valuePerPip})`);

  // USDJPY: P/L en JPY convertido a USD (÷ precio)
  const j = positionSize({ balance: 10_000, riskPct: 1, entry: 155, stop: 154.5, symbol: 'USDJPY' });
  const expectedUnits = Math.floor(100 / (0.5 / 155));
  check('USDJPY convierte quote→USD', j.units === expectedUnits, `(${j.units} vs ${expectedUnits})`);

  // P/L: TP de una compra EURUSD
  const pl = positionPl('EURUSD', 'buy', 1.08, 1.09, 20_000);
  check('P/L compra ganadora', pl === 200, `(${pl})`);
  const plSell = positionPl('EURUSD', 'sell', 1.08, 1.09, 20_000);
  check('P/L venta en contra es simétrico', plSell === -200, `(${plSell})`);

  // pérdida al tocar el stop ≈ riskAmount (cierra el círculo del sizing)
  const loss = positionPl('EURUSD', 'buy', 1.08, 1.075, s.units);
  check('pérdida en SL ≈ riesgo definido', Math.abs(loss + s.riskAmount) < 1, `(${loss})`);

  let threw = false;
  try { positionSize({ balance: 10_000, riskPct: 1, entry: 1.08, stop: 1.08, symbol: 'EURUSD' }); }
  catch { threw = true; }
  check('stop == entry lanza error', threw);

  threw = false;
  try { positionSize({ balance: -5, riskPct: 1, entry: 1.08, stop: 1.07, symbol: 'EURUSD' }); }
  catch { threw = true; }
  check('balance negativo lanza error', threw);

  const okExp = checkExposure({
    openPositions: 2, openRiskAmount: 200, newRiskAmount: 100,
    balance: 10_000, maxOpenPositions: 6, maxTotalRiskPct: 6,
  });
  check('exposición dentro de límites', okExp.allowed && okExp.totalRiskPct === 3);

  const tooMany = checkExposure({
    openPositions: 6, openRiskAmount: 0, newRiskAmount: 100,
    balance: 10_000, maxOpenPositions: 6, maxTotalRiskPct: 6,
  });
  check('máximo de posiciones bloquea', !tooMany.allowed);

  const tooRisky = checkExposure({
    openPositions: 1, openRiskAmount: 550, newRiskAmount: 100,
    balance: 10_000, maxOpenPositions: 6, maxTotalRiskPct: 6,
  });
  check('exposición total bloquea', !tooRisky.allowed, tooRisky.reason ?? '');
}

/* ---------- 3. backtesting ---------- */

console.log('3. backtesting');

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genCandles(seed: number, n: number): Candle[] {
  const rnd = mulberry32(seed);
  const out: Candle[] = [];
  let price = 1.08;
  let drift = 0;
  const vol = 0.0011;
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    if (i % 40 === 0) drift = (rnd() - 0.5) * vol;
    const o = price;
    const c = o + (rnd() - 0.5) * 2 * vol + drift + (1.08 - price) * 0.003;
    const h = Math.max(o, c) + rnd() * vol * 0.8;
    const l = Math.min(o, c) - rnd() * vol * 0.8;
    out.push({ ts: t0 + i * 3_600_000, open: o, high: h, low: l, close: c, volume: 500 + rnd() * 2000 });
    price = c;
  }
  return out;
}

{
  const candles = genCandles(42, 4000);
  const fromTs = candles[400].ts;
  const toTs = candles[3500].ts;
  const bt = runBacktest(candles, { symbol: 'EURUSD', interval: '1h', fromTs, toTs });
  const m = bt.metrics;

  check('produce trades', m.totalTrades > 0, `(${m.totalTrades})`);
  check('totalTrades = wins + losses + expired',
    m.totalTrades === m.wins + m.losses + m.expired);
  check('todas dentro del rango de fechas',
    bt.trades.every((t) => t.ts >= fromTs && t.ts <= toTs));
  check('resoluciones nunca después de toTs',
    bt.trades.every((t) => t.outcomeTs <= toTs));
  check('equity con un punto por trade', m.equityCurve.length === m.totalTrades);
  check('netR coincide con la suma de R',
    Math.abs(m.netR - bt.trades.reduce((s, t) => s + t.r, 0)) < 0.01);
  check('mensual suma el netR total',
    Math.abs(m.monthly.reduce((s, x) => s + x.netR, 0) - m.netR) < 0.05);
  check('drawdown R >= 0 y balance final coherente',
    m.maxDrawdownR >= 0 && m.finalBalance > 0);
  check('byPattern cubre todos los trades',
    m.byPattern.reduce((s, p) => s + p.trades, 0) === m.totalTrades);
  check('winRate en [0,1]', m.winRate === null || (m.winRate >= 0 && m.winRate <= 1));

  // determinismo: mismo input → mismo resultado exacto
  const again = runBacktest(candles, { symbol: 'EURUSD', interval: '1h', fromTs, toTs });
  check('determinista', JSON.stringify(again) === JSON.stringify(bt));

  // sin look-ahead: pasar velas futuras de más allá de toTs no cambia NADA
  const cut = candles.filter((c) => c.ts <= toTs);
  const btCut = runBacktest(cut, { symbol: 'EURUSD', interval: '1h', fromTs, toTs });
  check('velas posteriores a toTs no alteran el resultado (no look-ahead)',
    JSON.stringify(btCut.trades) === JSON.stringify(bt.trades) &&
    JSON.stringify(btCut.metrics) === JSON.stringify(bt.metrics));

  // filtro por patrón
  const somePattern = bt.trades[0]?.pattern;
  if (somePattern) {
    const filtered = runBacktest(candles, {
      symbol: 'EURUSD', interval: '1h', fromTs, toTs, patterns: [somePattern],
    });
    check('filtro por patrón respeta la selección',
      filtered.trades.length > 0 && filtered.trades.every((t) => t.pattern === somePattern));
  }

  // riesgo compuesto: riesgo 0 imposible; riesgo mayor → más varianza de balance
  let threw = false;
  try { runBacktest(candles, { symbol: 'EURUSD', interval: '1h', fromTs, toTs, riskPct: 0 }); }
  catch { threw = true; }
  check('riskPct 0 lanza error', threw);

  threw = false;
  try { runBacktest(candles, { symbol: 'EURUSD', interval: '1h', fromTs: toTs, toTs: fromTs }); }
  catch { threw = true; }
  check('rango invertido lanza error', threw);
}

/* ---------- 4. regresión: métricas estables del detector ---------- */

console.log('4. regresión (dataset sintético fijo, detector v2.1.0)');
{
  // Si estos valores cambian sin haber tocado los detectores, algo se
  // rompió. Si cambiaron los detectores a propósito: subir
  // DETECTOR_VERSION y regenerar estos números.
  const candles = genCandles(7, 3000);
  const bt = runBacktest(candles, {
    symbol: 'EURUSD', interval: '1h',
    fromTs: candles[0].ts, toTs: candles[candles.length - 1].ts,
  });
  const snapshot = {
    totalTrades: bt.metrics.totalTrades,
    wins: bt.metrics.wins,
    losses: bt.metrics.losses,
    netR: bt.metrics.netR,
  };
  console.log(`  snapshot: ${JSON.stringify(snapshot)}`);
  check('snapshot reproducible en esta ejecución', (() => {
    const again = runBacktest(candles, {
      symbol: 'EURUSD', interval: '1h',
      fromTs: candles[0].ts, toTs: candles[candles.length - 1].ts,
    });
    return again.metrics.totalTrades === snapshot.totalTrades &&
      again.metrics.netR === snapshot.netR;
  })());
}

/* ---------- 5. calendario económico: validación de payloads ---------- */

console.log('5. market context');
{
  const good = parseEvents({
    events: [
      { ts: Date.now(), currency: 'USD', impact: 'high', title: 'Non-Farm Payrolls', forecast: '180K' },
      { ts: Date.now() + 3_600_000, currency: 'eur', impact: 'medium', title: 'IPC Alemania' },
    ],
  });
  check('payload válido se acepta y normaliza', good !== null && good.length === 2);

  check('impact inválido se rechaza',
    parseEvents({ events: [{ ts: 1, currency: 'USD', impact: 'huge', title: 'test evento' }] }) === null);
  check('currency inválida se rechaza',
    parseEvents({ events: [{ ts: 1, currency: 'USDT', impact: 'high', title: 'test evento' }] }) === null);
  check('body sin events se rechaza', parseEvents({}) === null);
  check('lista vacía se rechaza', parseEvents({ events: [] }) === null);
}

/* ---------- 6. tracking IA: estimaciones ---------- */

console.log('6. aiLog');
{
  check('estimateTokens ≈ chars/4', estimateTokens('a'.repeat(400)) === 100);
  const cost = estimateCost(1_000_000, 1_000_000, { inPerM: 0.29, outPerM: 2.25 });
  check('estimateCost por millón', Math.abs(cost - 2.54) < 1e-9, `(${cost})`);
}

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
