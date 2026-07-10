/* Cliente de la API de orion-markets-worker (Cloudflare).
   Sobrescribible con VITE_API_URL (p. ej. http://localhost:8787 con `wrangler dev`). */

export const API_BASE: string =
  import.meta.env.VITE_API_URL ?? 'https://orion-markets-worker.alexcuevas.workers.dev';

const TIMEOUT_MS = 8000;
/* El login/registro deriva la contraseña (PBKDF2) y puede coincidir con un
   arranque frío del worker (sobre todo en local); margen más generoso. */
const AUTH_TIMEOUT_MS = 20_000;
/* Un backtest recorre hasta 50k velas con todos los detectores. */
const BACKTEST_TIMEOUT_MS = 60_000;

/* ---------- sesión (auth con D1 en el worker) ---------- */

const TOKEN_KEY = 'orion.session';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** Se emite cuando el worker devuelve 401: la sesión caducó o no existe. */
export const UNAUTHORIZED_EVENT = 'orion:unauthorized';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(
      path.startsWith('/api/auth/') ? AUTH_TIMEOUT_MS
      : path === '/api/backtest' ? BACKTEST_TIMEOUT_MS
      : TIMEOUT_MS,
    ),
  });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    // sesión inválida: se limpia y la AuthGate vuelve a pedir login
    setToken(null);
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `API ${res.status} en ${path}`);
  }
  return res.json() as Promise<T>;
}

const get = <T,>(path: string): Promise<T> => request<T>(path);

const post = <T,>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

/* ---------- formas de respuesta del worker ---------- */

export interface ApiUser {
  id: number;
  email: string;
  role: 'admin' | 'user';
}

export interface ApiSession {
  token: string;
  expiresAt: number;
  user: ApiUser;
}

export interface ApiHealth {
  ok: boolean;
  universe: { symbols: string[]; intervals: string[] };
  lastRun: {
    finishedAt: string;
    trigger: string;
    ingested: number;
    newSignals: number;
    evaluated: number;
    topScore: number;
  } | null;
}

export interface ApiCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ApiSignal {
  sigKey: string;
  symbol: string;
  interval: string;
  ts: number;
  pattern: string;
  direction: 'buy' | 'sell';
  entry: number;
  stop: number;
  target: number;
  rr: number;
  confidence: number;
  outcome: 'open' | 'tp_hit' | 'sl_hit' | 'expired';
  outcomeTs: number | null;
  aiAction: 'buy' | 'sell' | 'skip' | null;
  aiConfidence: number | null;
  aiThesis: string | null;
  aiRisks?: string | null;
  scoresJson: string | null;
  contextJson?: string | null;
  overallScore: number | null;
  evalRevision?: number | null;
  evalUpdatedAt?: number | null;
}

/** Estado de mercado por símbolo calculado por el motor sobre la serie 1h. */
export interface ApiMarketState {
  symbol: string;
  trend: 'alcista' | 'bajista' | 'lateral';
  trendStrength: 'fuerte' | 'moderada' | 'débil' | null;
  volatility: 'muy baja' | 'baja' | 'media' | 'alta' | 'muy alta';
  atrPct: number;
  rsi14: number;
  aboveEma200: boolean | null;
  lastCandleTs: number;
  news: string | null;
}

/** Calibración empírica de la confianza IA por tramo (acierto real). */
export interface ApiCalibrationBucket {
  bucket: 'lt50' | '50-64' | '65-79' | '80plus';
  n: number;
  tpRate: number;
  avgRr: number;
  expectancy: number;
}

/** Agregado de rendimiento por patrón (ventana de N días). */
export interface ApiPatternAgg {
  pattern: string;
  total: number;
  open: number;
  tp: number;
  sl: number;
  expired: number;
  grossR: number;
}

/** Cierre individual para reconstruir la curva de resultados. */
export interface ApiClosedTrade {
  pattern: string;
  outcome: 'tp_hit' | 'sl_hit';
  rr: number;
  outcomeTs: number;
}

export interface ApiStrategies {
  days: number;
  patterns: ApiPatternAgg[];
  closed: ApiClosedTrade[];
}

/* ---------- administración (rol admin o ADMIN_API_KEY) ---------- */

/** Fila de pipeline_runs con contadores del run (observe.ts). */
export interface ApiRunSummary {
  id: string;
  trigger: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  status: 'running' | 'success' | 'error' | 'skipped' | string;
  error: string | null;
  counters: Record<string, number> | null;
}

export interface ApiAiUsage {
  calls: number;
  errors: number;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  avgLatencyMs: number | null;
  byKind: { kind: string; calls: number; errors: number; estCostUsd: number }[];
}

export interface ApiFreshness {
  symbol: string;
  interval: string;
  lastCandleTs: number | null;
  ageMs: number | null;
  stale: boolean;
}

/** Informe completo de /api/health (healthReport del worker). */
export interface ApiHealthReport {
  ok: boolean;
  generatedAt: number;
  universe: { symbols: string[]; intervals: string[] };
  lastRun: Record<string, unknown> | null;
  pipeline: {
    ok: boolean;
    lastSuccess: ApiRunSummary | null;
    lastError: ApiRunSummary | null;
    recentRuns: ApiRunSummary[];
  };
  data: {
    ok: boolean;
    staleMarkets: ApiFreshness[];
    freshness: ApiFreshness[];
    openSignals: number;
  };
  ai: { ok: boolean; last24h: ApiAiUsage };
  vector: { indexed: number; totalClosed: number };
}

export interface ApiAdminMetrics {
  health: ApiHealthReport;
  ai7d: ApiAiUsage;
  tables: Record<string, number>;
  recentBacktests: {
    id: string;
    createdAt: number;
    symbol: string;
    interval: string;
    trades: number;
    detectorVersion: string;
  }[];
  versions: { detector: string; prompt: string; strategy: string; model: string };
}

export interface ApiBacktestRequest {
  symbol: string;
  interval: string;
  from: string | number;
  to: string | number;
  patterns?: string[];
  minConfidence?: number;
  initialBalance?: number;
  riskPct?: number;
}

export interface ApiBacktestTrade {
  ts: number;
  pattern: string;
  direction: 'buy' | 'sell';
  entry: number;
  stop: number;
  target: number;
  rr: number;
  confidence: number;
  outcome: 'tp_hit' | 'sl_hit' | 'expired';
  outcomeTs: number;
  r: number;
}

export interface ApiPatternPerf {
  pattern: string;
  trades: number;
  wins: number;
  losses: number;
  expired: number;
  winRate: number | null;
  netR: number;
  expectancyR: number | null;
}

export interface ApiBacktestMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  expired: number;
  openAtEnd: number;
  winRate: number | null;
  profitFactor: number | null;
  expectancyR: number | null;
  avgRr: number | null;
  netR: number;
  maxDrawdownR: number;
  maxDrawdownPct: number;
  finalBalance: number;
  returnPct: number;
  equityCurve: { ts: number; r: number; balance: number }[];
  monthly: { month: string; trades: number; wins: number; losses: number; netR: number }[];
  byPattern: ApiPatternPerf[];
  bestPattern: string | null;
  worstPattern: string | null;
}

export interface ApiBacktestResult {
  id: string;
  symbol: string;
  interval: string;
  fromTs: number;
  toTs: number;
  detectorVersion: string;
  params: {
    initialBalance: number;
    riskPct: number;
    minConfidence: number;
    patterns?: string[];
  };
  candlesUsed?: number;
  metrics: ApiBacktestMetrics;
  /** Solo en la respuesta de POST /api/backtest; los guardados no los conservan. */
  trades?: ApiBacktestTrade[];
}

/** Backtest guardado en D1: sin lista de trades (la columna es su recuento). */
export type ApiBacktestStored = Omit<ApiBacktestResult, 'trades'> & { trades: number };

export interface ApiBacktestSummary {
  id: string;
  createdAt: number;
  symbol: string;
  interval: string;
  fromTs: number;
  toTs: number;
  trades: number;
  detectorVersion: string;
  paramsJson: string;
}

export interface ApiPaperAccount {
  id: number;
  name: string;
  initialBalance: number;
  balance: number;
  riskPct: number;
  minScore: number;
  maxOpenPositions: number;
  maxTotalRiskPct: number;
  createdAt: number;
  updatedAt: number;
}

export interface ApiPaperPosition {
  sigKey: string;
  symbol: string;
  interval: string;
  direction: 'buy' | 'sell';
  entry: number;
  stop: number;
  target: number;
  units: number;
  lots: number;
  riskAmount: number;
  riskPct: number;
  openedAt: number;
}

export interface ApiPaperTrade {
  sigKey?: string;
  symbol: string;
  interval: string;
  direction: 'buy' | 'sell';
  pattern: string;
  entry: number;
  exitPrice: number;
  plAmount: number;
  plR: number;
  outcome: string;
  openedAt: number;
  closedAt: number;
  balanceAfter: number;
}

export interface ApiPaperSummary {
  account: ApiPaperAccount;
  openPositions: ApiPaperPosition[];
  stats: {
    totalTrades: number;
    wins: number;
    losses: number;
    expired: number;
    winRate: number | null;
    netPl: number;
    netR: number;
    maxDrawdownPct: number;
    returnPct: number;
  };
  equityCurve: { ts: number; balance: number }[];
}

export interface ApiMarketEvent {
  ts: number;
  currency: string;
  impact: 'high' | 'medium' | 'low' | string;
  title: string;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
}

export const api = {
  login: (email: string, password: string) =>
    post<ApiSession>('/api/auth/login', { email, password }),

  register: (email: string, password: string) =>
    post<ApiSession>('/api/auth/register', { email, password }),

  logout: () => post<{ ok: boolean }>('/api/auth/logout'),

  me: () => get<{ user: ApiUser }>('/api/auth/me'),

  health: () => get<ApiHealth>('/api/health'),

  candles: (symbol: string, interval: string, limit = 500) =>
    get<{ candles: ApiCandle[] }>(
      `/api/candles?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    ),

  signals: (symbol: string, interval: string, limit = 100) =>
    get<{ signals: ApiSignal[] }>(
      `/api/signals?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    ),

  opportunities: (limit = 20) =>
    get<{ opportunities: ApiSignal[] }>(`/api/opportunities?limit=${limit}`),

  strategies: (days = 30) => get<ApiStrategies>(`/api/strategies?days=${days}`),

  marketState: () =>
    get<{ states: ApiMarketState[]; generatedAt: number }>('/api/market-state'),

  learning: () => get<{ calibration: ApiCalibrationBucket[] }>('/api/learning'),

  /* --- administración: la sesión debe ser de un usuario con rol admin --- */

  adminMetrics: () => get<ApiAdminMetrics>('/api/admin/metrics'),

  pipelineRuns: (limit = 30) => get<{ runs: ApiRunSummary[] }>(`/api/runs?limit=${limit}`),

  triggerRun: () => post<{ id: string; status: unknown }>('/api/run'),

  runBacktest: (params: ApiBacktestRequest) =>
    post<ApiBacktestResult>('/api/backtest', params),

  backtests: () => get<{ backtests: ApiBacktestSummary[] }>('/api/backtests'),

  backtest: (id: string) => get<ApiBacktestStored>(`/api/backtests/${id}`),

  paperAccount: () => get<ApiPaperSummary>('/api/paper/account'),

  paperReset: (body: { initialBalance?: number; riskPct?: number; minScore?: number }) =>
    post<{ ok: boolean }>('/api/paper/reset', body),

  events: () => get<{ events: ApiMarketEvent[] }>('/api/events'),

  uploadEvents: (events: unknown[]) =>
    post<{ ok: boolean; received: number; upserted: number }>('/api/admin/events', { events }),
};
