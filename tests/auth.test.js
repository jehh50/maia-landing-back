import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createPool, ensureSchema } from '../src/db.js';
import { createUser } from '../src/users.js';
import { AUTH_COOKIE_NAME } from '../src/auth.js';

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
