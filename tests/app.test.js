import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createApp, asyncHandler, errorHandler } from '../src/app.js';
import { createPool, ensureSchema } from '../src/db.js';
import { createUser } from '../src/users.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres:///maia-landing?host=/var/run/postgresql';

const schema = `maia_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let app, pool;
const fakeMailer = {
  enabled: false,
  async sendLead() {
    return { status: 'skipped', reason: 'fake mailer', results: {} };
  },
};

// Usuario real (fila en la tabla `users`) usado para provocar un throw
// genuino en `POST /api/auth/login` — ver describe() dedicado más abajo.
const boomLoginUser = {
  email: 'boom-login@maia.test',
  password: 'Boom-Login-123!',
  name: 'Boom Login',
};

beforeAll(async () => {
  pool = createPool({ connectionString: TEST_DB_URL });
  await ensureSchema(pool, { schema });
  await createUser(pool, boomLoginUser, { schema });
  app = createApp({ pool, schema, mailer: fakeMailer, corsOrigin: '*' });
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

// Helper: monta un mini-app con las mismas piezas de producción
// (`asyncHandler`/`errorHandler`, exportadas desde src/app.js) alrededor de
// una ruta que lanza deliberadamente, para probar el middleware de errores en
// aislamiento sin exponer un endpoint de depuración en la API real.
function buildBoomApp(routeSetup) {
  const boomApp = express();
  routeSetup(boomApp);
  boomApp.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  boomApp.use(errorHandler);
  return boomApp;
}

describe('Middleware de errores JSON', () => {
  it('un throw síncrono en una ruta responde JSON 500 genérico', async () => {
    const boomApp = buildBoomApp((a) => {
      a.get('/boom', () => { throw new Error('boom sincrono'); });
    });

    const res = await request(boomApp).get('/boom');

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'Error interno del servidor' });
  });

  it('un throw dentro de un handler async envuelto con asyncHandler llega al middleware de errores', async () => {
    const boomApp = buildBoomApp((a) => {
      a.get('/boom-async', asyncHandler(async () => {
        throw new Error('boom asincrono');
      }));
    });

    const res = await request(boomApp).get('/boom-async');

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'Error interno del servidor' });
  });

  it('un rechazo de promesa envuelto con asyncHandler no filtra el mensaje ni el stack real', async () => {
    const boomApp = buildBoomApp((a) => {
      a.get('/boom-detalle', asyncHandler(async () => {
        throw new Error('detalle-secreto-de-implementacion');
      }));
    });

    const res = await request(boomApp).get('/boom-detalle');

    expect(res.status).toBe(500);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/detalle-secreto-de-implementacion/);
    expect(raw).not.toMatch(/at .*\.js:\d+/); // sin trazas de stack
  });

  it('delega en next(err) si las cabeceras ya se enviaron, sin intentar responder otra vez', () => {
    const err = new Error('cabeceras ya enviadas');
    const res = {
      headersSent: true,
      status: () => { throw new Error('no debería llamarse a res.status()'); },
      json: () => { throw new Error('no debería llamarse a res.json()'); },
    };
    let forwardedTo;
    const next = (e) => { forwardedTo = e; };

    errorHandler(err, {}, res, next);

    expect(forwardedTo).toBe(err);
  });

  it('el 404 existente sigue respondiendo { error: "Not found" } tras añadir el middleware de errores', async () => {
    const res = await request(app).get('/ruta-que-no-existe');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('un JSON malformado en el body responde JSON 500 genérico en vez del HTML por defecto de Express', async () => {
    const res = await request(app)
      .post('/api/contact')
      .set('Content-Type', 'application/json')
      .send('{ esto no es json valido');

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'Error interno del servidor' });
  });
});

describe('Middleware de errores JSON — throw real en una ruta de auth.js montada con createApp()', () => {
  // `POST /api/auth/login` (src/auth.js) llama a `signToken(user)` (que envuelve
  // `jwt.sign`) DESPUÉS de su único `try/catch` (que solo cubre la búsqueda del
  // usuario). Si `jwt.sign` recibe un secreto inválido lanza síncronamente desde
  // dentro del handler `async` — exactamente el hueco que `asyncHandler` existe
  // para cerrar. Se inyecta el secreto roto vía la factory (`createApp({
  // authSecret })`, la misma opción documentada que usa el resto de la suite de
  // auth), sin mockear `pool.query` ni tocar código de producción para el test.
  let brokenSecretApp;

  beforeAll(() => {
    brokenSecretApp = createApp({
      pool, schema, mailer: fakeMailer, corsOrigin: '*',
      authSecret: {}, // valor no válido para jwt.sign: dispara un throw síncrono en signToken()
    });
  });

  it('credenciales válidas + secreto JWT roto: responde JSON 500 genérico en vez de colgarse', async () => {
    const res = await request(brokenSecretApp)
      .post('/api/auth/login')
      .send({ email: boomLoginUser.email, password: boomLoginUser.password })
      .timeout(4000);

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'Error interno del servidor' });
    // Sin cookie de sesión: el fallo ocurrió antes de poder emitirla.
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
