/* Smoke test de la lógica pura (sin bindings de Cloudflare):
   detectores deterministas, resolución de resultados, scoring y
   parseo del veredicto IA. Ejecutar: node test/smoke.ts */

import { detectAll, resolveOutcome } from '../src/patterns.ts';
import { parseVerdict } from '../src/ai.ts';
import { scoreSignal } from '../src/scoring.ts';
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
check('todas con RR >= 1', signals.every((s) => s.rr >= 1));
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
const resolved = signals.map((s) => resolveOutcome(s, candles));
const counts = { tp_hit: 0, sl_hit: 0, expired: 0, open: 0 };
for (const r of resolved) counts[r.outcome]++;
check('resuelve resultados', counts.tp_hit + counts.sl_hit > 0, JSON.stringify(counts));
check('señal buy que toca SL primero',
  resolveOutcome(
    { ts: candles[0].ts, direction: 'buy', stop: candles[1].low + 1e-9, target: 99 },
    candles,
  ).outcome === 'sl_hit');

console.log('4. parseVerdict');
const ctx: SignalContext = {
  symbol: 'EURUSD', interval: '1h', detectedAt: '2026-07-06T00:00:00Z',
  pattern: 'Doble suelo', direction: 'buy', entry: 1.08, stop: 1.075, target: 1.09,
  riskReward: 2, trendHigherTf: 'alcista', ema200: 'precio por encima',
  ema200Slope: 'ascendente', rsi14: 55, atrPct: 0.12, volumeTrend: 'creciente',
  distanceToRecentHigh: 0.8, distanceToRecentLow: 0.4,
  correlations: { GBPUSD: 0.6, USDJPY: -0.3 },
  recentOutcomes: [{ pattern: 'Doble suelo', total: 10, tpRate: 0.6 }],
  news: null, sentiment: null,
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

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
