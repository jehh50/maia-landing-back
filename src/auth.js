import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { findUserByEmail, verifyPassword } from './users.js';

const COOKIE_NAME = 'maia_session';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const TOKEN_EXPIRES_IN = '7d';

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
 * @returns {{ router: import('express').Router, requireAuth: Function, verifyToken: Function }}
 */
export function createAuthRouter({ pool, schema = 'public', secret, cookieSecure } = {}) {
  if (!pool) throw new Error('createAuthRouter requiere un `pool` PostgreSQL');
  const resolvedSecret = resolveSecret(secret);
  const cookieOpts = cookieOptions({ secure: cookieSecure ?? process.env.NODE_ENV === 'production' });

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

  async function loadUserFromCookie(req) {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return null;
    const payload = verifyToken(token);
    if (!payload?.sub) return null;
    const { rows } = await pool.query(
      `SELECT id, email, name, role, created_at FROM "${schema}".users WHERE id = $1 LIMIT 1`,
      [payload.sub],
    );
    return rows[0] || null;
  }

  async function requireAuth(req, res, next) {
    try {
      const user = await loadUserFromCookie(req);
      if (!user) return res.status(401).json({ error: 'No autenticado' });
      req.user = publicUser(user);
      next();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[auth] requireAuth error', err);
      res.status(500).json({ error: 'Error de autenticación' });
    }
  }

  const router = Router();

  router.post('/api/auth/login', async (req, res) => {
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
  });

  router.post('/api/auth/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { ...cookieOpts, maxAge: undefined });
    res.json({ ok: true });
  });

  router.get('/api/auth/me', async (req, res) => {
    try {
      const user = await loadUserFromCookie(req);
      if (!user) return res.status(401).json({ error: 'No autenticado' });
      res.json({ user: publicUser(user) });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[auth] /me error', err);
      res.status(500).json({ error: 'Error de autenticación' });
    }
  });

  return { router, requireAuth, verifyToken };
}

export const AUTH_COOKIE_NAME = COOKIE_NAME;
