import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { findUserByEmail, verifyPassword } from './users.js';
import { asyncHandler } from './asyncHandler.js';

const COOKIE_NAME = 'maia_session';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const TOKEN_EXPIRES_IN = '7d';
// Ventana de renovación (feature 5): si al token le queda menos de esto para
// expirar, una request autenticada re-emite la cookie con una expiración
// nueva de 7 días. Fuera de esa ventana no se toca la cookie — evita un
// `Set-Cookie` en cada request. Configurable por `AUTH_REFRESH_WINDOW_MS`
// (ver docs/architecture.md §12) o por la opción `refreshWindowMs` de la
// factory (tests). Default: último día de vida de un token de 7 días.
const DEFAULT_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000; // 1 día

function positiveNumberFromEnv(name) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function resolveSecret(explicit) {
  if (explicit) return explicit;
  const env = process.env.AUTH_SECRET;
  if (env && env.trim()) return env.trim();
  const generated = crypto.randomBytes(48).toString('hex');
  // eslint-disable-next-line no-console
  console.warn(
    '[auth] AUTH_SECRET no configurada — se generó un secreto aleatorio para esta sesión. ' +
      'Las cookies emitidas no sobrevivirán a un reinicio del proceso.',
  );
  return generated;
}

function cookieOptions({ secure } = {}) {
  return {
    httpOnly: true,
    // cross-origin (Vercel → Render): SameSite=none requiere Secure=true
    sameSite: secure ? 'none' : 'lax',
    secure: Boolean(secure),
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS,
  };
}

function publicUser(user) {
  if (!user) return null;
  return { id: Number(user.id), email: user.email, name: user.name || '', role: user.role || 'editor' };
}

/**
 * Factory que devuelve un `Router` con los endpoints de auth y el helper `requireAuth`.
 *
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool
 * @param {string} [opts.schema='public']
 * @param {string} [opts.secret] - sobreescribe `process.env.AUTH_SECRET` (útil en tests).
 * @param {boolean} [opts.cookieSecure] - si true, marca la cookie como Secure.
 * @param {import('express').RequestHandler} [opts.rateLimiter] - middleware de
 *   rate limit (ver `src/rateLimit.js`), aplicado solo a `POST /api/auth/login`.
 *   Se inyecta ya construido desde `createApp` (feature 3); si no se pasa, no
 *   se limita.
 * @param {number} [opts.refreshWindowMs] - sobreescribe `AUTH_REFRESH_WINDOW_MS`/
 *   el default (feature 5, ver docs/architecture.md §8 y §12).
 * @param {() => number} [opts.now] - reloj inyectable (default `Date.now`) usado
 *   solo para decidir si un token está dentro de la ventana de renovación; los
 *   tests lo sobreescriben para no depender de esperas reales.
 * @returns {{ router: import('express').Router, requireAuth: Function, verifyToken: Function }}
 */
export function createAuthRouter({ pool, schema = 'public', secret, cookieSecure, rateLimiter, refreshWindowMs, now = Date.now } = {}) {
  if (!pool) throw new Error('createAuthRouter requiere un `pool` PostgreSQL');
  if (typeof now !== 'function') throw new Error('createAuthRouter requiere que `now` sea una función');
  const resolvedSecret = resolveSecret(secret);
  const cookieOpts = cookieOptions({ secure: cookieSecure ?? process.env.NODE_ENV === 'production' });
  const resolvedRefreshWindowMs = refreshWindowMs ?? positiveNumberFromEnv('AUTH_REFRESH_WINDOW_MS') ?? DEFAULT_REFRESH_WINDOW_MS;

  function signToken(user) {
    return jwt.sign({ sub: String(user.id), email: user.email }, resolvedSecret, {
      algorithm: 'HS256',
      expiresIn: TOKEN_EXPIRES_IN,
    });
  }

  function verifyToken(token) {
    try {
      return jwt.verify(token, resolvedSecret, { algorithms: ['HS256'] });
    } catch {
      return null;
    }
  }

  // Devuelve tanto el usuario (recargado de DB, invariante I5) como el
  // payload decodificado del token — este último hace falta para decidir si
  // toca renovar la cookie (necesita `exp`), sin tener que volver a verificar
  // el JWT en cada sitio que ya cargó la sesión.
  async function loadSession(req) {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return { user: null, payload: null };
    const payload = verifyToken(token);
    if (!payload?.sub) return { user: null, payload: null };
    const { rows } = await pool.query(
      `SELECT id, email, name, role, created_at FROM "${schema}".users WHERE id = $1 LIMIT 1`,
      [payload.sub],
    );
    return { user: rows[0] || null, payload };
  }

  // Renovación de sesión (feature 5): si al token verificado le queda menos
  // de `resolvedRefreshWindowMs` para expirar, re-emite la cookie con una
  // expiración nueva de 7 días — nunca en cada request, solo dentro de esa
  // ventana. Reutiliza `cookieOpts` (el mismo objeto que usa el login) para
  // no duplicar la construcción de opciones: en producción eso es lo que
  // garantiza `httpOnly`/`sameSite: 'none'`/`secure: true`/`path: '/'`
  // (invariante I6 de CHECKPOINT.md). Un token ya expirado nunca llega aquí:
  // `verifyToken` ya lo habría rechazado antes (jwt.verify lanza
  // TokenExpiredError), así que `loadSession` habría devuelto `user: null` y
  // ni `requireAuth` ni `/me` llaman a esta función.
  function renewCookieIfNeeded(res, payload) {
    if (!payload?.sub || !payload?.exp) return;
    const remainingMs = payload.exp * 1000 - now();
    if (remainingMs <= 0 || remainingMs > resolvedRefreshWindowMs) return;
    const freshToken = signToken({ id: payload.sub, email: payload.email });
    res.cookie(COOKIE_NAME, freshToken, cookieOpts);
  }

  async function requireAuth(req, res, next) {
    try {
      const { user, payload } = await loadSession(req);
      if (!user) return res.status(401).json({ error: 'No autenticado' });
      renewCookieIfNeeded(res, payload);
      req.user = publicUser(user);
      next();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[auth] requireAuth error', err);
      res.status(500).json({ error: 'Error de autenticación' });
    }
  }

  const router = Router();
  const loginRateLimiter = rateLimiter ?? ((_req, _res, next) => next());

  router.post('/api/auth/login', loginRateLimiter, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const email = String(body.email || '').trim();
    const password = String(body.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y password requeridos' });
    }

    let user;
    try {
      user = await findUserByEmail(pool, email, { schema });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[auth] lookup error', err);
      return res.status(500).json({ error: 'Error de autenticación' });
    }

    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

    const ok = await verifyPassword(user, password);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = signToken(user);
    res.cookie(COOKIE_NAME, token, cookieOpts);
    res.json({ ok: true, user: publicUser(user) });
  }));

  router.post('/api/auth/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { ...cookieOpts, maxAge: undefined });
    res.json({ ok: true });
  });

  router.get('/api/auth/me', asyncHandler(async (req, res) => {
    try {
      const { user, payload } = await loadSession(req);
      if (!user) return res.status(401).json({ error: 'No autenticado' });
      renewCookieIfNeeded(res, payload);
      res.json({ user: publicUser(user) });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[auth] /me error', err);
      res.status(500).json({ error: 'Error de autenticación' });
    }
  }));

  return { router, requireAuth: asyncHandler(requireAuth), verifyToken };
}

export const AUTH_COOKIE_NAME = COOKIE_NAME;
