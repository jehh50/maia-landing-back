// Feature 9 — CRUD de precios (**solo planes**).
//
// Un `describe` por criterio del `acceptance` (ver `feature_list.json`, feature
// 9). El criterio 15 ("npm test verde, baseline 12 archivos / 221 tests") es la
// corrida completa de la suite, no un `it()` — aun así hay un test estructural
// que comprueba que no se borró ningún archivo de test.
//
// Patrón copiado de `tests/images.test.js` y `tests/users.test.js`: schema
// Postgres efímero propio, `createApp` con el pool inyectado y un mailer falso.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createPool, ensureSchema } from '../src/db.js';
import { createUser } from '../src/users.js';
import { AUTH_COOKIE_NAME } from '../src/auth.js';
import {
  toNumber, calcPrecioAnual, calcAhorroAnual, isStringArray, toPlan,
  CAMPOS_EDITABLES,
} from '../src/precios.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres:///maia-landing?host=/var/run/postgresql';

const schema = `maia_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const fakeMailer = { enabled: false, to: 'sales@test', async sendLead() { return { status: 'skipped' }; } };

/** Techo para los tests que pagan operaciones bcrypt (login real, 12 rounds). */
const TIMEOUT_BCRYPT = 20_000;

const preciosSrc = readFileSync(new URL('../src/precios.js', import.meta.url), 'utf8');
const routerSrc  = readFileSync(new URL('../src/preciosRouter.js', import.meta.url), 'utf8');

/** Igual que en tests/users.test.js: fuera comentarios antes de auditar el SQL. */
function sinComentarios(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

let app, pool, adminCookie, editorCookie;

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.find(c => c.startsWith(`${AUTH_COOKIE_NAME}=`));
}

/** Crea un plan por HTTP como admin. Devuelve la respuesta de supertest. */
function postPlan(body, cookie = adminCookie) {
  const req = request(app).post('/api/admin/precios');
  if (cookie !== null) req.set('Cookie', cookie);
  return req.send(body);
}

/** Crea un plan y devuelve el objeto `plan` de la respuesta (falla si no es 201). */
async function crearPlan(body) {
  const res = await postPlan(body);
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.plan;
}

// Los 4 planes que la web muestra hoy (Pricing.tsx del front, ver
// `contexto_front` de la feature 9). `annual` del front es el precio MENSUAL
// facturando anualmente, no el total del año.
const PLANES_REALES = [
  {
    nombre: 'Starter', precio_mensual: 19, descuento_pct: 10, orden: 1,
    trial_texto: '14 días de prueba gratis',
    vinetas: ['1 usuario', '500 créditos', '1 workflow', 'Soporte por email', 'Cerebro 1 GB'],
    esperado: { precio_anual: 17, ahorro_anual: 24 },
  },
  {
    nombre: 'Team', precio_mensual: 199, descuento_pct: 10, orden: 2, destacado: true,
    vinetas: ['5 usuarios', '10.000 créditos', '10 workflows', 'Soporte prioritario',
      'Cerebro 10 GB', 'Integraciones', 'Roles y permisos', 'Analítica'],
    esperado: { precio_anual: 179, ahorro_anual: 240 },
  },
  {
    nombre: 'Growth', precio_mensual: 599, descuento_pct: 9.85, orden: 3,
    vinetas: ['20 usuarios', '50.000 créditos', 'Workflows ilimitados', 'Soporte dedicado',
      'Cerebro 50 GB', 'Integraciones', 'Roles y permisos', 'Analítica avanzada', 'SLA'],
    esperado: { precio_anual: 540, ahorro_anual: 708 },
  },
  {
    nombre: 'Enterprise', precio_mensual: 0, descuento_pct: 0, orden: 4, es_custom: true,
    vinetas: ['Usuarios ilimitados', 'Créditos a medida', 'On-premise', 'SSO', 'Soporte 24/7'],
    esperado: { precio_anual: null, ahorro_anual: null },
  },
];

beforeAll(async () => {
  pool = createPool({ connectionString: TEST_DB_URL });
  await ensureSchema(pool, { schema });

  await createUser(pool, { email: 'admin@test',  password: 'pass-1', name: 'Admin'  }, { schema });
  await createUser(pool, { email: 'editor@test', password: 'pass-1', name: 'Editor' }, { schema });
  await pool.query(`UPDATE "${schema}".users SET role = 'admin' WHERE email = 'admin@test'`);

  app = createApp({ pool, schema, mailer: fakeMailer, corsOrigin: '*', authSecret: 'test-secret-precios' });

  adminCookie  = await loginAs('admin@test',  'pass-1');
  editorCookie = await loginAs('editor@test', 'pass-1');
}, TIMEOUT_BCRYPT);

afterAll(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// Criterio 1 — tabla `planes` dentro de ensureSchema(), idempotente
// ---------------------------------------------------------------------------
describe('Criterio 1 — esquema `planes` (ensureSchema)', () => {
  it('la tabla planes existe en el schema efímero tras ensureSchema()', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'planes'`,
      [schema],
    );
    expect(rows).toHaveLength(1);
  });

  it('el DDL de src/db.js usa CREATE TABLE IF NOT EXISTS y no tiene ningún DROP', () => {
    const dbSrc = sinComentarios(readFileSync(new URL('../src/db.js', import.meta.url), 'utf8'));
    expect(dbSrc).toMatch(/CREATE TABLE IF NOT EXISTS "\$\{schema\}"\.planes/);
    expect(dbSrc).not.toMatch(/\bDROP\b/i);
    // Cero mutación de datos: ensureSchema corre en cada arranque.
    expect(dbSrc).not.toMatch(/UPDATE\s+"\$\{schema\}"/i);
    // Los complementos y los paquetes son la feature 10: aquí no existen.
    expect(dbSrc).not.toMatch(/complementos/i);
    expect(dbSrc).not.toMatch(/CREATE TABLE IF NOT EXISTS "\$\{schema\}"\.paquetes/i);
  });

  it('es idempotente: correr ensureSchema de nuevo no falla ni borra datos existentes', async () => {
    const plan = await crearPlan({ nombre: 'Idempotente', precio_mensual: 42, orden: 900 });

    await ensureSchema(pool, { schema });   // segundo arranque simulado
    await ensureSchema(pool, { schema });   // tercero, por si acaso

    const res = await request(app).get(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.plan.nombre).toBe('Idempotente');
    expect(res.body.plan.precio_mensual).toBe(42);

    await request(app).delete(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie);
  });

  it('docs/database.md documenta la tabla planes', () => {
    const doc = readFileSync(new URL('../docs/database.md', import.meta.url), 'utf8');
    expect(doc).toMatch(/planes/);
    expect(doc).toMatch(/NUMERIC/);
  });
});

// ---------------------------------------------------------------------------
// Criterio 2 — columnas y tipos (dinero en NUMERIC, jamás float/double)
// ---------------------------------------------------------------------------
describe('Criterio 2 — columnas de `planes`', () => {
  it('tiene exactamente las columnas esperadas', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'planes'`,
      [schema],
    );
    expect(rows.map(r => r.column_name).sort()).toEqual([
      'created_at', 'descuento_pct', 'destacado', 'es_custom', 'id', 'nombre',
      'orden', 'precio_mensual', 'trial_texto', 'updated_at', 'vinetas',
      'vinetas_tachadas',
    ]);
  });

  it('precio_mensual y descuento_pct son NUMERIC con la precisión pedida, nunca float/double', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'planes'
          AND column_name IN ('precio_mensual', 'descuento_pct')`,
      [schema],
    );
    const byName = Object.fromEntries(rows.map(r => [r.column_name, r]));

    expect(byName.precio_mensual.data_type).toBe('numeric');
    expect(byName.precio_mensual.numeric_precision).toBe(10);
    expect(byName.precio_mensual.numeric_scale).toBe(2);

    expect(byName.descuento_pct.data_type).toBe('numeric');
    expect(byName.descuento_pct.numeric_precision).toBe(5);
    expect(byName.descuento_pct.numeric_scale).toBe(2);

    // Ninguna columna de la tabla es de coma flotante.
    expect(rows.map(r => r.data_type)).not.toContain('double precision');
    expect(rows.map(r => r.data_type)).not.toContain('real');
  });

  it('los tipos y NOT NULL/DEFAULT del resto de columnas son los pedidos', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'planes'`,
      [schema],
    );
    const byName = Object.fromEntries(rows.map(r => [r.column_name, r]));

    expect(byName.vinetas.data_type).toBe('jsonb');
    expect(byName.vinetas.is_nullable).toBe('NO');
    expect(byName.vinetas.column_default).toMatch(/\[\]/);

    expect(byName.vinetas_tachadas.data_type).toBe('jsonb');
    expect(byName.vinetas_tachadas.is_nullable).toBe('NO');
    expect(byName.vinetas_tachadas.column_default).toMatch(/\[\]/);

    expect(byName.destacado.data_type).toBe('boolean');
    expect(byName.destacado.is_nullable).toBe('NO');
    expect(byName.destacado.column_default).toMatch(/false/);

    expect(byName.es_custom.data_type).toBe('boolean');
    expect(byName.es_custom.is_nullable).toBe('NO');
    expect(byName.es_custom.column_default).toMatch(/false/);

    expect(byName.trial_texto.data_type).toBe('text');
    expect(byName.trial_texto.is_nullable).toBe('YES');

    expect(byName.orden.data_type).toBe('integer');
    expect(byName.orden.is_nullable).toBe('NO');

    expect(byName.nombre.is_nullable).toBe('NO');
    expect(byName.created_at.data_type).toBe('timestamp with time zone');
    expect(byName.updated_at.data_type).toBe('timestamp with time zone');
  });

  it('los defaults funcionan: un plan solo con nombre queda con precio 0, viñetas vacías y flags en false', async () => {
    const plan = await crearPlan({ nombre: 'Mínimo' });
    expect(plan).toMatchObject({
      nombre: 'Mínimo',
      precio_mensual: 0,
      descuento_pct: 0,
      vinetas: [],
      vinetas_tachadas: [],
      destacado: false,
      es_custom: false,
      trial_texto: null,
      orden: 0,
    });
    await request(app).delete(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie);
  });
});

// ---------------------------------------------------------------------------
// Criterio 3 — TRAMPA: `pg` devuelve NUMERIC como STRING de JavaScript
// ---------------------------------------------------------------------------
describe('Criterio 3 — los NUMERIC salen como número, no como string', () => {
  it('el driver `pg` SÍ devuelve NUMERIC como string: la trampa existe de verdad', async () => {
    const plan = await crearPlan({ nombre: 'Trampa pg', precio_mensual: 19, descuento_pct: 10 });
    const { rows } = await pool.query(
      `SELECT precio_mensual, descuento_pct FROM "${schema}".planes WHERE id = $1`,
      [plan.id],
    );
    // Esto es lo que llega en crudo del driver. Si la API lo reenviara tal
    // cual, el front recibiría "19.00" en vez de 19.
    expect(typeof rows[0].precio_mensual).toBe('string');
    expect(rows[0].precio_mensual).toBe('19.00');
    await request(app).delete(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie);
  });

  it('typeof precio_mensual === "number" en las respuestas del POST, del GET público, del detalle y del PATCH', async () => {
    const creado = await crearPlan({ nombre: 'Numérico', precio_mensual: 19, descuento_pct: 10, orden: 910 });
    expect(typeof creado.precio_mensual).toBe('number');
    expect(typeof creado.descuento_pct).toBe('number');
    expect(typeof creado.precio_anual).toBe('number');
    expect(typeof creado.ahorro_anual).toBe('number');

    const detalle = await request(app).get(`/api/admin/precios/${creado.id}`).set('Cookie', adminCookie);
    expect(typeof detalle.body.plan.precio_mensual).toBe('number');
    expect(typeof detalle.body.plan.descuento_pct).toBe('number');

    const publico = await request(app).get('/api/precios');
    const fila = publico.body.rows.find(r => String(r.id) === String(creado.id));
    expect(typeof fila.precio_mensual).toBe('number');
    expect(typeof fila.descuento_pct).toBe('number');

    const patched = await request(app)
      .patch(`/api/admin/precios/${creado.id}`)
      .set('Cookie', adminCookie)
      .send({ precio_mensual: 25 });
    expect(typeof patched.body.plan.precio_mensual).toBe('number');
    expect(patched.body.plan.precio_mensual).toBe(25);

    await request(app).delete(`/api/admin/precios/${creado.id}`).set('Cookie', adminCookie);
  });

  it('el JSON crudo no lleva los precios entre comillas', async () => {
    const creado = await crearPlan({ nombre: 'Sin comillas', precio_mensual: 19, descuento_pct: 10, orden: 911 });
    const res = await request(app).get(`/api/admin/precios/${creado.id}`).set('Cookie', adminCookie);
    expect(res.text).toMatch(/"precio_mensual":19/);
    expect(res.text).not.toMatch(/"precio_mensual":"/);
    expect(res.text).not.toMatch(/"descuento_pct":"/);
    await request(app).delete(`/api/admin/precios/${creado.id}`).set('Cookie', adminCookie);
  });

  it('toNumber convierte el string del driver y nunca devuelve NaN', () => {
    expect(toNumber('19.00')).toBe(19);
    expect(toNumber('9.85')).toBe(9.85);
    expect(toNumber(19)).toBe(19);
    expect(toNumber(null)).toBe(0);
    expect(toNumber('no-es-un-numero')).toBe(0);
    expect(Number.isNaN(toNumber(undefined))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Criterio 4 — precio_anual y ahorro_anual se CALCULAN, no se almacenan
// ---------------------------------------------------------------------------
describe('Criterio 4 — precio_anual y ahorro_anual son derivados', () => {
  it('no existen como columnas en la tabla', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'planes'
          AND column_name IN ('precio_anual', 'ahorro_anual')`,
      [schema],
    );
    expect(rows).toHaveLength(0);
  });

  it('vienen en las respuestas de la API (POST, GET público, detalle y PATCH)', async () => {
    const creado = await crearPlan({ nombre: 'Derivados', precio_mensual: 19, descuento_pct: 10, orden: 920 });
    expect(creado).toMatchObject({ precio_anual: 17, ahorro_anual: 24 });

    const detalle = await request(app).get(`/api/admin/precios/${creado.id}`).set('Cookie', adminCookie);
    expect(detalle.body.plan).toMatchObject({ precio_anual: 17, ahorro_anual: 24 });

    const publico = await request(app).get('/api/precios');
    const fila = publico.body.rows.find(r => String(r.id) === String(creado.id));
    expect(fila).toMatchObject({ precio_anual: 17, ahorro_anual: 24 });

    const patched = await request(app)
      .patch(`/api/admin/precios/${creado.id}`)
      .set('Cookie', adminCookie)
      .send({ nombre: 'Derivados v2' });
    expect(patched.body.plan).toMatchObject({ precio_anual: 17, ahorro_anual: 24 });

    await request(app).delete(`/api/admin/precios/${creado.id}`).set('Cookie', adminCookie);
  });

  it('se recalculan al cambiar el precio o el descuento: nunca se desincronizan', async () => {
    const creado = await crearPlan({ nombre: 'Recalcula', precio_mensual: 19, descuento_pct: 10, orden: 921 });
    expect(creado).toMatchObject({ precio_anual: 17, ahorro_anual: 24 });

    const subePrecio = await request(app)
      .patch(`/api/admin/precios/${creado.id}`)
      .set('Cookie', adminCookie)
      .send({ precio_mensual: 199 });
    expect(subePrecio.body.plan).toMatchObject({ precio_mensual: 199, precio_anual: 179, ahorro_anual: 240 });

    const cambiaDescuento = await request(app)
      .patch(`/api/admin/precios/${creado.id}`)
      .set('Cookie', adminCookie)
      .send({ precio_mensual: 599, descuento_pct: 9.85 });
    expect(cambiaDescuento.body.plan).toMatchObject({ precio_anual: 540, ahorro_anual: 708 });

    await request(app).delete(`/api/admin/precios/${creado.id}`).set('Cookie', adminCookie);
  });

  it('no se pueden enviar: un PATCH que solo trae precio_anual/ahorro_anual responde 422 y no cambia nada', async () => {
    const creado = await crearPlan({ nombre: 'No editable', precio_mensual: 19, descuento_pct: 10, orden: 922 });

    const res = await request(app)
      .patch(`/api/admin/precios/${creado.id}`)
      .set('Cookie', adminCookie)
      .send({ precio_anual: 1, ahorro_anual: 999 });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Nada que actualizar/);

    const detalle = await request(app).get(`/api/admin/precios/${creado.id}`).set('Cookie', adminCookie);
    expect(detalle.body.plan).toMatchObject({ precio_anual: 17, ahorro_anual: 24 });

    await request(app).delete(`/api/admin/precios/${creado.id}`).set('Cookie', adminCookie);
  });

  it('un POST con precio_anual en el body lo ignora: el derivado manda', async () => {
    const creado = await crearPlan({
      nombre: 'Ignora derivados', precio_mensual: 19, descuento_pct: 10, orden: 923,
      precio_anual: 1, ahorro_anual: 999,
    });
    expect(creado).toMatchObject({ precio_anual: 17, ahorro_anual: 24 });
    await request(app).delete(`/api/admin/precios/${creado.id}`).set('Cookie', adminCookie);
  });
});

// ---------------------------------------------------------------------------
// Criterio 5 — verificación numérica con los datos reales del front
// ---------------------------------------------------------------------------
describe('Criterio 5 — los tres casos numéricos reales de la web', () => {
  it.each([
    { nombre: 'Starter', precio_mensual: 19,  descuento_pct: 10,   precio_anual: 17,  ahorro_anual: 24 },
    { nombre: 'Team',    precio_mensual: 199, descuento_pct: 10,   precio_anual: 179, ahorro_anual: 240 },
    { nombre: 'Growth',  precio_mensual: 599, descuento_pct: 9.85, precio_anual: 540, ahorro_anual: 708 },
  ])('$nombre: $precio_mensual con $descuento_pct% → anual $precio_anual y ahorro $ahorro_anual (helpers puros)',
    ({ precio_mensual, descuento_pct, precio_anual, ahorro_anual }) => {
      const anual = calcPrecioAnual(precio_mensual, descuento_pct);
      expect(anual).toBe(precio_anual);
      expect(calcAhorroAnual(precio_mensual, anual)).toBe(ahorro_anual);
    });

  it('los tres casos, extremo a extremo por HTTP, reproducen la web exactamente', async () => {
    const casos = PLANES_REALES.filter(p => !p.es_custom);
    for (const caso of casos) {
      const { esperado, ...body } = caso;
      const plan = await crearPlan({ ...body, orden: 930 });
      expect({ nombre: plan.nombre, precio_anual: plan.precio_anual, ahorro_anual: plan.ahorro_anual })
        .toEqual({ nombre: caso.nombre, ...esperado });
      await request(app).delete(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie);
    }
  });

  it('el ahorro es la diferencia MENSUAL por 12, no la diferencia con un total anual (defensa del factor 12)', () => {
    // Si `annual` se hubiera tratado como total del año, Starter daría
    // 19*12 - 17 = 211 de "ahorro" y el precio mostrado sería 12 veces menor.
    expect(calcAhorroAnual(19, 17)).toBe(24);
    expect(calcAhorroAnual(19, 17)).not.toBe(19 * 12 - 17);
    expect(calcPrecioAnual(19, 10)).toBeLessThan(19);
    expect(calcPrecioAnual(19, 10) * 12).toBe(204);
  });

  it('un 10% plano NO reproduce Growth: por eso el descuento es POR PLAN', () => {
    expect(calcPrecioAnual(599, 10)).toBe(539);
    expect(calcAhorroAnual(599, calcPrecioAnual(599, 10))).toBe(720);
    // Con el 9,85% real de Growth sí salen los números de la web.
    expect(calcPrecioAnual(599, 9.85)).toBe(540);
    expect(calcAhorroAnual(599, 540)).toBe(708);
  });
});

// ---------------------------------------------------------------------------
// Criterio 6 — caso Custom (Enterprise)
// ---------------------------------------------------------------------------
describe('Criterio 6 — plan Custom (es_custom = true)', () => {
  it('devuelve precio_anual y ahorro_anual en null, nunca "ahorras $0/año"', async () => {
    const custom = PLANES_REALES.find(p => p.es_custom);
    const { esperado, ...body } = custom;
    const plan = await crearPlan({ ...body, orden: 940 });

    expect(plan.es_custom).toBe(true);
    expect(plan.precio_anual).toBeNull();
    expect(plan.ahorro_anual).toBeNull();
    // El ahorro NO es 0: es "no aplica". Un 0 se renderizaría como "$0/año".
    expect(plan.ahorro_anual).not.toBe(0);

    const publico = await request(app).get('/api/precios');
    const fila = publico.body.rows.find(r => String(r.id) === String(plan.id));
    expect(fila.precio_anual).toBeNull();
    expect(fila.ahorro_anual).toBeNull();

    await request(app).delete(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie);
  });

  it('un plan Custom con precio_mensual > 0 tampoco publica derivados', async () => {
    const plan = await crearPlan({ nombre: 'Custom con precio', precio_mensual: 999, descuento_pct: 20, es_custom: true, orden: 941 });
    expect(plan.precio_mensual).toBe(999);
    expect(plan.precio_anual).toBeNull();
    expect(plan.ahorro_anual).toBeNull();
    await request(app).delete(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie);
  });

  it('quitar es_custom por PATCH devuelve los derivados y ponerlo los vuelve a anular', async () => {
    const plan = await crearPlan({ nombre: 'Toggle custom', precio_mensual: 19, descuento_pct: 10, es_custom: true, orden: 942 });
    expect(plan.precio_anual).toBeNull();

    const off = await request(app).patch(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie).send({ es_custom: false });
    expect(off.body.plan).toMatchObject({ es_custom: false, precio_anual: 17, ahorro_anual: 24 });

    const on = await request(app).patch(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie).send({ es_custom: true });
    expect(on.body.plan.precio_anual).toBeNull();
    expect(on.body.plan.ahorro_anual).toBeNull();

    await request(app).delete(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie);
  });

  it('toPlan aplica la regla también fuera de HTTP (helper puro)', () => {
    expect(toPlan({ precio_mensual: '0.00', descuento_pct: '0.00', es_custom: true }))
      .toMatchObject({ precio_anual: null, ahorro_anual: null });
    expect(toPlan({ precio_mensual: '19.00', descuento_pct: '10.00', es_custom: false }))
      .toMatchObject({ precio_anual: 17, ahorro_anual: 24 });
    expect(toPlan(null)).toBeNull();
  });

  it('la decisión del caso Custom está documentada de forma permanente', () => {
    // El criterio 6 pedía documentarla en `progress/current.md`, y ahí se
    // escribió durante la sesión. Pero `current.md` se vacía al cerrar la
    // feature (AGENTS.md §5) y su contenido se mueve a `progress/history.md`,
    // así que el test apunta a los dos sitios DURADEROS: la bitácora y la
    // documentación de arquitectura. Si apuntara a `current.md` se rompería
    // solo por cerrar la sesión.
    const historia = readFileSync(new URL('../progress/history.md', import.meta.url), 'utf8');
    expect(historia).toMatch(/es_custom/);
    expect(historia).toMatch(/precio_anual: null/);

    const arquitectura = readFileSync(new URL('../docs/architecture.md', import.meta.url), 'utf8');
    expect(arquitectura).toMatch(/es_custom = true/);
    expect(arquitectura).toMatch(/null/);
  });
});

// ---------------------------------------------------------------------------
// Criterio 7 — prefijo de rutas y orden del listado público
// ---------------------------------------------------------------------------
describe('Criterio 7 — rutas', () => {
  it('las cinco rutas están montadas y responden como admin', async () => {
    const creado = await postPlan({ nombre: 'Rutas', precio_mensual: 10, orden: 950 });
    expect(creado.status).toBe(201);
    const id = creado.body.plan.id;

    expect((await request(app).get('/api/precios')).status).toBe(200);
    expect((await request(app).get(`/api/admin/precios/${id}`).set('Cookie', adminCookie)).status).toBe(200);
    expect((await request(app).patch(`/api/admin/precios/${id}`).set('Cookie', adminCookie).send({ nombre: 'Rutas v2' })).status).toBe(200);
    expect((await request(app).delete(`/api/admin/precios/${id}`).set('Cookie', adminCookie)).status).toBe(204);
  });

  it('GET /api/precios devuelve { rows } ordenado por `orden` ascendente', async () => {
    const c = await crearPlan({ nombre: 'Orden C', orden: 33 });
    const a = await crearPlan({ nombre: 'Orden A', orden: 11 });
    const b = await crearPlan({ nombre: 'Orden B', orden: 22 });

    const res = await request(app).get('/api/precios');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);

    const mios = res.body.rows.filter(r => /^Orden [ABC]$/.test(r.nombre));
    expect(mios.map(r => r.nombre)).toEqual(['Orden A', 'Orden B', 'Orden C']);

    for (const id of [a.id, b.id, c.id]) {
      await request(app).delete(`/api/admin/precios/${id}`).set('Cookie', adminCookie);
    }
  });

  it('no existe una ruta pública de escritura: POST /api/precios responde 404', async () => {
    const res = await request(app).post('/api/precios').send({ nombre: 'Colado' });
    expect(res.status).toBe(404);
  });

  it('los 4 planes reales de la web se pueden dar de alta y salen en orden por la ruta pública', async () => {
    const creados = [];
    for (const caso of PLANES_REALES) {
      const { esperado, ...body } = caso;
      creados.push(await crearPlan({ ...body, orden: 100 + body.orden }));
    }

    const res = await request(app).get('/api/precios');
    const nombres = PLANES_REALES.map(p => p.nombre);
    const mios = res.body.rows.filter(r => nombres.includes(r.nombre));
    expect(mios.map(r => r.nombre)).toEqual(['Starter', 'Team', 'Growth', 'Enterprise']);
    expect(mios.map(r => r.precio_anual)).toEqual([17, 179, 540, null]);
    expect(mios.map(r => r.ahorro_anual)).toEqual([24, 240, 708, null]);
    expect(mios.find(r => r.nombre === 'Team').destacado).toBe(true);
    expect(mios.find(r => r.nombre === 'Starter').trial_texto).toBe('14 días de prueba gratis');
    expect(mios.find(r => r.nombre === 'Growth').vinetas).toHaveLength(9);

    for (const plan of creados) {
      await request(app).delete(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterio 8 — validación (422 { error, field }) y 404
// ---------------------------------------------------------------------------
describe('Criterio 8 — validación', () => {
  it('422 { error, field: "nombre" } si falta el nombre', async () => {
    for (const body of [{}, { nombre: '' }, { nombre: '   ' }, { precio_mensual: 19 }]) {
      const res = await postPlan(body);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ field: 'nombre' });
      expect(typeof res.body.error).toBe('string');
    }
  });

  it('422 { error, field: "precio_mensual" } si el precio es negativo', async () => {
    const res = await postPlan({ nombre: 'Negativo', precio_mensual: -1 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'precio_mensual' });
  });

  it('422 { error, field: "precio_mensual" } si el precio no es numérico', async () => {
    for (const precio of ['gratis', {}, [], true, null, '']) {
      const res = await postPlan({ nombre: 'No numérico', precio_mensual: precio });
      expect(res.status, `precio ${JSON.stringify(precio)} debería ser 422`).toBe(422);
      expect(res.body).toMatchObject({ field: 'precio_mensual' });
    }
  });

  it('acepta un precio como string numérico ("19.99") y lo devuelve como número', async () => {
    const plan = await crearPlan({ nombre: 'String numérico', precio_mensual: '19.99', orden: 960 });
    expect(plan.precio_mensual).toBe(19.99);
    await request(app).delete(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie);
  });

  it('422 { error, field: "descuento_pct" } si el descuento queda fuera de [0,100]', async () => {
    for (const pct of [-0.01, -1, 100.01, 101, 'mucho']) {
      const res = await postPlan({ nombre: 'Descuento', descuento_pct: pct });
      expect(res.status, `descuento ${pct} debería ser 422`).toBe(422);
      expect(res.body).toMatchObject({ field: 'descuento_pct' });
    }
  });

  it('acepta los extremos del rango de descuento (0 y 100)', async () => {
    const cero  = await crearPlan({ nombre: 'Pct 0',   precio_mensual: 19, descuento_pct: 0,   orden: 961 });
    const cien  = await crearPlan({ nombre: 'Pct 100', precio_mensual: 19, descuento_pct: 100, orden: 962 });
    expect(cero).toMatchObject({ precio_anual: 19, ahorro_anual: 0 });
    expect(cien).toMatchObject({ precio_anual: 0,  ahorro_anual: 228 });
    for (const p of [cero, cien]) {
      await request(app).delete(`/api/admin/precios/${p.id}`).set('Cookie', adminCookie);
    }
  });

  it('422 si vinetas o vinetas_tachadas no son arrays de strings (JSONB acepta cualquier cosa)', async () => {
    const malos = ['texto', 42, {}, null, [1, 2], ['ok', 3], [{ a: 1 }], [['anidado']], [null]];
    for (const campo of ['vinetas', 'vinetas_tachadas']) {
      for (const valor of malos) {
        const res = await postPlan({ nombre: 'Viñetas malas', [campo]: valor });
        expect(res.status, `${campo}=${JSON.stringify(valor)} debería ser 422`).toBe(422);
        expect(res.body).toMatchObject({ field: campo });
      }
    }
  });

  it('acepta arrays de strings (incluido el array vacío) y los persiste como JSONB', async () => {
    const plan = await crearPlan({
      nombre: 'Viñetas buenas', orden: 963,
      vinetas: ['uno', 'dos'], vinetas_tachadas: [],
    });
    expect(plan.vinetas).toEqual(['uno', 'dos']);
    expect(plan.vinetas_tachadas).toEqual([]);

    const { rows } = await pool.query(
      `SELECT jsonb_typeof(vinetas) AS tipo FROM "${schema}".planes WHERE id = $1`,
      [plan.id],
    );
    expect(rows[0].tipo).toBe('array');

    await request(app).delete(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie);
  });

  it('isStringArray distingue arrays de strings del resto (helper puro)', () => {
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(['a', 'b'])).toBe(true);
    expect(isStringArray(['a', 1])).toBe(false);
    expect(isStringArray('a')).toBe(false);
    expect(isStringArray(null)).toBe(false);
    expect(isStringArray({ 0: 'a', length: 1 })).toBe(false);
  });

  it('422 si destacado o es_custom no son booleanos, y 422 si orden no es entero >= 0', async () => {
    for (const campo of ['destacado', 'es_custom']) {
      const res = await postPlan({ nombre: 'Flags', [campo]: 'sí' });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ field: campo });
    }
    for (const orden of [-1, 1.5, 'primero']) {
      const res = await postPlan({ nombre: 'Orden malo', orden });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ field: 'orden' });
    }
  });

  it('PATCH sin ningún campo editable → 422', async () => {
    const plan = await crearPlan({ nombre: 'Patch vacío', orden: 964 });
    for (const body of [{}, { id: 5 }, { created_at: 'ayer' }, { precio_anual: 3 }]) {
      const res = await request(app).patch(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie).send(body);
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/Nada que actualizar/);
    }
    await request(app).delete(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie);
  });

  it('PATCH con un valor inválido → 422 { error, field } y no modifica la fila', async () => {
    const plan = await crearPlan({ nombre: 'Patch inválido', precio_mensual: 19, descuento_pct: 10, orden: 965 });

    const res = await request(app).patch(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie)
      .send({ nombre: 'Nuevo', precio_mensual: -5 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'precio_mensual' });

    const detalle = await request(app).get(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie);
    expect(detalle.body.plan).toMatchObject({ nombre: 'Patch inválido', precio_mensual: 19 });

    await request(app).delete(`/api/admin/precios/${plan.id}`).set('Cookie', adminCookie);
  });

  it('404 si el id no existe, en GET detalle, PATCH y DELETE', async () => {
    const inexistente = 987654321;
    const get = await request(app).get(`/api/admin/precios/${inexistente}`).set('Cookie', adminCookie);
    expect(get.status).toBe(404);
    expect(get.body.error).toMatch(/no encontrado/i);

    const patch = await request(app).patch(`/api/admin/precios/${inexistente}`).set('Cookie', adminCookie).send({ nombre: 'X' });
    expect(patch.status).toBe(404);

    const del = await request(app).delete(`/api/admin/precios/${inexistente}`).set('Cookie', adminCookie);
    expect(del.status).toBe(404);
  });

  it('un precio que desbordaría NUMERIC(10,2) responde 422, nunca 500', async () => {
    const res = await postPlan({ nombre: 'Desborde', precio_mensual: 1e9 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'precio_mensual' });
  });
});

// ---------------------------------------------------------------------------
// Criterio 9 — parseId con guard de rango de bigint (bug de la feature 7)
// ---------------------------------------------------------------------------
describe('Criterio 9 — ids inválidos o desbordados → 404, nunca 500', () => {
  const IDS_MALOS = [
    'abc',                      // 22P02 invalid_text_representation
    '1abc',
    '-1',
    '1.5',
    '',                         // cae en la ruta sin :id
    '9223372036854775808',      // bigint máximo + 1 → 22003
    '99999999999999999999999',  // 23 dígitos
    '12345678901234567890',     // 20 dígitos
  ];

  it('GET /api/admin/precios/:id responde 404 para cualquier id inválido', async () => {
    for (const id of IDS_MALOS) {
      const res = await request(app).get(`/api/admin/precios/${id}`).set('Cookie', adminCookie);
      expect(res.status, `id ${JSON.stringify(id)} → ${res.status}`).toBe(404);
      expect(res.status).not.toBe(500);
    }
  });

  it('PATCH y DELETE responden 404 para cualquier id inválido', async () => {
    for (const id of IDS_MALOS) {
      const patch = await request(app).patch(`/api/admin/precios/${id}`).set('Cookie', adminCookie).send({ nombre: 'X' });
      expect(patch.status, `PATCH id ${JSON.stringify(id)} → ${patch.status}`).toBe(404);

      const del = await request(app).delete(`/api/admin/precios/${id}`).set('Cookie', adminCookie);
      expect(del.status, `DELETE id ${JSON.stringify(id)} → ${del.status}`).toBe(404);
    }
  });

  it('el límite exacto de bigint (9223372036854775807) sí llega a la BD y responde 404 de "no existe"', async () => {
    const res = await request(app).get('/api/admin/precios/9223372036854775807').set('Cookie', adminCookie);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no encontrado/i);
  });

  it('el guard de rango está en el código, con el mismo PG_BIGINT_MAX de las features 7 y 8', () => {
    expect(routerSrc).toMatch(/PG_BIGINT_MAX = 9223372036854775807n/);
    expect(routerSrc).toMatch(/\/\^\\d\{1,19\}\$\//);
  });
});

// ---------------------------------------------------------------------------
// Criterio 10 — permisos: 401 sin cookie, 403 con editor; el GET sigue público
// ---------------------------------------------------------------------------
describe('Criterio 10 — permisos', () => {
  let planId;

  beforeAll(async () => {
    const plan = await crearPlan({ nombre: 'Permisos', precio_mensual: 19, orden: 970 });
    planId = plan.id;
  });

  afterAll(async () => {
    if (planId) await request(app).delete(`/api/admin/precios/${planId}`).set('Cookie', adminCookie);
  });

  it('401 sin cookie en las tres rutas de escritura', async () => {
    expect((await request(app).post('/api/admin/precios').send({ nombre: 'Anónimo' })).status).toBe(401);
    expect((await request(app).patch(`/api/admin/precios/${planId}`).send({ nombre: 'Anónimo' })).status).toBe(401);
    expect((await request(app).delete(`/api/admin/precios/${planId}`)).status).toBe(401);
  });

  it('403 con cookie de rol editor en las tres rutas de escritura', async () => {
    expect((await request(app).post('/api/admin/precios').set('Cookie', editorCookie).send({ nombre: 'Editor' })).status).toBe(403);
    expect((await request(app).patch(`/api/admin/precios/${planId}`).set('Cookie', editorCookie).send({ nombre: 'Editor' })).status).toBe(403);
    expect((await request(app).delete(`/api/admin/precios/${planId}`).set('Cookie', editorCookie)).status).toBe(403);
  });

  it('el GET de detalle del panel también es solo admin (401 / 403)', async () => {
    expect((await request(app).get(`/api/admin/precios/${planId}`)).status).toBe(401);
    expect((await request(app).get(`/api/admin/precios/${planId}`).set('Cookie', editorCookie)).status).toBe(403);
  });

  it('ni el anónimo ni el editor modifican nada: la fila sigue intacta', async () => {
    const detalle = await request(app).get(`/api/admin/precios/${planId}`).set('Cookie', adminCookie);
    expect(detalle.body.plan).toMatchObject({ nombre: 'Permisos', precio_mensual: 19 });
  });

  it('GET /api/precios sigue siendo público: 200 sin cookie', async () => {
    const res = await request(app).get('/api/precios');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    // Y también responde 200 con una cookie de editor (no la estorba).
    expect((await request(app).get('/api/precios').set('Cookie', editorCookie)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Criterio 11 — C7 (separación de capas) y C4 (SQL parametrizado)
// ---------------------------------------------------------------------------
describe('Criterio 11 — separación de capas y SQL seguro', () => {
  it('src/preciosRouter.js no escribe SQL', () => {
    const src = sinComentarios(routerSrc);
    for (const kw of [/\bSELECT\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+"/i, /\bDELETE\s+FROM\b/i, /pool\.query/]) {
      expect(src, `el router no debería contener ${kw}`).not.toMatch(kw);
    }
  });

  it('src/precios.js no importa express ni toca req/res', () => {
    const src = sinComentarios(preciosSrc);
    expect(src).not.toMatch(/from ['"]express['"]/);
    expect(src).not.toMatch(/\breq\./);
    expect(src).not.toMatch(/\bres\.(status|json|send)\b/);
  });

  it('todo valor de usuario va parametrizado: el único interpolado es `schema` entre comillas dobles', () => {
    const src = sinComentarios(preciosSrc);
    const interpolaciones = src.match(/\$\{[^}]+\}/g) || [];
    // `${COLS}` es una constante del módulo (lista fija de columnas), no input.
    expect([...new Set(interpolaciones)].sort()).toEqual(['${COLS}', '${schema}']);
    // Y `schema` siempre va entre comillas dobles.
    for (const m of src.match(/.{2}\$\{schema\}.{2}/g) || []) {
      expect(m).toMatch(/"\$\{schema\}"/);
    }
    // Cero SELECT * (docs/conventions.md §4).
    expect(src).not.toMatch(/SELECT\s+\*/i);
  });

  it('la capa de datos usa una lista de columnas fija y el UPDATE no construye un SET dinámico', () => {
    const src = sinComentarios(preciosSrc);
    expect(src).toMatch(/const COLS = \[/);
    // El SET del UPDATE es literal, columna por columna (igual que updateImage).
    expect(src).toMatch(/SET nombre = \$1,/);
    expect(src).not.toMatch(/\.join\(', '\)\}\s*WHERE/);
  });
});

// ---------------------------------------------------------------------------
// Criterio 12 — cero dependencias nuevas
// ---------------------------------------------------------------------------
describe('Criterio 12 — cero dependencias nuevas', () => {
  it('package.json conserva exactamente las mismas dependencias', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      'bcryptjs', 'cookie-parser', 'cors', 'dotenv', 'express', 'jsonwebtoken',
      'libphonenumber-js', 'multer', 'nodemailer', 'pg', 'resend',
    ]);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(['supertest', 'vitest']);
    expect(pkg.scripts.test).toBe('vitest run');
  });

  it('los dos módulos nuevos solo importan lo que ya existía en el repo', () => {
    const imports = src => [...src.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1]);
    expect(imports(preciosSrc)).toEqual([]);              // la capa de datos no importa nada
    expect(imports(routerSrc).sort()).toEqual(['./asyncHandler.js', './precios.js', './roles.js', 'express']);
  });

  it('el alcance es SOLO PLANES: no hay tabla ni router de complementos/paquetes', () => {
    const archivos = readdirSync(new URL('../src', import.meta.url));
    expect(archivos).not.toContain('complementos.js');
    expect(archivos).not.toContain('paquetes.js');
    // Solo el código: los comentarios sí mencionan la feature 10 para dejar
    // escrito dónde vive lo que aquí NO se implementa.
    expect(sinComentarios(preciosSrc)).not.toMatch(/complementos|paquetes/i);
    expect(sinComentarios(routerSrc)).not.toMatch(/complementos|paquetes/i);
  });
});

// ---------------------------------------------------------------------------
// Criterio 13 — la propia suite (patrón de images/users, un it por criterio)
// ---------------------------------------------------------------------------
describe('Criterio 13 — la suite sigue el patrón del repo', () => {
  it('usa un schema efímero propio y lo limpia (no toca `public`)', () => {
    expect(schema).toMatch(/^maia_test_\d+_\d+$/);
    const src = readFileSync(new URL('./precios.test.js', import.meta.url), 'utf8');
    expect(src).toMatch(/DROP SCHEMA IF EXISTS "\$\{schema\}" CASCADE/);
    expect(src).toMatch(/createApp\(\{ pool, schema/);
  });

  it('hay un describe por cada uno de los 15 criterios del acceptance', () => {
    const src = readFileSync(new URL('./precios.test.js', import.meta.url), 'utf8');
    const criterios = [...src.matchAll(/describe\('Criterio (\d+)/g)].map(m => Number(m[1]));
    expect([...new Set(criterios)].sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
});

// ---------------------------------------------------------------------------
// Criterio 14 — documentación
// ---------------------------------------------------------------------------
describe('Criterio 14 — documentación', () => {
  it('docs/api-contract.md documenta los endpoints y que los derivados no son editables', () => {
    const doc = readFileSync(new URL('../docs/api-contract.md', import.meta.url), 'utf8');
    expect(doc).toMatch(/GET \/api\/precios/);
    expect(doc).toMatch(/POST \/api\/admin\/precios/);
    expect(doc).toMatch(/PATCH \/api\/admin\/precios\/:id/);
    expect(doc).toMatch(/DELETE \/api\/admin\/precios\/:id/);
    expect(doc).toMatch(/precio_anual/);
    expect(doc).toMatch(/ahorro_anual/);
    expect(doc).toMatch(/DERIVADOS|derivados/);
    expect(doc).toMatch(/no editables|no se pueden editar/i);
  });

  it('docs/architecture.md documenta la tabla `planes` y el cálculo derivado', () => {
    const doc = readFileSync(new URL('../docs/architecture.md', import.meta.url), 'utf8');
    expect(doc).toMatch(/planes/);
    expect(doc).toMatch(/preciosRouter\.js/);
    expect(doc).toMatch(/precios\.js/);
    expect(doc).toMatch(/\/api\/admin\/precios/);
  });

  it('docs/database.md explica la trampa del NUMERIC como string y el invariante de los derivados', () => {
    const doc = readFileSync(new URL('../docs/database.md', import.meta.url), 'utf8');
    expect(doc).toMatch(/NUMERIC/);
    expect(doc).toMatch(/string/i);
    expect(doc).toMatch(/precio_anual/);
  });
});

// ---------------------------------------------------------------------------
// Criterio 15 — ningún test existente borrado ni skipeado
// ---------------------------------------------------------------------------
describe('Criterio 15 — la suite del repo sigue completa', () => {
  it('los 12 archivos de test del baseline siguen existiendo, más este', () => {
    const archivos = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.js'));
    for (const previo of [
      'app.test.js', 'articles.test.js', 'auth.test.js', 'contact.test.js',
      'email.test.js', 'images.test.js', 'leads.test.js', 'phone.test.js',
      'ratelimit.test.js', 'roles.test.js', 'roles.schema.test.js', 'users.test.js',
    ]) {
      expect(archivos, `falta ${previo}`).toContain(previo);
    }
    expect(archivos).toContain('precios.test.js');
    expect(archivos.length).toBeGreaterThanOrEqual(13);
  });

  it('ningún test del repo está marcado skip/todo/only', () => {
    const dir = new URL('.', import.meta.url);
    for (const f of readdirSync(dir).filter(x => x.endsWith('.test.js'))) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      expect(src, `${f} tiene tests desactivados`).not.toMatch(/\b(it|test|describe)\.(skip|todo|only)\b/);
      expect(src, `${f} tiene xit/xdescribe`).not.toMatch(/\bx(it|describe)\(/);
    }
  });

  it('CAMPOS_EDITABLES no incluye ningún campo derivado ni de auditoría', () => {
    expect(CAMPOS_EDITABLES).toEqual([
      'nombre', 'precio_mensual', 'descuento_pct', 'vinetas', 'vinetas_tachadas',
      'destacado', 'trial_texto', 'es_custom', 'orden',
    ]);
    for (const prohibido of ['id', 'precio_anual', 'ahorro_anual', 'created_at', 'updated_at']) {
      expect(CAMPOS_EDITABLES).not.toContain(prohibido);
    }
  });
});
