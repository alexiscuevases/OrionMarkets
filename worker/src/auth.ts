import { clientIp, jsonWith, rateLimit, readJsonBody, safeEqual, type AuthResult } from './http';
import type { Env } from './types';

/* Autenticación de usuarios sobre D1.

   - Contraseñas: PBKDF2-SHA256 con salt aleatorio (WebCrypto). 100.000
     iteraciones = máximo que permite el runtime de Workers.
   - Sesiones: token aleatorio de 32 bytes entregado como Bearer; en D1
     solo se guarda su SHA-256, así un volcado de la base no sirve para
     suplantar a nadie. Caducidad fija de 30 días.
   - Registro: el primer usuario se convierte en admin (bootstrap); a
     partir de ahí solo se admite registro con ALLOW_SIGNUPS="true".
   - Admin: los endpoints de administración aceptan ADMIN_API_KEY (compat
     con scripts) o una sesión de un usuario con rol admin. */

const PBKDF2_ITERATIONS = 100_000; // límite superior en Workers
const SESSION_TTL_MS = 30 * 86_400_000;
/** Peticiones/min por IP a login/register (freno a fuerza bruta). */
const AUTH_RATE_LIMIT = 10;
/** last_used_at se refresca como mucho una vez cada 5 min (menos escrituras). */
const TOUCH_INTERVAL_MS = 5 * 60_000;

export interface SessionUser {
  id: number;
  email: string;
  role: 'admin' | 'user';
}

export type UserAuthResult = { ok: true; user: SessionUser } | { ok: false; status: number; error: string };

/* ---------- contraseñas ---------- */

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Formato almacenado: pbkdf2$<iteraciones>$<salt_b64>$<hash_b64>. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  try {
    const derived = await pbkdf2(password, fromB64(saltB64), iterations);
    return safeEqual(toB64(derived), hashB64);
  } catch {
    return false;
  }
}

/* ---------- sesiones ---------- */

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bearerToken(request: Request): string {
  const header = request.headers.get('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

async function createSession(db: D1Database, userId: number, request: Request): Promise<{ token: string; expiresAt: number }> {
  const token = newToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await sha256Hex(token), userId, now, expiresAt, now,
      clientIp(request), (request.headers.get('User-Agent') ?? '').slice(0, 200),
    )
    .run();
  return { token, expiresAt };
}

/** Resuelve un token de sesión a su usuario; null si no existe o caducó. */
export async function getSessionUser(db: D1Database, token: string): Promise<SessionUser | null> {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.role, s.last_used_at AS lastUsedAt
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(tokenHash, Date.now())
    .first<{ id: number; email: string; role: 'admin' | 'user'; lastUsedAt: number }>();
  if (!row) return null;

  if (Date.now() - row.lastUsedAt > TOUCH_INTERVAL_MS) {
    await db
      .prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?')
      .bind(Date.now(), tokenHash)
      .run();
  }
  return { id: row.id, email: row.email, role: row.role };
}

/** Exige una sesión válida (Bearer <token de /api/auth/login>). */
export async function requireUser(request: Request, env: Env): Promise<UserAuthResult> {
  const user = await getSessionUser(env.DB, bearerToken(request));
  if (!user) return { ok: false, status: 401, error: 'no autorizado: inicia sesión' };
  return { ok: true, user };
}

/** Admin por ADMIN_API_KEY (compat con scripts) o por sesión con rol admin. */
export async function requireAdminAuth(request: Request, env: Env): Promise<AuthResult> {
  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, error: 'no autorizado' };
  if (env.ADMIN_API_KEY && safeEqual(token, env.ADMIN_API_KEY)) return { ok: true };
  const user = await getSessionUser(env.DB, token);
  if (user?.role === 'admin') return { ok: true };
  return { ok: false, status: 401, error: 'no autorizado' };
}

/* ---------- rutas /api/auth/* ---------- */

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

function parseCredentials(body: unknown): { email: string; password: string } | null {
  if (!body || typeof body !== 'object') return null;
  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) return null;
  if (password.length < 8 || password.length > 200) return null;
  return { email: normalized, password };
}

/**
 * Despacha las rutas de autenticación; null si la ruta no es de auth.
 * Login y registro llevan su propio rate limit por IP, más estricto que
 * el de la API pública.
 */
export async function handleAuth(
  request: Request,
  env: Env,
  pathname: string,
  cors: Record<string, string>,
): Promise<Response | null> {
  if (!pathname.startsWith('/api/auth/')) return null;
  const json = (data: unknown, status = 200) => jsonWith(cors, data, status);

  if (pathname === '/api/auth/me' && request.method === 'GET') {
    const auth = await requireUser(request, env);
    if (!auth.ok) return json({ error: auth.error }, auth.status);
    return json({ user: auth.user });
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    const token = bearerToken(request);
    if (token) {
      await env.DB
        .prepare('DELETE FROM sessions WHERE token_hash = ?')
        .bind(await sha256Hex(token))
        .run();
    }
    return json({ ok: true });
  }

  const isLogin = pathname === '/api/auth/login' && request.method === 'POST';
  const isRegister = pathname === '/api/auth/register' && request.method === 'POST';
  if (!isLogin && !isRegister) return json({ error: 'ruta no encontrada' }, 404);

  // critical: login/registro mantienen el registro KV entre isolates incluso
  // en plan free (bajo volumen y el límite aquí es de seguridad)
  const rl = await rateLimit(env, `${clientIp(request)}:auth`, AUTH_RATE_LIMIT, { critical: true });
  if (!rl.allowed) {
    return jsonWith(cors, { error: 'demasiados intentos; espera un minuto' }, 429, { 'Retry-After': '60' });
  }

  const creds = parseCredentials(await readJsonBody(request));
  if (!creds) {
    return json({ error: 'body inválido; se espera {email, password} (contraseña de 8-200 caracteres)' }, 400);
  }

  if (isRegister) {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    const isFirstUser = (count?.n ?? 0) === 0;
    if (!isFirstUser && env.ALLOW_SIGNUPS !== 'true') {
      return json({ error: 'registro deshabilitado' }, 403);
    }
    const existing = await env.DB
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(creds.email)
      .first();
    if (existing) return json({ error: 'ese email ya está registrado' }, 409);

    const now = Date.now();
    const role = isFirstUser ? 'admin' : 'user';
    const inserted = await env.DB
      .prepare(
        `INSERT INTO users (email, password_hash, role, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(creds.email, await hashPassword(creds.password), role, now, now)
      .first<{ id: number }>();

    const session = await createSession(env.DB, inserted!.id, request);
    return json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: inserted!.id, email: creds.email, role },
    }, 201);
  }

  // login
  const user = await env.DB
    .prepare('SELECT id, email, role, password_hash AS passwordHash FROM users WHERE email = ?')
    .bind(creds.email)
    .first<{ id: number; email: string; role: 'admin' | 'user'; passwordHash: string }>();

  // sin usuario se verifica igualmente contra un hash ficticio para no
  // delatar por tiempo de respuesta qué emails existen
  const stored = user?.passwordHash
    ?? `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(new Uint8Array(16))}$${toB64(new Uint8Array(32))}`;
  const valid = await verifyPassword(creds.password, stored);
  if (!user || !valid) return json({ error: 'email o contraseña incorrectos' }, 401);

  const now = Date.now();
  // limpieza oportunista de sesiones caducadas + marca de último login
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now, user.id),
  ]);

  const session = await createSession(env.DB, user.id, request);
  return json({
    token: session.token,
    expiresAt: session.expiresAt,
    user: { id: user.id, email: user.email, role: user.role },
  });
}
