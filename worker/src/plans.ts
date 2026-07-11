import type { Env } from './types';

/* Límites operativos derivados del plan contratado en cada proveedor.

   Dos variables (wrangler.jsonc → vars) dimensionan todo el sistema:

   - TWELVEDATA_PLAN        free | grow | pro | expert | enterprise
     Marca el ritmo de la ingesta (créditos/min) y cuántas páginas de
     backfill se piden por símbolo+intervalo en cada ejecución.

   - CLOUDFLARE_WORKERS_PLAN  free | paid
     En el plan free cada put de KV cuenta contra 1000/día (los get tienen
     100k/día, no son el problema). Con "free" el sistema minimiza
     escrituras: rate limit público en memoria del isolate y cachés KV con
     TTL más largo. Con "paid" (1M escrituras/mes) se recupera la
     precisión y frescura completas.

   Si un plan cambia de límites, basta ajustar la tabla correspondiente. */

export interface TwelveDataLimits {
  plan: string;
  /** créditos (peticiones) por minuto del plan */
  creditsPerMin: number;
  /** segundos de espera entre peticiones de ingesta (step.sleep) */
  sleepSeconds: number;
  /** páginas máximas por símbolo+intervalo y ejecución (backfill) */
  maxPagesPerCombo: number;
  /** créditos/día del plan; null = sin límite diario */
  dailyCredits: number | null;
}

// https://twelvedata.com/pricing — créditos/min por plan; ajustar aquí si
// el proveedor cambia las tarifas o el tier contratado difiere
const TD_PLANS: Record<string, TwelveDataLimits> = {
  free:       { plan: 'free',       creditsPerMin: 8,    sleepSeconds: 9, maxPagesPerCombo: 2, dailyCredits: 800 },
  grow:       { plan: 'grow',       creditsPerMin: 55,   sleepSeconds: 2, maxPagesPerCombo: 4, dailyCredits: null },
  pro:        { plan: 'pro',        creditsPerMin: 610,  sleepSeconds: 1, maxPagesPerCombo: 8, dailyCredits: null },
  expert:     { plan: 'expert',     creditsPerMin: 1795, sleepSeconds: 1, maxPagesPerCombo: 8, dailyCredits: null },
  enterprise: { plan: 'enterprise', creditsPerMin: 1795, sleepSeconds: 1, maxPagesPerCombo: 8, dailyCredits: null },
};

export function twelveDataLimits(env: Env): TwelveDataLimits {
  return TD_PLANS[(env.TWELVEDATA_PLAN ?? 'free').trim().toLowerCase()] ?? TD_PLANS.free;
}

export interface WorkersLimits {
  plan: 'free' | 'paid';
  /** true → cada put de KV cuenta contra 1000/día: minimizarlos */
  kvWritesScarce: boolean;
  /** TTL (s) de la caché KV de /api/health */
  healthCacheTtl: number;
  /** TTL (s) de la caché KV de /api/market-state */
  marketStateCacheTtl: number;
}

export function workersLimits(env: Env): WorkersLimits {
  const paid = (env.CLOUDFLARE_WORKERS_PLAN ?? 'free').trim().toLowerCase() === 'paid';
  return paid
    ? { plan: 'paid', kvWritesScarce: false, healthCacheTtl: 60, marketStateCacheTtl: 300 }
    // free: health 300 s (≤288 puts/día) + market-state 600 s (≤144) +
    // pipeline ~3 puts/run × 96 runs (~290) deja margen dentro de 1000/día
    : { plan: 'free', kvWritesScarce: true, healthCacheTtl: 300, marketStateCacheTtl: 600 };
}
