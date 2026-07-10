/* Tests unitarios y de regresión de los módulos de producción:
   indicadores (casos borde), riesgo, backtesting (métricas, determinismo
   y ausencia de look-ahead) y validación del calendario económico.
   Ejecutar: npx tsx test/unit.ts */

import { adx, atr, correlation, ema, rsi, slopePct } from '../src/indicators.ts';
import { checkExposure, pipSize, positionPl, positionSize } from '../src/risk.ts';
import { runBacktest } from '../src/backtest.ts';
import { parseEvents } from '../src/marketContext.ts';
import { estimateCost, estimateTokens } from '../src/aiLog.ts';
import { hashPassword, verifyPassword } from '../src/auth.ts';
import { makeRegimeCalculator, regimeAligned, regimeAt } from '../src/regime.ts';
import { computePatternHealth, expectancyOf } from '../src/health.ts';
import {
  computeDimensionPerformance, DEFAULT_WEIGHTS, evolveWeights,
} from '../src/scoring.ts';
import { classifyTradeReview } from '../src/review.ts';
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

/* ---------- 7. auth: hashing de contraseñas ---------- */

console.log('7. auth');
{
  const stored = await hashPassword('correct horse battery');
  check('hash con formato pbkdf2$iter$salt$hash',
    /^pbkdf2\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(stored), `(${stored.slice(0, 30)}…)`);
  check('la contraseña correcta verifica', await verifyPassword('correct horse battery', stored));
  check('una contraseña incorrecta no verifica', !(await verifyPassword('incorrecta', stored)));

  const again = await hashPassword('correct horse battery');
  check('salt aleatorio: dos hashes distintos', again !== stored);
  check('hash corrupto no verifica ni lanza', !(await verifyPassword('x', 'pbkdf2$100000$!!$!!')));
  check('esquema desconocido se rechaza', !(await verifyPassword('x', 'bcrypt$10$abc$def')));
  // un atacante no puede inflar las iteraciones por encima del límite del runtime
  const inflated = stored.replace('$100000$', '$9999999$');
  check('iteraciones fuera de rango se rechazan', !(await verifyPassword('correct horse battery', inflated)));
}

/* ---------- 8. régimen de mercado (ADX + clasificador) ---------- */

console.log('8. régimen de mercado');

/** Serie direccional constante: paso geométrico (proporcional al precio)
    para que el ATR% no derive con el nivel y el percentil quede estable. */
function trendCandles(n: number, stepPct: number): Candle[] {
  const out: Candle[] = [];
  let p = 1.08;
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const c = p * (1 + stepPct);
    const w = Math.abs(c - p) * 0.3;
    out.push({
      ts: t0 + i * 3_600_000, open: p,
      high: Math.max(p, c) + w, low: Math.min(p, c) - w,
      close: c, volume: 1000,
    });
    p = c;
  }
  return out;
}

/** Serie lateral: senoide rápida de amplitud `amp` (ATR casi constante). */
function rangeCandles(n: number, amp: (i: number) => number): Candle[] {
  const out: Candle[] = [];
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  let prev = 1.08;
  for (let i = 0; i < n; i++) {
    const a = amp(i);
    const c = 1.08 + a * Math.sin(i * 1.05);
    out.push({
      ts: t0 + i * 3_600_000, open: prev,
      high: Math.max(prev, c) + a * 0.2, low: Math.min(prev, c) - a * 0.2,
      close: c, volume: 1000,
    });
    prev = c;
  }
  return out;
}

{
  // ADX: casos borde
  const short = trendCandles(10, 0.001);
  check('adx con serie corta → todo NaN', adx(short, 14).adx.every((v) => Number.isNaN(v)));

  const up = trendCandles(400, 0.0008);
  const a = adx(up, 14);
  check('adx de tendencia limpia es alto', a.adx[399] > 25, `(${a.adx[399]?.toFixed(1)})`);
  check('+DI domina en tendencia alcista', a.plusDi[399] > a.minusDi[399]);

  const flat = rangeCandles(400, () => 0.002);
  const af = adx(flat, 14);
  check('adx de rango es bajo', af.adx[399] < 22, `(${af.adx[399]?.toFixed(1)})`);

  // clasificador
  check('tendencia alcista → TRENDING_UP', regimeAt(up, 399)?.regime === 'TRENDING_UP');
  const down = trendCandles(400, -0.0008);
  check('tendencia bajista → TRENDING_DOWN', regimeAt(down, 399)?.regime === 'TRENDING_DOWN');
  check('lateral con volatilidad constante → RANGE',
    regimeAt(flat, 399)?.regime === 'RANGE', `(${regimeAt(flat, 399)?.regime})`);

  // expansión de volatilidad al final → HIGH_VOLATILITY
  const hot = rangeCandles(400, (i) => (i >= 360 ? 0.012 : 0.002));
  check('expansión de rango → HIGH_VOLATILITY',
    regimeAt(hot, 399)?.regime === 'HIGH_VOLATILITY', `(${regimeAt(hot, 399)?.regime})`);

  // compresión sostenida al final → LOW_VOLATILITY
  const quiet = rangeCandles(400, (i) => (i >= 340 ? 0.0003 : 0.002));
  check('compresión de rango → LOW_VOLATILITY',
    regimeAt(quiet, 399)?.regime === 'LOW_VOLATILITY', `(${regimeAt(quiet, 399)?.regime})`);

  // límites
  check('sin muestra suficiente → null', regimeAt(up, 50) === null);
  check('índice fuera de rango → null', makeRegimeCalculator(up)(400) === null);
  check('determinista', JSON.stringify(regimeAt(up, 399)) === JSON.stringify(regimeAt(up, 399)));

  // alineación señal-régimen
  check('regimeAligned direcciona solo en tendencia',
    regimeAligned('TRENDING_UP', 'buy') === true &&
    regimeAligned('TRENDING_UP', 'sell') === false &&
    regimeAligned('RANGE', 'buy') === null &&
    regimeAligned(null, 'sell') === null);
}

/* ---------- 9. walk-forward y salud de patrones ---------- */

console.log('9. salud de patrones');
{
  check('expectancyOf: 0.6·2 − 0.4 = 0.8', Math.abs(expectancyOf(0.6, 2) - 0.8) < 1e-9);

  const key = { symbol: 'EURUSD', interval: '1h', pattern: 'Doble suelo' };

  const healthy = computePatternHealth(key,
    { total: 30, tpRate: 0.6, avgRr: 2 }, { total: 10, tpRate: 0.6, avgRr: 2 });
  check('rendimiento estable → healthy con multiplicador 1',
    healthy.status === 'healthy' && healthy.confidenceMultiplier === 1 &&
    healthy.degradationScore === 0, JSON.stringify(healthy));

  const disabledHist = computePatternHealth(key,
    { total: 20, tpRate: 0.3, avgRr: 1.5 }, { total: 0, tpRate: 0, avgRr: 0 });
  check('expectancia histórica <= 0 con muestra → disabled (gate clásico)',
    disabledHist.status === 'disabled' && disabledHist.confidenceMultiplier === 0);

  const degrading = computePatternHealth(key,
    { total: 30, tpRate: 0.6, avgRr: 2 }, { total: 10, tpRate: 0.2, avgRr: 2 });
  check('histórico bueno + reciente perdedor → degrading',
    degrading.status === 'degrading' && degrading.degradationScore >= 0.35,
    JSON.stringify(degrading));
  check('degrading reduce el multiplicador sin anularlo',
    degrading.confidenceMultiplier >= 0.6 && degrading.confidenceMultiplier < 1);
  check('la salud cae con la degradación', degrading.health < healthy.health);

  const smallRecent = computePatternHealth(key,
    { total: 30, tpRate: 0.6, avgRr: 2 }, { total: 3, tpRate: 0, avgRr: 1 });
  check('muestra reciente insuficiente no castiga', smallRecent.status === 'healthy');

  const disabledRecent = computePatternHealth(key,
    { total: 30, tpRate: 0.6, avgRr: 2 }, { total: 15, tpRate: 0.2, avgRr: 1.5 });
  check('degradación reciente severa con muestra → disabled',
    disabledRecent.status === 'disabled', JSON.stringify(disabledRecent));
}

/* ---------- 10. evolución de pesos del scoring ---------- */

console.log('10. pesos adaptativos');
{
  const targetSum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
  const sumOf = (w: Record<string, number>) =>
    Object.values(w).reduce((a, b) => a + b, 0);

  // dimensión trend muy predictiva, volume ruidosa (idéntica en ambos lados)
  const perf = computeDimensionPerformance([
    ...Array.from({ length: 15 }, () => ({
      breakdown: { trend: 5, volume: 3, momentum: 4 }, outcome: 'tp_hit' as const,
    })),
    ...Array.from({ length: 15 }, () => ({
      breakdown: { trend: 1, volume: 3, momentum: 2 }, outcome: 'sl_hit' as const,
    })),
  ]);
  const trendPerf = perf.find((p) => p.dimension === 'trend')!;
  check('computeDimensionPerformance separa ganadores de perdedores',
    trendPerf.avgWin === 5 && trendPerf.avgLoss === 1 && trendPerf.nWin === 15);

  const next = evolveWeights(DEFAULT_WEIGHTS, perf);
  check('dimensión predictiva gana peso', next.trend > DEFAULT_WEIGHTS.trend,
    `(${next.trend})`);
  check('dimensión ruidosa pierde peso relativo', next.volume < DEFAULT_WEIGHTS.volume,
    `(${next.volume})`);
  check('la suma de pesos se conserva (escala 0-100 estable)',
    Math.abs(sumOf(next) - targetSum) < 0.05, `(${sumOf(next)} vs ${targetSum})`);
  check('determinista',
    JSON.stringify(evolveWeights(DEFAULT_WEIGHTS, perf)) === JSON.stringify(next));

  // muestra insuficiente → sin cambios
  const few = computeDimensionPerformance([
    { breakdown: { trend: 5 }, outcome: 'tp_hit' },
    { breakdown: { trend: 1 }, outcome: 'sl_hit' },
  ]);
  check('muestra insuficiente no mueve pesos',
    JSON.stringify(evolveWeights(DEFAULT_WEIGHTS, few)) === JSON.stringify(
      evolveWeights(DEFAULT_WEIGHTS, []),
    ));

  // clamp superior: un peso ya al máximo no lo supera
  const maxed = { ...DEFAULT_WEIGHTS, trend: 2.0 };
  check('clamp superior respetado', evolveWeights(maxed, perf).trend <= 2.001);
}

/* ---------- 11. evaluación continua (review de trades) ---------- */

console.log('11. trade reviews');
{
  const base = {
    sigKey: 'EURUSD|1h|1|x', symbol: 'EURUSD', interval: '1h',
    pattern: 'Doble suelo', direction: 'buy' as const, rr: 2,
    regime: 'TRENDING_UP', aiAction: 'buy', aiConfidence: 80,
    overallScore: 72, isGate: false, context: null,
  };

  const badCall = classifyTradeReview({ ...base, outcome: 'sl_hit' });
  check('validó y salió SL → error con sobreconfianza',
    badCall.mistakeType === 'ia_valido_y_salio_sl' && badCall.aiCorrect === false &&
    badCall.confidenceCalibrated === false && badCall.cause !== null);
  check('régimen alineado se registra', badCall.regimeAligned === true);

  const goodCall = classifyTradeReview({ ...base, outcome: 'tp_hit' });
  check('validó y salió TP → acierto sin causa',
    goodCall.mistakeType === 'validacion_correcta' && goodCall.aiCorrect === true &&
    goodCall.cause === null && goodCall.patternWorked);

  const missed = classifyTradeReview({
    ...base, aiAction: 'skip', aiConfidence: 15, outcome: 'tp_hit',
  });
  check('descartó una ganadora → error tipificado',
    missed.mistakeType === 'ia_descarto_y_salio_tp' && missed.aiCorrect === false &&
    missed.confidenceCalibrated === false);

  const gated = classifyTradeReview({
    ...base, aiAction: 'skip', isGate: true, outcome: 'tp_hit',
  });
  check('gate descartó una ganadora → tipo propio y sin calibración',
    gated.mistakeType === 'gate_descarto_y_salio_tp' && gated.confidenceCalibrated === null);

  const dodged = classifyTradeReview({ ...base, aiAction: 'skip', outcome: 'sl_hit' });
  check('descartó una perdedora → acierto', dodged.mistakeType === 'descarte_correcto' &&
    dodged.aiCorrect === true);

  const expired = classifyTradeReview({ ...base, outcome: 'expired', rr: 5 });
  check('expirada → sin veredicto de acierto y causa de horizonte',
    expired.mistakeType === 'expirada' && expired.aiCorrect === null &&
    expired.cause === 'objetivo demasiado ambicioso para el horizonte');

  const counterRegime = classifyTradeReview({
    ...base, regime: 'TRENDING_DOWN', outcome: 'sl_hit',
  });
  check('la causa prioriza el régimen en contra',
    counterRegime.cause === 'señal validada contra el régimen dominante' &&
    counterRegime.regimeAligned === false);

  check('affectedPatterns lleva el patrón exacto',
    JSON.stringify(badCall.affectedPatterns) === '["Doble suelo"]');
}

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
