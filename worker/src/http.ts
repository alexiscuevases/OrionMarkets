import { workersLimits } from './plans';
import type { Env } from './types';

/* Seguridad y utilidades HTTP (Fase 8).

   - CORS configurable: ALLOWED_ORIGINS (lista separada por comas) o '*'
     por compatibilidad si no se define.
   - Auth de administración: Authorization: Bearer <ADMIN_API_KEY> para
     endpoints mutantes/caros. Sin el secret configurado, esos endpoints
     devuelven 503 (cerrado por defecto, nunca abierto por accidente).
   - Rate limiting por IP: ventana fija de 60 s. Contador en memoria del
     isolate como primera línea (0 escrituras KV) y KV como registro
     compartido entre isolates — pero en el plan free de Workers cada put
     cuenta contra 1000/día, así que solo las rutas críticas (login) pagan
     KV; el resto va solo en memoria (plans.ts). get+put no es atómico —
     con ráfagas concurrentes puede dejar pasar alguna petición de más;
     suficiente contra abuso, no contra un ataque dirigido (mitigación
     completa: Durable Objects o WAF, documentado en P2). */

export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS ?? '*').trim();
  const origin = request.headers.get('Origin');

  let allowOrigin = '';
  if (allowed === '*') {
    allowOrigin = '*';
  } else if (origin) {
    const list = allowed.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.includes(origin)) allowOrigin = origin;
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (allowOrigin) {
    headers['Access-Control-Allow-Origin'] = allowOrigin;
    if (allowOrigin !== '*') headers['Vary'] = 'Origin';
  }
  return headers;
}

export function jsonWith(
  cors: Record<string, string>,
  data: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors, ...extra },
  });
}

/** Comparación en tiempo constante para tokens y API keys. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

export type AuthResult = { ok: true } | { ok: false; status: number; error: string };

/** Exige Bearer ADMIN_API_KEY. Sin secret configurado → 503, nunca abierto. */
export function requireAdmin(request: Request, env: Env): AuthResult {
  if (!env.ADMIN_API_KEY) {
    return {
      ok: false,
      status: 503,
      error: 'endpoint deshabilitado: falta configurar ADMIN_API_KEY (wrangler secret put ADMIN_API_KEY)',
    };
  }
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !safeEqual(token, env.ADMIN_API_KEY)) {
    return { ok: false, status: 401, error: 'no autorizado' };
  }
  return { ok: true };
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

/** Contadores por isolate: subcuentan frente al total real (varios
    isolates/colos), así que solo sirven para bloquear, nunca para dar por
    libre a quien KV marcaría como excedido. */
const memWindows = new Map<string, { window: number; count: number }>();

/**
 * Ventana fija de 60 s por clave (IP + clase de ruta). Falla en abierto:
 * si KV no responde, la petición pasa — antes disponibilidad que un 500
 * por culpa del limitador.
 *
 * `critical: true` fuerza el registro en KV (precisión entre isolates)
 * incluso en el plan free de Workers; reservado para rutas de bajo
 * volumen donde el límite es de seguridad (login/registro).
 */
export async function rateLimit(
  env: Env,
  key: string,
  limit: number,
  opts: { critical?: boolean } = {},
): Promise<RateLimitResult> {
  const window = Math.floor(Date.now() / 60_000);

  // poda perezosa: las ventanas pasadas ya no cuentan
  if (memWindows.size > 5000) {
    for (const [k, v] of memWindows) if (v.window !== window) memWindows.delete(k);
  }
  const mem = memWindows.get(key);
  const memCount = mem?.window === window ? mem.count : 0;
  if (memCount >= limit) return { allowed: false, remaining: 0, limit };
  memWindows.set(key, { window, count: memCount + 1 });

  // plan free de Workers: los puts de KV son escasos (1000/día) — las rutas
  // no críticas se conforman con el contador en memoria
  if (workersLimits(env).kvWritesScarce && !opts.critical) {
    return { allowed: true, remaining: limit - memCount - 1, limit };
  }

  const kvKey = `rl:${key}:${window}`;
  try {
    const current = Number((await env.CACHE.get(kvKey)) ?? '0');
    if (current >= limit) return { allowed: false, remaining: 0, limit };
    // TTL mínimo de KV = 60 s; 120 cubre la ventana con margen
    await env.CACHE.put(kvKey, String(current + 1), { expirationTtl: 120 });
    return { allowed: true, remaining: limit - current - 1, limit };
  } catch {
    return { allowed: true, remaining: limit, limit };
  }
}

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** Body JSON con límite de tamaño; null si no es JSON válido o excede. */
export async function readJsonBody(request: Request, maxBytes = 256 * 1024): Promise<unknown | null> {
  const len = Number(request.headers.get('Content-Length') ?? '0');
  if (len > maxBytes) return null;
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
