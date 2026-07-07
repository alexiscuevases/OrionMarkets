/* Datos simulados del mercado FX.
   Todo es determinista (RNG con semilla por par + temporalidad) para que
   la maqueta sea estable entre recargas. */

export type Group = 'Mayores' | 'Menores' | 'Exóticos';

export interface PairDef {
  symbol: string;
  base: string;
  quote: string;
  name: string;
  group: Group;
  price: number;      // precio ancla del paseo aleatorio
  decimals: number;   // dígitos mostrados
  pip: number;        // tamaño de pip
  spread: number;     // spread típico en pips
}

export const PAIRS: PairDef[] = [
  { symbol: 'EURUSD', base: 'EUR', quote: 'USD', name: 'Euro / Dólar', group: 'Mayores', price: 1.0842, decimals: 5, pip: 0.0001, spread: 0.6 },
  { symbol: 'GBPUSD', base: 'GBP', quote: 'USD', name: 'Libra / Dólar', group: 'Mayores', price: 1.2718, decimals: 5, pip: 0.0001, spread: 0.9 },
  { symbol: 'USDJPY', base: 'USD', quote: 'JPY', name: 'Dólar / Yen', group: 'Mayores', price: 157.42, decimals: 3, pip: 0.01, spread: 0.8 },
  { symbol: 'USDCHF', base: 'USD', quote: 'CHF', name: 'Dólar / Franco', group: 'Mayores', price: 0.8914, decimals: 5, pip: 0.0001, spread: 1.1 },
  { symbol: 'AUDUSD', base: 'AUD', quote: 'USD', name: 'Aussie / Dólar', group: 'Mayores', price: 0.6653, decimals: 5, pip: 0.0001, spread: 0.8 },
  { symbol: 'USDCAD', base: 'USD', quote: 'CAD', name: 'Dólar / Loonie', group: 'Mayores', price: 1.3629, decimals: 5, pip: 0.0001, spread: 1.2 },
  { symbol: 'NZDUSD', base: 'NZD', quote: 'USD', name: 'Kiwi / Dólar', group: 'Mayores', price: 0.6087, decimals: 5, pip: 0.0001, spread: 1.4 },
  { symbol: 'EURGBP', base: 'EUR', quote: 'GBP', name: 'Euro / Libra', group: 'Menores', price: 0.8524, decimals: 5, pip: 0.0001, spread: 1.1 },
  { symbol: 'EURJPY', base: 'EUR', quote: 'JPY', name: 'Euro / Yen', group: 'Menores', price: 170.68, decimals: 3, pip: 0.01, spread: 1.3 },
  { symbol: 'GBPJPY', base: 'GBP', quote: 'JPY', name: 'Libra / Yen', group: 'Menores', price: 200.21, decimals: 3, pip: 0.01, spread: 1.9 },
  { symbol: 'AUDNZD', base: 'AUD', quote: 'NZD', name: 'Aussie / Kiwi', group: 'Menores', price: 1.0931, decimals: 5, pip: 0.0001, spread: 1.8 },
  { symbol: 'USDMXN', base: 'USD', quote: 'MXN', name: 'Dólar / Peso MX', group: 'Exóticos', price: 18.421, decimals: 4, pip: 0.001, spread: 6.0 },
  { symbol: 'USDTRY', base: 'USD', quote: 'TRY', name: 'Dólar / Lira', group: 'Exóticos', price: 32.874, decimals: 4, pip: 0.001, spread: 12.0 },
  { symbol: 'USDZAR', base: 'USD', quote: 'ZAR', name: 'Dólar / Rand', group: 'Exóticos', price: 18.132, decimals: 4, pip: 0.001, spread: 9.0 },
];

export const pairBySymbol = (symbol: string): PairDef =>
  PAIRS.find((p) => p.symbol === symbol) ?? PAIRS[0];

/* ---------------- Temporalidades ---------------- */

export interface Timeframe {
  id: string;
  label: string;
  minutes: number;
  candles: number;
}

export const TIMEFRAMES: Timeframe[] = [
  { id: 'M1', label: 'M1', minutes: 1, candles: 360 },
  { id: 'M5', label: 'M5', minutes: 5, candles: 400 },
  { id: 'M15', label: 'M15', minutes: 15, candles: 420 },
  { id: 'M30', label: 'M30', minutes: 30, candles: 420 },
  { id: 'H1', label: 'H1', minutes: 60, candles: 480 },
  { id: 'H4', label: 'H4', minutes: 240, candles: 420 },
  { id: 'D1', label: 'D1', minutes: 1440, candles: 365 },
  { id: 'W1', label: 'W1', minutes: 10080, candles: 260 },
];

/* ---------------- RNG con semilla ---------------- */

function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- Generador de velas ---------------- */

export type Candle = [number, number, number, number, number]; // t, o, h, l, c

export interface SeriesData {
  candles: Candle[];
  volume: [number, number][];
}

const seriesCache = new Map<string, SeriesData>();

/** Paseo aleatorio con regímenes de tendencia y mechas realistas. */
export function getSeries(symbol: string, tfId: string): SeriesData {
  const key = `${symbol}:${tfId}`;
  const cached = seriesCache.get(key);
  if (cached) return cached;

  const pair = pairBySymbol(symbol);
  const tf = TIMEFRAMES.find((t) => t.id === tfId) ?? TIMEFRAMES[4];
  const rnd = mulberry32(hashSeed(key));

  const stepMs = tf.minutes * 60_000;
  const now = Math.floor(Date.now() / stepMs) * stepMs;
  const start = now - stepMs * (tf.candles - 1);

  // volatilidad por vela ~ raíz del tiempo
  const vol = pair.price * 0.0011 * Math.sqrt(tf.minutes / 60);

  const candles: Candle[] = [];
  const volume: [number, number][] = [];

  let price = pair.price * (0.97 + rnd() * 0.05);
  let drift = 0;

  for (let i = 0; i < tf.candles; i++) {
    // cambio de régimen ocasional: tendencia alcista, bajista o rango
    if (i % 36 === 0 || rnd() < 0.02) {
      drift = (rnd() - 0.5) * vol * 0.9;
    }
    // reversión suave hacia el ancla para no derivar al infinito
    const pull = (pair.price - price) * 0.004;

    const o = price;
    const body = (rnd() - 0.5) * 2 * vol + drift + pull;
    const c = o + body;
    const wickUp = Math.abs((rnd() + rnd()) * 0.5 * vol * 0.9);
    const wickDown = Math.abs((rnd() + rnd()) * 0.5 * vol * 0.9);
    const h = Math.max(o, c) + wickUp;
    const l = Math.min(o, c) - wickDown;
    const t = start + i * stepMs;

    candles.push([
      t,
      round(o, pair.decimals),
      round(h, pair.decimals),
      round(l, pair.decimals),
      round(c, pair.decimals),
    ]);
    volume.push([t, Math.round(400 + rnd() * 2400 + Math.abs(body / vol) * 1600)]);
    price = c;
  }

  const data = { candles, volume };
  seriesCache.set(key, data);
  return data;
}

function round(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/* ---------------- Cotización derivada ---------------- */

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  changePct: number;   // % día
  changePips: number;
  high: number;
  low: number;
  spark: number[];     // cierres recientes para sparkline
}

export function getQuote(symbol: string): Quote {
  return quoteFromCandles(symbol, getSeries(symbol, 'H1').candles, 60);
}

/** Cotización derivada de cualquier serie de velas (mock o del motor). */
export function quoteFromCandles(
  symbol: string,
  candles: Candle[],
  tfMinutes: number,
): Quote {
  const pair = pairBySymbol(symbol);
  const closes = candles.map((c) => c[4]);
  const last = closes[closes.length - 1];
  const barsPerDay = Math.max(1, Math.round(1440 / tfMinutes));
  const dayAgo = closes[Math.max(0, closes.length - 1 - barsPerDay)];
  const day = candles.slice(-barsPerDay);

  return {
    symbol,
    bid: last,
    ask: round(last + pair.spread * pair.pip, pair.decimals),
    changePct: ((last - dayAgo) / dayAgo) * 100,
    changePips: (last - dayAgo) / pair.pip,
    high: Math.max(...day.map((c) => c[2])),
    low: Math.min(...day.map((c) => c[3])),
    spark: closes.slice(-40),
  };
}

/* ---------------- Estrategias ---------------- */

export interface Strategy {
  id: string;
  name: string;
  desc: string;
  tf: string;
  pairs: string;
  winRate: number;      // %
  profitFactor: number;
  signals30d: number;
  risk: 'Bajo' | 'Medio' | 'Alto';
  active: boolean;
  equity: number[];     // curva de resultados para el mini-gráfico
}

function equityCurve(seed: string, bias: number): number[] {
  const rnd = mulberry32(hashSeed(seed));
  const out: number[] = [];
  let v = 0;
  for (let i = 0; i < 30; i++) {
    v += (rnd() - 0.5 + bias) * 2;
    out.push(v);
  }
  return out;
}

export const STRATEGIES: Strategy[] = [
  {
    id: 'london-breakout',
    name: 'Ruptura de Londres',
    desc: 'Opera la expansión del rango asiático en la apertura europea.',
    tf: 'M15', pairs: 'EURUSD · GBPUSD', winRate: 61, profitFactor: 1.84,
    signals30d: 26, risk: 'Medio', active: true,
    equity: equityCurve('london', 0.09),
  },
  {
    id: 'ema-cross',
    name: 'Cruce EMA 20/50',
    desc: 'Seguimiento de tendencia con confirmación de volumen.',
    tf: 'H1', pairs: 'Mayores', winRate: 54, profitFactor: 1.52,
    signals30d: 41, risk: 'Bajo', active: true,
    equity: equityCurve('ema', 0.06),
  },
  {
    id: 'rsi-div',
    name: 'Divergencia RSI',
    desc: 'Reversión en sobrecompra/sobreventa con divergencia confirmada.',
    tf: 'H4', pairs: 'Mayores + Menores', winRate: 58, profitFactor: 1.67,
    signals30d: 14, risk: 'Medio', active: false,
    equity: equityCurve('rsi', 0.05),
  },
  {
    id: 'order-blocks',
    name: 'Order Blocks (SMC)',
    desc: 'Zonas institucionales de oferta y demanda con mitigación.',
    tf: 'H1', pairs: 'EURUSD · GBPJPY', winRate: 48, profitFactor: 2.10,
    signals30d: 18, risk: 'Alto', active: false,
    equity: equityCurve('smc', 0.04),
  },
  {
    id: 'asian-grid',
    name: 'Rejilla asiática',
    desc: 'Reversión a la media dentro del rango nocturno de baja volatilidad.',
    tf: 'M5', pairs: 'USDJPY · AUDUSD', winRate: 72, profitFactor: 1.31,
    signals30d: 63, risk: 'Alto', active: false,
    equity: equityCurve('grid', 0.03),
  },
];

/* ---------------- Señales del modelo IA ---------------- */

export type Direction = 'buy' | 'sell';

export interface AISignal {
  id: string;
  symbol: string;
  tf: string;
  direction: Direction;
  pattern: string;
  strategy: string;
  confidence: number;   // 0-100
  time: number;         // timestamp de la vela
  candleIndex?: number; // índice sobre la serie del tf (solo señales simuladas)
  entry: number;
  stop: number;
  target: number;
  status: 'Activa' | 'Pendiente' | 'Cerrada';
  resultPips?: number;
  /* campos presentes solo cuando la señal viene del motor real */
  live?: boolean;
  overallScore?: number | null;    // 0-100 del sistema de scoring
  scores?: Record<string, number> | null; // desglose 0-5 por dimensión
  aiThesis?: string | null;
}

const PATTERNS: { name: string; dir: Direction }[] = [
  { name: 'Doble suelo', dir: 'buy' },
  { name: 'Bandera alcista', dir: 'buy' },
  { name: 'Envolvente alcista', dir: 'buy' },
  { name: 'Pin bar en soporte', dir: 'buy' },
  { name: 'Ruptura de rango', dir: 'buy' },
  { name: 'Hombro-cabeza-hombro', dir: 'sell' },
  { name: 'Envolvente bajista', dir: 'sell' },
  { name: 'Doble techo', dir: 'sell' },
  { name: 'Divergencia bajista RSI', dir: 'sell' },
];

const signalCache = new Map<string, AISignal[]>();

/** Señales deterministas ancladas a velas reales de la serie. */
export function getSignals(symbol: string, tfId: string): AISignal[] {
  const key = `${symbol}:${tfId}`;
  const cached = signalCache.get(key);
  if (cached) return cached;

  const pair = pairBySymbol(symbol);
  const { candles } = getSeries(symbol, tfId);
  const rnd = mulberry32(hashSeed('signals:' + key));
  const count = 5;
  const out: AISignal[] = [];

  for (let i = 0; i < count; i++) {
    // señales repartidas por el último tercio de la serie
    const idx = Math.floor(candles.length * (0.55 + (i / count) * 0.42) + rnd() * 8);
    const candle = candles[Math.min(idx, candles.length - 1)];
    const pat = PATTERNS[Math.floor(rnd() * PATTERNS.length)];
    const entry = candle[4];
    const risk = pair.pip * (18 + rnd() * 30);
    const rr = 1.5 + rnd() * 1.4;
    const sign = pat.dir === 'buy' ? 1 : -1;
    const isLast = i === count - 1;

    out.push({
      id: `${key}:${i}`,
      symbol,
      tf: tfId,
      direction: pat.dir,
      pattern: pat.name,
      strategy: STRATEGIES[Math.floor(rnd() * STRATEGIES.length)].name,
      confidence: Math.round(62 + rnd() * 32),
      time: candle[0],
      candleIndex: Math.min(idx, candles.length - 1),
      entry,
      stop: roundTo(entry - sign * risk, pair.decimals),
      target: roundTo(entry + sign * risk * rr, pair.decimals),
      status: isLast ? 'Activa' : i === count - 2 ? 'Pendiente' : 'Cerrada',
      resultPips: isLast || i === count - 2 ? undefined : Math.round((rnd() - 0.3) * 90),
    });
  }

  signalCache.set(key, out);
  return out;
}

function roundTo(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/** Señales de todos los pares para el escáner (tabla inferior / panel IA). */
export function getScannerSignals(): AISignal[] {
  const tfs = ['M15', 'H1', 'H4'];
  const all: AISignal[] = [];
  for (const p of PAIRS.slice(0, 10)) {
    const tf = tfs[hashSeed(p.symbol) % tfs.length];
    all.push(...getSignals(p.symbol, tf).slice(-2));
  }
  return all.sort((a, b) => b.time - a.time).slice(0, 12);
}

/* ---------------- Sesiones de mercado ---------------- */

export interface Session {
  name: string;
  openUtc: number;  // hora UTC
  closeUtc: number;
}

export const SESSIONS: Session[] = [
  { name: 'Sídney', openUtc: 21, closeUtc: 6 },
  { name: 'Tokio', openUtc: 0, closeUtc: 9 },
  { name: 'Londres', openUtc: 7, closeUtc: 16 },
  { name: 'Nueva York', openUtc: 12, closeUtc: 21 },
];

export function isSessionOpen(s: Session, utcHour: number): boolean {
  return s.openUtc < s.closeUtc
    ? utcHour >= s.openUtc && utcHour < s.closeUtc
    : utcHour >= s.openUtc || utcHour < s.closeUtc;
}

/* ---------------- Formato ---------------- */

export function fmtPrice(v: number, decimals: number): string {
  return v.toFixed(decimals);
}

export function fmtPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

export function fmtPips(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
}

export function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(t: number): string {
  return new Date(t).toLocaleString('es-ES', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}
