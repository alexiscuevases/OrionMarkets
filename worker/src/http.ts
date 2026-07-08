import type { Env } from './types';

/* Seguridad y utilidades HTTP (Fase 8).

   - CORS configurable: ALLOWED_ORIGINS (lista separada por comas) o '*'
     por compatibilidad si no se define.
   - Auth de administración: Authorization: Bearer <ADMIN_API_KEY> para
     endpoints mutantes/caros. Sin el secret configurado, esos endpoints
     devuelven 503 (cerrado por defecto, nunca abierto por accidente).
   - Rate limiting por IP en KV: ventana fija de 60 s. get+put no es
     atómico — con ráfagas concurrentes puede dejar pasar alguna petición
     de más; suficiente contra abuso, no contra un ataque dirigido
     (mitigación completa: Durable Objects o WAF, documentado en P2). */

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

/** Comparación en tiempo constante para el API key. */
function safeEqual(a: string, b: string): boolean {
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

/**
 * Ventana fija de 60 s por clave (IP + clase de ruta). Falla en abierto:
 * si KV no responde, la petición pasa — antes disponibilidad que un 500
 * por culpa del limitador.
 */
export async function rateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
): Promise<RateLimitResult> {
  const window = Math.floor(Date.now() / 60_000);
  const kvKey = `rl:${key}:${window}`;
  try {
    const current = Number((await kv.get(kvKey)) ?? '0');
    if (current >= limit) return { allowed: false, remaining: 0, limit };
    // TTL mínimo de KV = 60 s; 120 cubre la ventana con margen
    await kv.put(kvKey, String(current + 1), { expirationTtl: 120 });
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
