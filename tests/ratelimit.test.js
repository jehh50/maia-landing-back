import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createRateLimiter } from '../src/rateLimit.js';
import { createPool, ensureSchema } from '../src/db.js';
import { createUser } from '../src/users.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres:///maia-landing?host=/var/run/postgresql';

const schema = `maia_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const fakeMailer = {
  enabled: false,
  async sendLead() {
    return { status: 'skipped', reason: 'tests-no-mail', results: {} };
  },
};

const contactPayload = {
  nombre: 'Ana Pérez',
  empresa: 'Acme',
  email: 'ana@acme.com',
  telefono: '+525512345678',
  tipo: 'demo',
};

let pool;

beforeAll(async () => {
  pool = createPool({ connectionString: TEST_DB_URL });
  await ensureSchema(pool, { schema });
  await createUser(pool, { email: 'rl-admin@maia.test', password: 'Secret-123!', name: 'RL Admin' }, { schema });
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

/** Reloj falso e inyectable: nunca depende de `Date.now()` real ni de sleeps. */
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/**
 * Invoca el middleware de `createRateLimiter` directamente, sin Express ni
 * HTTP real — necesario para ejercitar `SWEEP_THRESHOLD` (5000 claves) sin
 * pagar el coste de 5000 requests reales vía supertest.
 */
function callLimiter(limiter, key) {
  const req = { ip: key };
  let statusCode, body, nextCalled = false;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
  };
  limiter(req, res, () => { nextCalled = true; });
  return { statusCode, body, nextCalled };
}

describe('createRateLimiter — poda del Map (__internals)', () => {
  it('`pruneExpired` libera entradas ya expiradas sin depender de SWEEP_THRESHOLD', () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ windowMs: 1_000, max: 100, now: clock.now });
    const { hits, pruneExpired } = limiter.__internals;

    for (let i = 0; i < 5; i++) callLimiter(limiter, `ip-${i}`);
    expect(hits.size).toBe(5);

    clock.advance(1_001); // todas las entradas expiran
    // Muy por debajo de SWEEP_THRESHOLD: el barrido automático del
    // middleware no se dispararía solo. `pruneExpired` fuerza la poda real.
    pruneExpired(clock.now());

    expect(hits.size).toBe(0);
  });

  it('entradas no expiradas sobreviven a `pruneExpired`', () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ windowMs: 10_000, max: 100, now: clock.now });
    const { hits, pruneExpired } = limiter.__internals;

    callLimiter(limiter, 'sigue-vivo');
    clock.advance(1); // muy por debajo de windowMs=10000, no expiró

    pruneExpired(clock.now());

    expect(hits.has('sigue-vivo')).toBe(true);
  });

  it('el barrido automático se dispara al cruzar SWEEP_THRESHOLD y libera las claves ya expiradas', () => {
    const clock = makeClock();
    const limiter = createRateLimiter({ windowMs: 1_000, max: 1, now: clock.now });
    const { hits, SWEEP_THRESHOLD } = limiter.__internals;

    // Rellena justo por debajo del umbral con claves que van a expirar.
    for (let i = 0; i < SWEEP_THRESHOLD - 1; i++) callLimiter(limiter, `ip-${i}`);
    expect(hits.size).toBe(SWEEP_THRESHOLD - 1);

    clock.advance(1_001); // todas las anteriores quedan expiradas

    // Esta request es la que hace que `hits.size` alcance SWEEP_THRESHOLD;
    // el propio middleware dispara el barrido automático (maybeSweep) al
    // final de esta misma llamada, sin ninguna llamada directa a `pruneExpired`.
    const result = callLimiter(limiter, 'trigger');

    expect(result.nextCalled).toBe(true); // no se bloqueó (clave nueva, count=1 <= max=1)
    expect(hits.size).toBe(1);
    expect(hits.has('trigger')).toBe(true);
  });
});

describe('Rate limiting — POST /api/contact', () => {
  it('permite hasta `max` requests y responde 429 en la siguiente, sin filtrar intentos restantes', async () => {
    const clock = makeClock();
    const app = createApp({
      pool, schema, mailer: fakeMailer, corsOrigin: '*',
      rateLimit: { contact: { windowMs: 10_000, max: 2, now: clock.now } },
    });

    const r1 = await request(app).post('/api/contact').send(contactPayload);
    const r2 = await request(app).post('/api/contact').send({ ...contactPayload, email: 'b@acme.com' });
    const r3 = await request(app).post('/api/contact').send({ ...contactPayload, email: 'c@acme.com' });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r3.status).toBe(429);
    expect(r3.body).toEqual({ error: expect.any(String) });
    expect(Object.keys(r3.body).sort()).toEqual(['error']);

    // No debe filtrar cuántos intentos quedan, ni en headers RateLimit-*/Retry-After.
    expect(r3.headers['retry-after']).toBeUndefined();
    expect(r3.headers['ratelimit-limit']).toBeUndefined();
    expect(r3.headers['ratelimit-remaining']).toBeUndefined();
    expect(r3.headers['x-ratelimit-remaining']).toBeUndefined();
  });

  it('no bloquea la validación normal: un 422 también cuenta contra el límite (se evalúa antes del handler)', async () => {
    const clock = makeClock();
    const app = createApp({
      pool, schema, mailer: fakeMailer, corsOrigin: '*',
      rateLimit: { contact: { windowMs: 10_000, max: 1, now: clock.now } },
    });

    const r1 = await request(app).post('/api/contact').send({ email: 'no-es-email' }); // 422
    const r2 = await request(app).post('/api/contact').send(contactPayload); // debería ya estar limitado

    expect(r1.status).toBe(422);
    expect(r2.status).toBe(429);
  });

  it('la ventana expira sin esperas reales — un reloj falso avanzado libera el límite', async () => {
    const clock = makeClock();
    const app = createApp({
      pool, schema, mailer: fakeMailer, corsOrigin: '*',
      rateLimit: { contact: { windowMs: 5_000, max: 1, now: clock.now } },
    });

    const r1 = await request(app).post('/api/contact').send({ ...contactPayload, email: 'w1@acme.com' });
    const r2 = await request(app).post('/api/contact').send({ ...contactPayload, email: 'w2@acme.com' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(429);

    clock.advance(5_001); // pasa la ventana, sin sleep real
    const r3 = await request(app).post('/api/contact').send({ ...contactPayload, email: 'w3@acme.com' });
    expect(r3.status).toBe(201);
  });

  it('el límite es por IP: dos IPs distintas (vía X-Forwarded-For + trust proxy) no interfieren entre sí', async () => {
    const clock = makeClock();
    const app = createApp({
      pool, schema, mailer: fakeMailer, corsOrigin: '*',
      rateLimit: { contact: { windowMs: 10_000, max: 1, now: clock.now } },
    });

    const fromIp1a = await request(app).post('/api/contact')
      .set('X-Forwarded-For', '10.0.0.1')
      .send({ ...contactPayload, email: 'ip1a@acme.com' });
    const fromIp1b = await request(app).post('/api/contact')
      .set('X-Forwarded-For', '10.0.0.1')
      .send({ ...contactPayload, email: 'ip1b@acme.com' });
    const fromIp2a = await request(app).post('/api/contact')
      .set('X-Forwarded-For', '10.0.0.2')
      .send({ ...contactPayload, email: 'ip2a@acme.com' });

    expect(fromIp1a.status).toBe(201);
    expect(fromIp1b.status).toBe(429); // misma IP, ya agotó su cupo
    expect(fromIp2a.status).toBe(201); // IP distinta, cupo propio
  });

  it('trust proxy=1 toma el hop más a la derecha del X-Forwarded-For, ignorando lo que el cliente intente inyectar', async () => {
    const clock = makeClock();
    const app = createApp({
      pool, schema, mailer: fakeMailer, corsOrigin: '*',
      rateLimit: { contact: { windowMs: 10_000, max: 1, now: clock.now } },
    });

    // "1.2.3.4" es lo que un cliente malicioso podría intentar inyectar por
    // delante; "9.9.9.9" es la IP que en Render añadiría el único reverse
    // proxy real. Con trust proxy=1, req.ip debe ser 9.9.9.9 en ambas
    // requests, así que la segunda cae en el mismo cupo que la primera.
    const first = await request(app).post('/api/contact')
      .set('X-Forwarded-For', '1.2.3.4, 9.9.9.9')
      .send({ ...contactPayload, email: 'spoof1@acme.com' });
    const second = await request(app).post('/api/contact')
      .set('X-Forwarded-For', '5.5.5.5, 9.9.9.9') // IP falsa distinta a la izquierda, mismo hop real
      .send({ ...contactPayload, email: 'spoof2@acme.com' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
  });

  it('se puede desactivar por completo vía la factory (`rateLimit: { contact: false }`)', async () => {
    const app = createApp({
      pool, schema, mailer: fakeMailer, corsOrigin: '*',
      rateLimit: { contact: false },
    });

    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/api/contact').send({ ...contactPayload, email: `off-${i}@acme.com` });
      expect(res.status).toBe(201);
    }
  });
});

describe('Rate limiting — POST /api/auth/login', () => {
  it('permite hasta `max` intentos y responde 429 en el siguiente, sin filtrar intentos restantes', async () => {
    const clock = makeClock();
    const app = createApp({
      pool, schema, mailer: fakeMailer, corsOrigin: '*', authSecret: 'test-secret-ratelimit',
      rateLimit: { auth: { windowMs: 10_000, max: 2, now: clock.now } },
    });

    const r1 = await request(app).post('/api/auth/login').send({ email: 'x@x.com', password: 'wrong' });
    const r2 = await request(app).post('/api/auth/login').send({ email: 'x@x.com', password: 'wrong' });
    const r3 = await request(app).post('/api/auth/login').send({ email: 'x@x.com', password: 'wrong' });

    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r3.status).toBe(429);
    expect(Object.keys(r3.body).sort()).toEqual(['error']);
    expect(r3.headers['retry-after']).toBeUndefined();
    expect(r3.headers['ratelimit-remaining']).toBeUndefined();
  });

  it('un intento válido también cuenta contra el límite — 429 aunque las credenciales sean correctas', async () => {
    const clock = makeClock();
    const app = createApp({
      pool, schema, mailer: fakeMailer, corsOrigin: '*', authSecret: 'test-secret-ratelimit-2',
      rateLimit: { auth: { windowMs: 10_000, max: 1, now: clock.now } },
    });

    const r1 = await request(app).post('/api/auth/login').send({ email: 'rl-admin@maia.test', password: 'Secret-123!' });
    const r2 = await request(app).post('/api/auth/login').send({ email: 'rl-admin@maia.test', password: 'Secret-123!' });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
  });

  it('la ventana expira sin esperas reales', async () => {
    const clock = makeClock();
    const app = createApp({
      pool, schema, mailer: fakeMailer, corsOrigin: '*', authSecret: 'test-secret-ratelimit-3',
      rateLimit: { auth: { windowMs: 3_000, max: 1, now: clock.now } },
    });

    const r1 = await request(app).post('/api/auth/login').send({ email: 'x@x.com', password: 'wrong' });
    const r2 = await request(app).post('/api/auth/login').send({ email: 'x@x.com', password: 'wrong' });
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(429);

    clock.advance(3_001);
    const r3 = await request(app).post('/api/auth/login').send({ email: 'x@x.com', password: 'wrong' });
    expect(r3.status).toBe(401); // ya no 429: pasó a evaluar credenciales de nuevo
  });

  it('no afecta a /api/auth/logout ni /api/auth/me (solo se limita el login)', async () => {
    const clock = makeClock();
    const app = createApp({
      pool, schema, mailer: fakeMailer, corsOrigin: '*', authSecret: 'test-secret-ratelimit-4',
      rateLimit: { auth: { windowMs: 10_000, max: 1, now: clock.now } },
    });

    // Agota el cupo de login.
    await request(app).post('/api/auth/login').send({ email: 'x@x.com', password: 'wrong' });
    const blocked = await request(app).post('/api/auth/login').send({ email: 'x@x.com', password: 'wrong' });
    expect(blocked.status).toBe(429);

    for (let i = 0; i < 5; i++) {
      const me = await request(app).get('/api/auth/me');
      expect(me.status).toBe(401); // no autenticado, pero nunca 429
      const logout = await request(app).post('/api/auth/logout');
      expect(logout.status).toBe(200);
    }
  });

  it('se puede desactivar por completo vía la factory (`rateLimit: { auth: false }`)', async () => {
    const app = createApp({
      pool, schema, mailer: fakeMailer, corsOrigin: '*', authSecret: 'test-secret-ratelimit-5',
      rateLimit: { auth: false },
    });

    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/api/auth/login').send({ email: 'x@x.com', password: 'wrong' });
      expect(res.status).toBe(401); // nunca 429
    }
  });
});

describe('createRateLimiter — validación de opciones', () => {
  it('createApp no rompe si no se pasa `rateLimit` (usa defaults de producción)', async () => {
    const app = createApp({ pool, schema, mailer: fakeMailer, corsOrigin: '*' });
    const res = await request(app).post('/api/contact').send({ ...contactPayload, email: 'defaults@acme.com' });
    expect(res.status).toBe(201);
  });
});

describe('Rate limiting — ventana configurable por variables de entorno', () => {
  const ENV_KEYS = ['CONTACT_RATE_LIMIT_WINDOW_MS', 'CONTACT_RATE_LIMIT_MAX', 'AUTH_RATE_LIMIT_WINDOW_MS', 'AUTH_RATE_LIMIT_MAX'];
  const originalEnv = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it('CONTACT_RATE_LIMIT_MAX/WINDOW_MS se usan cuando la factory no sobreescribe `rateLimit.contact`', async () => {
    process.env.CONTACT_RATE_LIMIT_WINDOW_MS = '10000';
    process.env.CONTACT_RATE_LIMIT_MAX = '1';
    // `now` sí se inyecta (vía la factory) para no depender del reloj real,
    // aunque windowMs/max vengan de env — no es lo mismo que desactivar el
    // rate limit, solo evita esperas reales.
    const app = createApp({
      pool, schema, mailer: fakeMailer, corsOrigin: '*',
      rateLimit: { contact: { now: makeClock().now } },
    });

    const r1 = await request(app).post('/api/contact').send({ ...contactPayload, email: 'env1@acme.com' });
    const r2 = await request(app).post('/api/contact').send({ ...contactPayload, email: 'env2@acme.com' });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(429); // env MAX=1 se respetó
  });

  it('AUTH_RATE_LIMIT_MAX se usa cuando la factory no sobreescribe `rateLimit.auth`', async () => {
    process.env.AUTH_RATE_LIMIT_WINDOW_MS = '10000';
    process.env.AUTH_RATE_LIMIT_MAX = '1';
    const app = createApp({
      pool, schema, mailer: fakeMailer, corsOrigin: '*', authSecret: 'test-secret-ratelimit-env',
      rateLimit: { auth: { now: makeClock().now } },
    });

    const r1 = await request(app).post('/api/auth/login').send({ email: 'x@x.com', password: 'wrong' });
    const r2 = await request(app).post('/api/auth/login').send({ email: 'x@x.com', password: 'wrong' });

    expect(r1.status).toBe(401);
    expect(r2.status).toBe(429); // env MAX=1 se respetó
  });
});
