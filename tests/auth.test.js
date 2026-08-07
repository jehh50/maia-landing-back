import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createApp } from '../src/app.js';
import { createPool, ensureSchema } from '../src/db.js';
import { createUser } from '../src/users.js';
import { AUTH_COOKIE_NAME, createAuthRouter } from '../src/auth.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres:///maia-landing?host=/var/run/postgresql';

const schema = `maia_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const fakeMailer = {
  enabled: false,
  to: 'sales@test',
  async sendLead() {
    return { status: 'skipped', reason: 'tests-no-mail' };
  },
};

const seedUser = {
  email: 'admin@maia.test',
  password: 'Secret-123!',
  name: 'Admin de prueba',
};

let app;
let pool;

beforeAll(async () => {
  pool = createPool({ connectionString: TEST_DB_URL });
  await ensureSchema(pool, { schema });
  await createUser(pool, seedUser, { schema });
  app = createApp({ pool, schema, mailer: fakeMailer, corsOrigin: '*', authSecret: 'test-secret-please' });
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

function extractCookie(res) {
  const raw = res.headers['set-cookie'];
  if (!raw) return null;
  const arr = Array.isArray(raw) ? raw : [raw];
  const target = arr.find(c => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  return target || null;
}

describe('POST /api/auth/login', () => {
  it('401 con credenciales inválidas', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: seedUser.email, password: 'wrong-pass' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/credenciales/i);
    expect(extractCookie(res)).toBeNull();
  });

  it('401 cuando el usuario no existe', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'no-existe@maia.test', password: 'whatever' });
    expect(res.status).toBe(401);
  });

  it('400 si falta email o password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: '' });
    expect(res.status).toBe(400);
  });

  it('200 con credenciales válidas y setea la cookie de sesión httpOnly', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: seedUser.email, password: seedUser.password });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.email).toBe(seedUser.email);
    expect(res.body.user.name).toBe(seedUser.name);
    expect(typeof res.body.user.id).toBe('number');

    const cookie = extractCookie(res);
    expect(cookie).toBeTruthy();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\//i);
  });
});

describe('GET /api/auth/me', () => {
  it('401 sin cookie', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('200 con cookie válida y devuelve el usuario', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: seedUser.email, password: seedUser.password });
    const cookie = extractCookie(login);

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(seedUser.email);
    expect(res.body.user.name).toBe(seedUser.name);
  });

  it('401 con cookie manipulada', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `${AUTH_COOKIE_NAME}=not-a-valid-jwt`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('borra la cookie de sesión', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const raw = res.headers['set-cookie'];
    expect(raw).toBeTruthy();
    const arr = Array.isArray(raw) ? raw : [raw];
    const cleared = arr.find(c => c.startsWith(`${AUTH_COOKIE_NAME}=`));
    expect(cleared).toBeTruthy();
    // cookie-parser/clearCookie emite Expires en el pasado o un value vacío.
    expect(cleared).toMatch(/(Expires=|Max-Age=0|=;)/i);
  });
});

describe('users.createUser', () => {
  it('rechaza email duplicado', async () => {
    await expect(
      createUser(pool, { email: seedUser.email, password: 'otra' }, { schema }),
    ).rejects.toMatchObject({ code: 'email_taken' });
  });

  it('hashea la contraseña (no la persiste en texto plano)', async () => {
    const u = await createUser(
      pool,
      { email: 'hash@maia.test', password: 'super-secret' },
      { schema },
    );
    expect(u.id).toBeTruthy();
    const { rows } = await pool.query(
      `SELECT password_hash FROM "${schema}".users WHERE id = $1`,
      [u.id],
    );
    expect(rows[0].password_hash).not.toBe('super-secret');
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$/); // prefijo bcrypt
  });
});

describe('Renovación de sesión (feature 5)', () => {
  const TEST_SECRET = 'test-secret-refresh';
  let refreshUserId;

  beforeAll(async () => {
    const u = await createUser(
      pool,
      { email: 'refresh@maia.test', password: 'Secret-123!', name: 'Refresh User' },
      { schema },
    );
    refreshUserId = u.id;
  });

  /**
   * Firma un token "a mano" (sin pasar por `createAuthRouter`) para poder
   * controlar `exp` con precisión, sin depender de esperas reales ni de
   * `expiresIn`. `exp` va en segundos Unix — jwt.verify usa el reloj real
   * del sistema para decidir si expiró, así que sigue teniendo que ser
   * coherente con el `Date.now()` real; lo que sí es inyectable es el reloj
   * que `createAuthRouter` usa para decidir si toca *renovar*.
   */
  function signRaw(payload, secret = TEST_SECRET) {
    return jwt.sign(payload, secret, { algorithm: 'HS256' });
  }

  /** App mínima: solo el router de auth + una ruta protegida con `requireAuth`. */
  function buildAuthOnlyApp(overrides = {}) {
    const auth = createAuthRouter({ pool, schema, secret: TEST_SECRET, ...overrides });
    const app = express();
    app.use(cookieParser());
    app.use(auth.router);
    app.get('/protected', auth.requireAuth, (req, res) => res.json({ user: req.user }));
    return app;
  }

  function extractSessionCookie(res) {
    const raw = res.headers['set-cookie'];
    if (!raw) return null;
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr.find(c => c.startsWith(`${AUTH_COOKIE_NAME}=`)) || null;
  }

  it('token a punto de expirar (dentro de la ventana) re-emite la cookie con nueva expiración', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 300; // 5 min en el futuro real
    const token = signRaw({ sub: String(refreshUserId), email: 'refresh@maia.test', exp: expSeconds });
    // Reloj inyectado: simula que solo quedan 10s, dentro de una ventana de 60s.
    const fakeNow = () => expSeconds * 1000 - 10_000;
    const app = buildAuthOnlyApp({ refreshWindowMs: 60_000, now: fakeNow });

    const res = await request(app).get('/protected').set('Cookie', `${AUTH_COOKIE_NAME}=${token}`);
    expect(res.status).toBe(200);

    const cookie = extractSessionCookie(res);
    expect(cookie).toBeTruthy();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\//i);

    const newToken = cookie.split(';')[0].split('=')[1];
    const decoded = jwt.verify(newToken, TEST_SECRET);
    expect(decoded.sub).toBe(String(refreshUserId));
    expect(decoded.exp).toBeGreaterThan(expSeconds); // nueva expiración, más lejana
  });

  it('token lejos de expirar (fuera de la ventana) NO re-emite la cookie — no se renueva en cada request', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 3600; // 1h en el futuro real
    const token = signRaw({ sub: String(refreshUserId), email: 'refresh@maia.test', exp: expSeconds });
    // Reloj inyectado: simula que quedan 30 min, muy por encima de una ventana de 60s.
    const fakeNow = () => expSeconds * 1000 - 30 * 60 * 1000;
    const app = buildAuthOnlyApp({ refreshWindowMs: 60_000, now: fakeNow });

    const res = await request(app).get('/protected').set('Cookie', `${AUTH_COOKIE_NAME}=${token}`);
    expect(res.status).toBe(200);
    expect(extractSessionCookie(res)).toBeNull();
  });

  it('un token ya expirado sigue devolviendo 401 y nunca se renueva', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) - 10; // expiró hace 10s (reloj real)
    const token = signRaw({ sub: String(refreshUserId), email: 'refresh@maia.test', exp: expSeconds });
    // Ventana amplísima a propósito: aunque "cupiera" en la ventana, un token
    // caducado no debe renovarse jamás.
    const app = buildAuthOnlyApp({ refreshWindowMs: 24 * 60 * 60 * 1000 });

    const res = await request(app).get('/protected').set('Cookie', `${AUTH_COOKIE_NAME}=${token}`);
    expect(res.status).toBe(401);
    expect(extractSessionCookie(res)).toBeNull();
  });

  it('la ventana de renovación es configurable (equivalente a AUTH_REFRESH_WINDOW_MS)', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 300;
    const token = signRaw({ sub: String(refreshUserId), email: 'refresh@maia.test', exp: expSeconds });
    // Quedan 200s exactos en ambos casos (mismo reloj inyectado).
    const fakeNow = () => expSeconds * 1000 - 200_000;

    const strictApp = buildAuthOnlyApp({ refreshWindowMs: 100_000, now: fakeNow }); // 200s > 100s → no renueva
    const r1 = await request(strictApp).get('/protected').set('Cookie', `${AUTH_COOKIE_NAME}=${token}`);
    expect(extractSessionCookie(r1)).toBeNull();

    const wideApp = buildAuthOnlyApp({ refreshWindowMs: 250_000, now: fakeNow }); // 200s < 250s → renueva
    const r2 = await request(wideApp).get('/protected').set('Cookie', `${AUTH_COOKIE_NAME}=${token}`);
    expect(extractSessionCookie(r2)).toBeTruthy();
  });

  it('el rol se sigue recargando desde DB en cada request (invariante I5) aunque la cookie se renueve', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 300;
    const token = signRaw({ sub: String(refreshUserId), email: 'refresh@maia.test', exp: expSeconds });
    const fakeNow = () => expSeconds * 1000 - 10_000;
    const app = buildAuthOnlyApp({ refreshWindowMs: 60_000, now: fakeNow });

    // El token no lleva el rol (payload solo trae sub/email). Promovemos al
    // usuario a admin directamente en DB y comprobamos que la respuesta ya
    // refleja ese cambio, sin volver a hacer login.
    await pool.query(`UPDATE "${schema}".users SET role = 'admin' WHERE id = $1`, [refreshUserId]);
    const res = await request(app).get('/protected').set('Cookie', `${AUTH_COOKIE_NAME}=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin');

    await pool.query(`UPDATE "${schema}".users SET role = 'editor' WHERE id = $1`, [refreshUserId]);
  });

  it('POST /api/auth/logout no dispara renovación (nunca re-emite maia_session con expiración nueva)', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 300;
    const token = signRaw({ sub: String(refreshUserId), email: 'refresh@maia.test', exp: expSeconds });
    const app = buildAuthOnlyApp({ refreshWindowMs: 24 * 60 * 60 * 1000 }); // ventana amplia a propósito

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `${AUTH_COOKIE_NAME}=${token}`);
    expect(res.status).toBe(200);

    const cookie = extractSessionCookie(res);
    expect(cookie).toBeTruthy();
    // Cookie de borrado, no una renovación: Expires en el pasado / Max-Age=0 / valor vacío.
    expect(cookie).toMatch(/(Expires=|Max-Age=0|=;)/i);
    const value = cookie.split(';')[0].split('=')[1];
    expect(value === '' || value === undefined).toBe(true);
  });

  it('la cookie renovada conserva exactamente httpOnly/sameSite/secure/path que la original (invariante I6)', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 300;
    const token = signRaw({ sub: String(refreshUserId), email: 'refresh@maia.test', exp: expSeconds });
    const fakeNow = () => expSeconds * 1000 - 10_000;
    // cookieSecure: true simula producción → SameSite=None; Secure (I6 de CHECKPOINT.md).
    const app = buildAuthOnlyApp({ refreshWindowMs: 60_000, now: fakeNow, cookieSecure: true });

    const res = await request(app).get('/protected').set('Cookie', `${AUTH_COOKIE_NAME}=${token}`);
    const cookie = extractSessionCookie(res);
    expect(cookie).toBeTruthy();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=None/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/Path=\//i);
  });
});
