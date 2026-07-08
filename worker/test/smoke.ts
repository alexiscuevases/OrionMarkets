/* Smoke test de la lógica pura (sin bindings de Cloudflare):
   detectores deterministas, resolución de resultados, scoring y
   parseo del veredicto IA. Ejecutar: node test/smoke.ts */

import { detectAll, profileFor, resolveOutcome } from '../src/patterns.ts';
import { parseVerdict } from '../src/ai.ts';
import { calibrationFor, scoreSignal } from '../src/scoring.ts';
import { caseText, featuresFromContext, summarizeSimilarCases } from '../src/learn.ts';
import { smcSummary } from '../src/smc.ts';
import type { Candle, SignalContext } from '../src/types.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  OK   ${name}`);
  else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}

/* ---- velas sintéticas deterministas (paseo con regímenes) ---- */

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

console.log('1. detectAll — histórico completo');
const candles = genCandles(42, 2000);
const signals = detectAll('EURUSD', '1h', candles);
check('detecta señales en 2000 velas', signals.length > 0, `(${signals.length})`);
check('RR en banda operable [1.2, 6]', signals.every((s) => s.rr >= 1.2 && s.rr <= 6));
check('sin señales en rollover NY (21-22 UTC)', signals.every((s) => {
  const h = new Date(s.ts).getUTCHours();
  return h !== 21 && h !== 22;
}));
check('confianza en [0,100]', signals.every((s) => s.confidence >= 0 && s.confidence <= 100));
check('claves únicas', new Set(signals.map((s) => s.sigKey)).size === signals.length);
check('incluye señales históricas (no solo la última vela)',
  signals.some((s) => s.ts < candles[candles.length - 50].ts));
check('stop coherente con dirección', signals.every((s) =>
  s.direction === 'buy' ? s.stop < s.entry && s.target > s.entry : s.stop > s.entry && s.target < s.entry));

console.log('2. determinismo');
const again = detectAll('EURUSD', '1h', candles);
check('mismo input → mismas señales', JSON.stringify(again) === JSON.stringify(signals));

console.log('3. resolveOutcome');
const expiryBars = profileFor('1h').expiryBars;
const resolved = signals.map((s) => resolveOutcome(s, candles, expiryBars));
const counts = { tp_hit: 0, sl_hit: 0, expired: 0, open: 0 };
for (const r of resolved) counts[r.outcome]++;
check('resuelve resultados', counts.tp_hit + counts.sl_hit > 0, JSON.stringify(counts));
check('señal buy que toca SL primero',
  resolveOutcome(
    { ts: candles[0].ts, direction: 'buy', stop: candles[1].low + 1e-9, target: 99 },
    candles,
    expiryBars,
  ).outcome === 'sl_hit');
check('sin tocar niveles en la ventana → expired',
  resolveOutcome(
    { ts: candles[0].ts, direction: 'buy', stop: 0, target: 99 },
    candles,
    expiryBars,
  ).outcome === 'expired');

console.log('4. parseVerdict');
const ctx: SignalContext = {
  symbol: 'EURUSD', interval: '1h', detectedAt: '2026-07-06T00:00:00Z',
  pattern: 'Doble suelo', direction: 'buy', entry: 1.08, stop: 1.075, target: 1.09,
  riskReward: 2, trendHigherTf: 'alcista', ema200: 'precio por encima',
  ema200Slope: 'ascendente', rsi14: 55, atrPct: 0.12, volumeTrend: 'creciente',
  distanceToRecentHigh: 0.8, distanceToRecentLow: 0.4,
  correlations: { GBPUSD: 0.6, USDJPY: -0.3 },
  recentOutcomes: [{ pattern: 'Doble suelo', total: 10, tpRate: 0.6, avgRr: 2 }],
  similarCases: null, news: null, sentiment: null,
};
const good = parseVerdict(
  'texto previo {"action":"buy","confidence":78,"thesis":"ok","risks":"r","sentimentScore":4,"newsScore":3} texto posterior',
  ctx,
);
check('extrae JSON embebido', good.action === 'buy' && good.confidence === 78);
check('IA no puede invertir la dirección',
  parseVerdict('{"action":"sell","confidence":90,"thesis":"t","risks":"r","sentimentScore":3,"newsScore":3}', ctx).action === 'skip');
check('basura → skip conservador', parseVerdict('no json', ctx).action === 'skip');

console.log('5. scoreSignal');
const strong = scoreSignal(ctx, good);
check('overall en [0,100]', strong.overall >= 0 && strong.overall <= 100, `(${strong.overall})`);
check('desglose 0-5', Object.values(strong.breakdown).every((v) => v >= 0 && v <= 5));
const weak = scoreSignal(
  { ...ctx, trendHigherTf: 'bajista', ema200: 'precio por debajo', ema200Slope: 'descendente', riskReward: 1.1, volumeTrend: 'decreciente' },
  { ...good, action: 'skip', confidence: 20 },
);
check('contexto contrario puntúa menos', weak.overall < strong.overall, `(${weak.overall} < ${strong.overall})`);
const badHistory = scoreSignal(
  { ...ctx, recentOutcomes: [{ pattern: 'Doble suelo', total: 30, tpRate: 0.15, avgRr: 2 }] },
  good,
);
check('historial perdedor del patrón penaliza el score',
  badHistory.overall < strong.overall, `(${badHistory.overall} < ${strong.overall})`);

console.log('6. aprendizaje');
const calib = [
  { bucket: '65-79', n: 60, tpRate: 0.2, avgRr: 2, expectancy: -0.4 },
  { bucket: '80plus', n: 5, tpRate: 0.9, avgRr: 2, expectancy: 1.7 },
];
check('calibrationFor elige el tramo de la confianza',
  calibrationFor(78, calib)?.bucket === '65-79' && calibrationFor(30, calib) === null);
const calibrated = scoreSignal(ctx, good, calib[0]);
check('IA sobreconfiada según su historial → score recortado',
  calibrated.overall < strong.overall, `(${calibrated.overall} < ${strong.overall})`);
check('muestra pequeña no altera el score',
  scoreSignal(ctx, { ...good, confidence: 85 }, calib[1]).overall ===
  scoreSignal(ctx, { ...good, confidence: 85 }).overall);

const feats = featuresFromContext(ctx);
check('texto de caso determinista y con features clave',
  caseText(feats) === caseText(featuresFromContext(ctx)) &&
  caseText(feats).includes('Doble suelo') && caseText(feats).includes('EMA200'));
check('similares insuficientes → null',
  summarizeSimilarCases([{ score: 0.9, metadata: { outcome: 'tp_hit' } }]) === null);
const summary = summarizeSimilarCases([
  { score: 0.9, metadata: { outcome: 'tp_hit' } },
  { score: 0.85, metadata: { outcome: 'sl_hit', aiAction: 'buy' } },
  { score: 0.8, metadata: { outcome: 'sl_hit', aiAction: 'buy' } },
  { score: 0.5, metadata: { outcome: 'tp_hit' } }, // por debajo del umbral: fuera
]);
check('resumen de similares con acierto y errores IA',
  summary !== null && summary.includes('33%') && summary.includes('2'), `(${summary})`);

console.log('7. smart money');
// serie artesanal: caída, order block de demanda + impulso, máximos iguales
const smcCandles: Candle[] = [];
{
  let p = 1.08;
  let t = Date.parse('2026-03-01T00:00:00Z');
  const add = (o: number, h: number, l: number, c: number) => {
    smcCandles.push({ ts: t, open: o, high: h, low: l, close: c, volume: 1000 });
    t += 3_600_000;
  };
  // bajada suave hasta ~1.0700
  for (let k = 0; k < 100; k++) {
    const c = p - 0.0001 + Math.sin(k * 1.7) * 0.0002;
    add(p, Math.max(p, c) + 0.0004, Math.min(p, c) - 0.0004, c);
    p = c;
  }
  // vela bajista origen (low 1.0690) + impulso alcista de 3 velas
  add(p, p + 0.0003, 1.069, 1.0694); p = 1.0694;
  for (const c of [1.0715, 1.0738, 1.076]) { add(p, c + 0.0005, p - 0.0003, c); p = c; }
  // rango tranquilo con tres máximos iguales ~1.0790 (liquidez buy-side)
  for (let k = 0; k < 76; k++) {
    const peak = k === 18 ? 1.0788 : k === 38 ? 1.079 : k === 58 ? 1.0789 : 0;
    const c = 1.0762 + Math.sin(k * 1.7) * 0.0004;
    add(p, peak || Math.max(p, c) + 0.0004, Math.min(p, c) - 0.0004, c);
    p = c;
  }
}
const smc = smcSummary(smcCandles, 'buy');
check('detecta zona de demanda sin mitigar', smc?.demandZone != null,
  JSON.stringify(smc?.demandZone));
check('detecta liquidez buy-side (máximos iguales)',
  smc?.buySideLiquidity != null && smc.buySideLiquidity.touches >= 2 &&
  Math.abs(smc.buySideLiquidity.price - 1.079) < 1e-9,
  JSON.stringify(smc?.buySideLiquidity));
check('estructura apoya la compra', smc?.structuralBias === 'apoya', `(${smc?.structuralBias})`);

const smcFor = scoreSignal({
  ...ctx,
  smc: {
    demandZone: { low: 1.075, high: 1.0785, distancePct: 0.1 },
    supplyZone: null,
    buySideLiquidity: { price: 1.09, touches: 3, distancePct: 0.6 },
    sellSideLiquidity: null,
    structuralBias: 'apoya',
  },
}, good);
const smcAgainst = scoreSignal({
  ...ctx,
  smc: {
    demandZone: null,
    supplyZone: { low: 1.081, high: 1.082, distancePct: 0.09 },
    buySideLiquidity: null,
    sellSideLiquidity: { price: 1.07, touches: 2, distancePct: 0.9 },
    structuralBias: 'en contra',
  },
}, good);
check('SMC a favor con imán → institucional 5', smcFor.breakdown.institutional === 5);
check('SMC en contra penaliza el score',
  smcAgainst.breakdown.institutional === 1 && smcAgainst.overall < smcFor.overall,
  `(${smcAgainst.overall} < ${smcFor.overall})`);

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
