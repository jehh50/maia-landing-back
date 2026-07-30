// Feature 8 — CRUD de usuarios.
//
// Un `describe` por criterio del `acceptance` (ver `feature_list.json`, feature
// 8). El criterio 14 ("npm test verde, sin borrar ni skipear tests") es la
// corrida completa de la suite, no un `it()`.
//
// Los tests que dependen de **cuántos admins hay en total** (la guarda del
// último admin) corren en su propio schema efímero: el recuento es global a la
// tabla, así que compartir schema con el resto los volvería frágiles.
//
// Dos detalles de robustez, ambos por el coste de bcrypt (12 rounds a
// propósito, ~300 ms por hash o comparación):
//
//  - Los tests que crean usuarios o hacen login llevan un `timeout` explícito
//    (`TIMEOUT_BCRYPT`): con 12 archivos de test corriendo en paralelo, cinco
//    operaciones bcrypt seguidas pueden pasarse de los 5 s por defecto de
//    vitest. No es una espera artificial, es el techo del test.
//  - El rate limit de `POST /api/auth/login` se desactiva **solo en esta
//    suite** vía `createApp({ rateLimit: { auth: false } })`, que es para lo
//    que existe esa opción de la factory: la suite hace del orden de 10 logins
//    reales y el default de producción es 10 por IP cada 15 min, así que el
//    último login iba justo al borde del 429. El rate limiting tiene su propia
//    suite (`tests/ratelimit.test.js`) y su default no se toca.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createPool, ensureSchema } from '../src/db.js';
import * as usersModule from '../src/users.js';
import { createUser, findUserByEmail, countAdmins, deleteUser, __test__ as usersInternals } from '../src/users.js';
import { AUTH_COOKIE_NAME } from '../src/auth.js';
import { ROLES } from '../src/roles.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres:///maia-landing?host=/var/run/postgresql';

const schema = `maia_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const fakeMailer = { enabled: false, to: 'sales@test', async sendLead() { return { status: 'skipped' }; } };

/** Techo para los tests que pagan varias operaciones bcrypt (ver cabecera). */
const TIMEOUT_BCRYPT = 20_000;

const usersSrc  = readFileSync(new URL('../src/users.js', import.meta.url), 'utf8');
const routerSrc = readFileSync(new URL('../src/usersRouter.js', import.meta.url), 'utf8');

/** Igual que en tests/images.test.js: fuera comentarios antes de auditar el SQL. */
function sinComentarios(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

let app, pool, adminCookie, editorCookie, adminId, editorId;

async function loginOn(target, email, password) {
  const res = await request(target).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.find(c => c.startsWith(`${AUTH_COOKIE_NAME}=`));
}

const loginAs = (email, password) => loginOn(app, email, password);

/** Crea un usuario por HTTP (como admin) y devuelve la respuesta de supertest. */
function postUser(body, cookie = adminCookie) {
  const req = request(app).post('/api/admin/users');
  if (cookie !== null) req.set('Cookie', cookie);
  return req.send(body);
}

// Schemas efímeros extra para los tests de población de admins. Se numeran para
// que cada uno sea independiente del orden de ejecución.
let freshSeq = 0;

/**
 * Corre `fn({ schema, app })` sobre un schema recién creado (con su propia app)
 * y lo destruye al terminar, pase lo que pase.
 */
async function withFreshSchema(fn) {
  const s = `${schema}_g${++freshSeq}`;
  await ensureSchema(pool, { schema: s });
  const freshApp = createApp({
    pool, schema: s, mailer: fakeMailer, corsOrigin: '*',
    // Secreto distinto al de la app principal: así una cookie de este schema
    // nunca podría confundirse con una del otro (ids que coinciden por azar).
    authSecret: `test-secret-users-${s}`,
    rateLimit: { auth: false },
  });
  try {
    await fn({ schema: s, app: freshApp });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  }
}

beforeAll(async () => {
  pool = createPool({ connectionString: TEST_DB_URL });
  await ensureSchema(pool, { schema });

  await createUser(pool, { email: 'admin@test',  password: 'pass-1', name: 'Admin',  role: ROLES.ADMIN  }, { schema });
  await createUser(pool, { email: 'editor@test', password: 'pass-1', name: 'Editor', role: ROLES.EDITOR }, { schema });

  app = createApp({
    pool, schema, mailer: fakeMailer, corsOrigin: '*',
    authSecret: 'test-secret-users',
    // Ver cabecera: esta suite hace ~10 logins reales; el rate limit de login
    // se prueba en tests/ratelimit.test.js, aquí solo añadiría un 429 espurio.
    rateLimit: { auth: false },
  });

  adminCookie  = await loginAs('admin@test',  'pass-1');
  editorCookie = await loginAs('editor@test', 'pass-1');

  adminId  = (await findUserByEmail(pool, 'admin@test',  { schema })).id;
  editorId = (await findUserByEmail(pool, 'editor@test', { schema })).id;
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// Criterio 1 — prefijo de rutas: los 5 endpoints bajo /api/admin/users
// ---------------------------------------------------------------------------
describe('Criterio 1 — prefijo de rutas /api/admin/users', { timeout: TIMEOUT_BCRYPT }, () => {
  it('los 5 endpoints están montados y responden como admin', async () => {
    const created = await postUser({ email: 'c1@test', password: 'pass-1', name: 'C1' });
    expect(created.status).toBe(201);
    const id = created.body.user.id;

    expect((await request(app).get('/api/admin/users').set('Cookie', adminCookie)).status).toBe(200);
    expect((await request(app).get(`/api/admin/users/${id}`).set('Cookie', adminCookie)).status).toBe(200);
    expect((await request(app).patch(`/api/admin/users/${id}`).set('Cookie', adminCookie).send({ name: 'C1 v2' })).status).toBe(200);
    expect((await request(app).delete(`/api/admin/users/${id}`).set('Cookie', adminCookie)).status).toBe(204);
  });

  it('no hay ninguna ruta pública de usuarios: /api/users responde 404', async () => {
    expect((await request(app).get('/api/users')).status).toBe(404);
    expect((await request(app).get('/api/users/1')).status).toBe(404);
    expect((await request(app).post('/api/users').send({ email: 'x@test', password: 'y' })).status).toBe(404);
    // Ni siquiera con cookie de admin: la ruta no existe.
    expect((await request(app).get('/api/users').set('Cookie', adminCookie)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Criterio 2 — C7: el router no escribe SQL, la capa de datos es src/users.js
// ---------------------------------------------------------------------------
describe('Criterio 2 — separación de capas (C7) y capa de datos', { timeout: TIMEOUT_BCRYPT }, () => {
  it('src/usersRouter.js no escribe SQL', () => {
    const src = sinComentarios(routerSrc);
    expect(src).not.toMatch(/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/);
    expect(src).not.toMatch(/pool\.query/);
    expect(src).not.toMatch(/pool\.connect/);
  });

  it('src/users.js no importa express ni toca req/res', () => {
    expect(usersSrc).not.toMatch(/from ['"]express['"]/);
    expect(usersSrc).not.toMatch(/\breq\./);
    expect(usersSrc).not.toMatch(/\bres\.(status|json|send|set)\b/);
  });

  it('src/users.js parametriza todo valor de usuario e interpola solo `schema` y las columnas (C4)', () => {
    const src = sinComentarios(usersSrc);
    const queries = src.match(/`[^`]*(SELECT|INSERT|UPDATE|DELETE)[^`]*`/g) || [];
    expect(queries.length).toBeGreaterThan(0);
    const PERMITIDAS = /^\$\{(schema|PUBLIC_COLS)\}$/;
    for (const q of queries) {
      for (const i of q.match(/\$\{[^}]+\}/g) || []) {
        expect(i, `interpolación no permitida en: ${q}`).toMatch(PERMITIDAS);
      }
      expect(q, `falta el schema entrecomillado en: ${q}`).toMatch(/"\$\{schema\}"/);
    }
  });

  it('conserva createUser/findUserByEmail/verifyPassword y añade listUsers/getUserById/updateUser/deleteUser/countAdmins', () => {
    for (const fn of ['createUser', 'findUserByEmail', 'verifyPassword',
      'listUsers', 'getUserById', 'updateUser', 'deleteUser', 'countAdmins']) {
      expect(typeof usersModule[fn], `falta ${fn}`).toBe('function');
    }
  });

  it('las funciones nuevas funcionan también llamadas directamente (capa de datos usable sin HTTP)', async () => {
    const u = await createUser(pool, { email: 'capa@test', password: 'pass-1', name: 'Capa' }, { schema });
    expect(await usersModule.getUserById(pool, u.id, { schema })).toMatchObject({ email: 'capa@test', role: 'editor' });
    const lista = await usersModule.listUsers(pool, { schema });
    expect(lista.some(r => r.email === 'capa@test')).toBe(true);
    expect(await countAdmins(pool, { schema })).toBeGreaterThanOrEqual(1);
    expect(await usersModule.deleteUser(pool, u.id, { schema })).toBe(true);
    expect(await usersModule.deleteUser(pool, u.id, { schema })).toBe(false); // ya no existe
  });
});

// ---------------------------------------------------------------------------
// Criterio 3 — INVARIANTE I3: password_hash NUNCA sale por la API
// ---------------------------------------------------------------------------
describe('Criterio 3 — invariante I3: password_hash nunca sale por la API', { timeout: TIMEOUT_BCRYPT }, () => {
  it('no aparece en el listado, ni en el detalle, ni en el POST, ni en el PATCH (tampoco en el texto crudo)', async () => {
    const secreto = 'password-en-claro-1';
    const creada = await postUser({ email: 'i3@test', password: secreto, name: 'I3', role: 'editor' });
    expect(creada.status).toBe(201);
    const id = creada.body.user.id;

    // POST
    expect(Object.keys(creada.body.user)).not.toContain('password_hash');
    expect(creada.text).not.toMatch(/password_hash/);
    expect(creada.text).not.toContain(secreto);          // ni el password en claro

    // Listado
    const lista = await request(app).get('/api/admin/users').set('Cookie', adminCookie);
    expect(lista.body.rows.length).toBeGreaterThan(0);
    for (const row of lista.body.rows) {
      expect(Object.keys(row)).not.toContain('password_hash');
      expect(row.password_hash).toBeUndefined();
    }
    expect(lista.text).not.toMatch(/password_hash/);
    expect(lista.text).not.toMatch(/\$2[aby]\$/);        // ni un hash bcrypt suelto

    // Detalle
    const detalle = await request(app).get(`/api/admin/users/${id}`).set('Cookie', adminCookie);
    expect(Object.keys(detalle.body.user)).not.toContain('password_hash');
    expect(detalle.text).not.toMatch(/password_hash/);

    // PATCH (incluso uno que cambia la contraseña)
    const patched = await request(app).patch(`/api/admin/users/${id}`).set('Cookie', adminCookie)
      .send({ name: 'I3 v2', password: 'password-en-claro-2' });
    expect(patched.status).toBe(200);
    expect(Object.keys(patched.body.user)).not.toContain('password_hash');
    expect(patched.text).not.toMatch(/password_hash/);
    expect(patched.text).not.toContain('password-en-claro-2');

    // Y el objeto `user` del login / de /me tampoco (contrato ya existente)
    const me = await request(app).get('/api/auth/me').set('Cookie', adminCookie);
    expect(me.text).not.toMatch(/password_hash/);

    await request(app).delete(`/api/admin/users/${id}`).set('Cookie', adminCookie);
  });

  it('PUBLIC_COLS no incluye password_hash y ninguna query del CRUD hace SELECT *', () => {
    const publicCols = usersSrc.match(/const PUBLIC_COLS = '([^']+)'/)[1];
    const cols = publicCols.split(',').map(s => s.trim());
    expect(cols).not.toContain('password_hash');
    expect(cols).toEqual(['id', 'email', 'name', 'role', 'created_at']);
    expect(usersInternals.PUBLIC_COLS).toBe(publicCols);

    // Sin comentarios: los propios comentarios del módulo mencionan "cero
    // `SELECT *`" como documentación de la invariante.
    expect(sinComentarios(usersSrc)).not.toMatch(/SELECT\s+\*/i);
    expect(sinComentarios(routerSrc)).not.toMatch(/SELECT\s+\*/i);

    // La única query que menciona `password_hash` como columna leída es la de
    // `findUserByEmail` (el login la necesita); el resto solo la escribe.
    const src = sinComentarios(usersSrc);
    const selects = src.match(/`\s*SELECT[^`]*`/g) || [];
    const conHash = selects.filter(q => /password_hash/.test(q));
    expect(conHash).toHaveLength(1);
    expect(conHash[0]).toMatch(/WHERE email = \$1/);
  });

  it('findUserByEmail sigue devolviendo password_hash a propósito (el login lo necesita)', async () => {
    const user = await findUserByEmail(pool, 'admin@test', { schema });
    expect(user.password_hash).toMatch(/^\$2[aby]\$/);
    // …pero el CRUD no la usa: getUserById no lo trae.
    const publico = await usersModule.getUserById(pool, user.id, { schema });
    expect(publico.password_hash).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Criterio 4 — GET listado y detalle
// ---------------------------------------------------------------------------
describe('Criterio 4 — GET /api/admin/users y GET /api/admin/users/:id', { timeout: TIMEOUT_BCRYPT }, () => {
  it('el listado devuelve id, email, name, role y created_at', async () => {
    const res = await request(app).get('/api/admin/users').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.rows).toBeInstanceOf(Array);
    const admin = res.body.rows.find(r => r.email === 'admin@test');
    expect(Object.keys(admin).sort()).toEqual(['created_at', 'email', 'id', 'name', 'role']);
    expect(admin.role).toBe('admin');
    expect(res.body.rows.find(r => r.email === 'editor@test').role).toBe('editor');
  });

  it('el detalle devuelve un usuario', async () => {
    const res = await request(app).get(`/api/admin/users/${editorId}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'editor@test', name: 'Editor', role: 'editor' });
  });

  it('404 si el id no existe', async () => {
    const res = await request(app).get('/api/admin/users/99999999').set('Cookie', adminCookie);
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });

  it('404 (no 500) si el id no es numérico o desborda el rango de bigint', async () => {
    const ids = ['abc', '1abc', '9223372036854775808', '12345678901234567890'];
    for (const id of ids) {
      const get = await request(app).get(`/api/admin/users/${id}`).set('Cookie', adminCookie);
      expect(get.status, `GET con id=${id}`).toBe(404);
      const patch = await request(app).patch(`/api/admin/users/${id}`).set('Cookie', adminCookie).send({ name: 'x' });
      expect(patch.status, `PATCH con id=${id}`).toBe(404);
      const del = await request(app).delete(`/api/admin/users/${id}`).set('Cookie', adminCookie);
      expect(del.status, `DELETE con id=${id}`).toBe(404);
    }
    // El límite exacto de bigint sí es un id válido: 404 porque no existe.
    expect((await request(app).get('/api/admin/users/9223372036854775807').set('Cookie', adminCookie)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Criterio 5 — POST /api/admin/users
// ---------------------------------------------------------------------------
describe('Criterio 5 — POST /api/admin/users', { timeout: TIMEOUT_BCRYPT }, () => {
  it('201 con email, password, name y role', async () => {
    const res = await postUser({ email: 'nuevo-admin@test', password: 'pass-1', name: 'Nuevo Admin', role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'nuevo-admin@test', name: 'Nuevo Admin', role: 'admin' });
    expect(res.body.user.id).toBeTruthy();
    expect(res.body.user.created_at).toBeTruthy();
  });

  it('sin role explícito cae al default `editor`', async () => {
    const res = await postUser({ email: 'sin-role@test', password: 'pass-1', name: 'Sin Role' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('editor');
  });

  it('la contraseña se persiste hasheada con bcrypt (SALT_ROUNDS=12) y sirve para loguearse', async () => {
    const res = await postUser({ email: 'login-nuevo@test', password: 'Secret-123!', name: 'Login' });
    expect(res.status).toBe(201);

    const { rows } = await pool.query(`SELECT password_hash FROM "${schema}".users WHERE id = $1`, [res.body.user.id]);
    expect(rows[0].password_hash).not.toBe('Secret-123!');
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/);   // prefijo bcrypt + 12 rounds
    expect(usersInternals.SALT_ROUNDS).toBe(12);

    const cookie = await loginAs('login-nuevo@test', 'Secret-123!');
    expect(cookie).toBeTruthy();
  });

  it('normaliza el email a lowercase + trim', async () => {
    const res = await postUser({ email: '  MAYUS@Test  ', password: 'pass-1' });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('mayus@test');
  });

  it('409 { error } si el email ya existe', async () => {
    const res = await postUser({ email: 'admin@test', password: 'otra-1', name: 'Duplicado' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();
    expect(res.body.field).toBe('email');
  });

  it('422 { error, field } si falta email', async () => {
    const res = await postUser({ password: 'pass-1' });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('email');
    const vacio = await postUser({ email: '   ', password: 'pass-1' });
    expect(vacio.status).toBe(422);
    expect(vacio.body.field).toBe('email');
  });

  it('422 { error, field } si falta password', async () => {
    const res = await postUser({ email: 'sin-pass@test' });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('password');
  });

  it('422 { error, field } si el role no es uno de ROLES', async () => {
    for (const role of ['superadmin', 'ADMIN', '', 'editor ']) {
      const res = await postUser({ email: `role-${encodeURIComponent(role)}@test`, password: 'pass-1', role });
      expect(res.status, `role=${JSON.stringify(role)}`).toBe(422);
      expect(res.body.field).toBe('role');
    }
    // Y no se creó ninguno de ellos.
    const lista = await request(app).get('/api/admin/users').set('Cookie', adminCookie);
    expect(lista.body.rows.some(r => r.email.startsWith('role-'))).toBe(false);
  });

  // Hallazgo menor 2 del review de la feature 8: los `catch` del POST y del
  // PATCH loguean el error REAL (C8: "se loggea el error real"), no solo su
  // `code`. Este test fija las dos mitades de esa decisión: que la traza existe
  // y que la contraseña en claro no está en ella. Lo segundo no es suerte: el
  // password nunca viaja a Postgres — a la query va su hash bcrypt — así que
  // ningún error del driver puede contenerlo.
  it('ante un error inesperado de Postgres loguea la traza real y la contraseña en claro no aparece en ella', async () => {
    const PLANO = 'contrasena-en-claro-que-no-debe-loguearse';
    await withFreshSchema(async ({ schema: s, app: a }) => {
      await createUser(pool, { email: 'adm@test', password: 'pass-1', role: ROLES.ADMIN }, { schema: s });
      const cookie = await loginOn(a, 'adm@test', 'pass-1');
      // Provoca un fallo real del driver (23514 check_violation) en el INSERT,
      // sin tocar el esquema de producción: el CHECK vive solo en este schema
      // efímero, que se destruye al salir de `withFreshSchema`.
      await pool.query(`ALTER TABLE "${s}".users ADD CONSTRAINT users_boom_chk CHECK (email <> 'boom@test')`);

      const trazas = [];
      const originalError = console.error;
      console.error = (...args) => {
        trazas.push(args.map(x => (x instanceof Error ? [x.message, x.detail, x.code, x.stack].join(' ') : String(x))).join(' '));
      };
      let res;
      try {
        res = await request(a).post('/api/admin/users').set('Cookie', cookie)
          .send({ email: 'boom@test', password: PLANO, name: 'Boom' });
      } finally {
        console.error = originalError;
      }

      // Al cliente, mensaje genérico (nunca el SQL ni el detalle interno).
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Error al crear usuario');
      expect(res.text).not.toContain(PLANO);

      const traza = trazas.join('\n');
      expect(traza).toMatch(/\[users\] create error/);
      // La traza es útil de verdad: lleva el error real, no un 'error desconocido'.
      expect(traza).toMatch(/23514/);
      expect(traza).not.toMatch(/error desconocido/);
      // Y no lleva la contraseña en claro.
      expect(traza).not.toContain(PLANO);
    });
  });
});

// ---------------------------------------------------------------------------
// Criterio 6 — PATCH /api/admin/users/:id
// ---------------------------------------------------------------------------
describe('Criterio 6 — PATCH /api/admin/users/:id', { timeout: TIMEOUT_BCRYPT }, () => {
  it('cambia email, name y role', async () => {
    const creada = await postUser({ email: 'patch-1@test', password: 'pass-1', name: 'Antes' });
    const id = creada.body.user.id;

    const res = await request(app).patch(`/api/admin/users/${id}`).set('Cookie', adminCookie)
      .send({ email: 'patch-1b@test', name: 'Después', role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id, email: 'patch-1b@test', name: 'Después', role: 'admin' });

    // Los campos ausentes conservan su valor (read-then-merge).
    const solo = await request(app).patch(`/api/admin/users/${id}`).set('Cookie', adminCookie).send({ name: 'Solo name' });
    expect(solo.status).toBe(200);
    expect(solo.body.user).toMatchObject({ email: 'patch-1b@test', name: 'Solo name', role: 'admin' });

    await request(app).delete(`/api/admin/users/${id}`).set('Cookie', adminCookie);
  });

  it('cambia la contraseña de otro usuario: la vieja deja de servir y la nueva funciona (re-hash bcrypt 12)', async () => {
    const creada = await postUser({ email: 'patch-pass@test', password: 'vieja-123', name: 'Pass' });
    const id = creada.body.user.id;
    expect(await loginAs('patch-pass@test', 'vieja-123')).toBeTruthy();

    const { rows: antes } = await pool.query(`SELECT password_hash FROM "${schema}".users WHERE id = $1`, [id]);

    const res = await request(app).patch(`/api/admin/users/${id}`).set('Cookie', adminCookie)
      .send({ password: 'nueva-456' });
    expect(res.status).toBe(200);

    const { rows: despues } = await pool.query(`SELECT password_hash FROM "${schema}".users WHERE id = $1`, [id]);
    expect(despues[0].password_hash).not.toBe(antes[0].password_hash);
    expect(despues[0].password_hash).not.toBe('nueva-456');       // nunca en texto plano
    expect(despues[0].password_hash).toMatch(/^\$2[aby]\$12\$/);  // mismo SALT_ROUNDS

    // La nueva sirve, la vieja no.
    expect(await loginAs('patch-pass@test', 'nueva-456')).toBeTruthy();
    const vieja = await request(app).post('/api/auth/login').send({ email: 'patch-pass@test', password: 'vieja-123' });
    expect(vieja.status).toBe(401);

    await request(app).delete(`/api/admin/users/${id}`).set('Cookie', adminCookie);
  });

  it('un PATCH sin password no toca el hash existente', async () => {
    const creada = await postUser({ email: 'patch-nopass@test', password: 'sigue-123', name: 'NoPass' });
    const id = creada.body.user.id;
    const { rows: antes } = await pool.query(`SELECT password_hash FROM "${schema}".users WHERE id = $1`, [id]);

    const res = await request(app).patch(`/api/admin/users/${id}`).set('Cookie', adminCookie).send({ name: 'NoPass v2' });
    expect(res.status).toBe(200);

    const { rows: despues } = await pool.query(`SELECT password_hash FROM "${schema}".users WHERE id = $1`, [id]);
    expect(despues[0].password_hash).toBe(antes[0].password_hash);
    expect(await loginAs('patch-nopass@test', 'sigue-123')).toBeTruthy();

    await request(app).delete(`/api/admin/users/${id}`).set('Cookie', adminCookie);
  });

  it('404 si el usuario no existe', async () => {
    const res = await request(app).patch('/api/admin/users/99999999').set('Cookie', adminCookie).send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('409 si el email nuevo choca con otro usuario', async () => {
    const creada = await postUser({ email: 'choque@test', password: 'pass-1' });
    const id = creada.body.user.id;
    const res = await request(app).patch(`/api/admin/users/${id}`).set('Cookie', adminCookie)
      .send({ email: 'admin@test' });
    expect(res.status).toBe(409);
    expect(res.body.field).toBe('email');
    // No cambió nada.
    const check = await request(app).get(`/api/admin/users/${id}`).set('Cookie', adminCookie);
    expect(check.body.user.email).toBe('choque@test');
    await request(app).delete(`/api/admin/users/${id}`).set('Cookie', adminCookie);
  });

  it('422 si el role es inválido', async () => {
    const res = await request(app).patch(`/api/admin/users/${editorId}`).set('Cookie', adminCookie)
      .send({ role: 'jefazo' });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('role');
    // El rol real no se tocó.
    const check = await request(app).get(`/api/admin/users/${editorId}`).set('Cookie', adminCookie);
    expect(check.body.user.role).toBe('editor');
  });

  it('422 { error } si el body no trae ningún campo editable', async () => {
    const res = await request(app).patch(`/api/admin/users/${editorId}`).set('Cookie', adminCookie)
      .send({ password_hash: 'x', id: 1, created_at: 'ayer' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBeTruthy();
    const vacio = await request(app).patch(`/api/admin/users/${editorId}`).set('Cookie', adminCookie).send({});
    expect(vacio.status).toBe(422);
  });

  it('invariante I5: el rol nuevo se aplica en la siguiente request del usuario', async () => {
    const creada = await postUser({ email: 'i5@test', password: 'pass-1', name: 'I5' });
    const id = creada.body.user.id;
    const cookie = await loginAs('i5@test', 'pass-1');

    // Como editor: 403 en el mantenedor de usuarios.
    expect((await request(app).get('/api/admin/users').set('Cookie', cookie)).status).toBe(403);

    // Lo promovemos a admin — misma cookie, sin re-login.
    const promo = await request(app).patch(`/api/admin/users/${id}`).set('Cookie', adminCookie).send({ role: 'admin' });
    expect(promo.status).toBe(200);
    expect((await request(app).get('/api/admin/users').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user.role).toBe('admin');

    // Y de vuelta a editor: el 403 regresa en la request siguiente.
    await request(app).patch(`/api/admin/users/${id}`).set('Cookie', adminCookie).send({ role: 'editor' });
    expect((await request(app).get('/api/admin/users').set('Cookie', cookie)).status).toBe(403);

    await request(app).delete(`/api/admin/users/${id}`).set('Cookie', adminCookie);
  });
});

// ---------------------------------------------------------------------------
// Criterio 7 — DELETE /api/admin/users/:id y sus dos guardas
// ---------------------------------------------------------------------------
describe('Criterio 7 — DELETE /api/admin/users/:id', { timeout: TIMEOUT_BCRYPT }, () => {
  it('204 sin body y la fila desaparece de la BD (borrado físico)', async () => {
    const creada = await postUser({ email: 'borrar@test', password: 'pass-1', name: 'Borrar' });
    const id = creada.body.user.id;

    const res = await request(app).delete(`/api/admin/users/${id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(204);
    expect(res.text).toBeFalsy();

    const { rows } = await pool.query(`SELECT id FROM "${schema}".users WHERE id = $1`, [id]);
    expect(rows).toHaveLength(0);
    expect((await request(app).get(`/api/admin/users/${id}`).set('Cookie', adminCookie)).status).toBe(404);
  });

  it('404 si el usuario no existe', async () => {
    const res = await request(app).delete('/api/admin/users/99999999').set('Cookie', adminCookie);
    expect(res.status).toBe(404);
  });

  it('guarda (a): 409 si un admin intenta borrarse a sí mismo, y sigue existiendo', async () => {
    const res = await request(app).delete(`/api/admin/users/${adminId}`).set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();

    const { rows } = await pool.query(`SELECT id FROM "${schema}".users WHERE id = $1`, [adminId]);
    expect(rows).toHaveLength(1);
    // Y la sesión sigue viva.
    expect((await request(app).get('/api/auth/me').set('Cookie', adminCookie)).status).toBe(200);
  });

  it('guarda (b): borrar un admin sí se permite mientras quede otro admin', async () => {
    await withFreshSchema(async ({ schema: s, app: a }) => {
      await createUser(pool, { email: 'a1@test', password: 'pass-1', role: ROLES.ADMIN }, { schema: s });
      await createUser(pool, { email: 'a2@test', password: 'pass-1', role: ROLES.ADMIN }, { schema: s });
      expect(await countAdmins(pool, { schema: s })).toBe(2);

      const cookie = await loginOn(a, 'a1@test', 'pass-1');
      const a2 = await findUserByEmail(pool, 'a2@test', { schema: s });

      const res = await request(a).delete(`/api/admin/users/${a2.id}`).set('Cookie', cookie);
      expect(res.status).toBe(204);
      expect(await countAdmins(pool, { schema: s })).toBe(1);
    });
  });

  it('guarda (b): no se puede borrar al último admin (last_admin) y la fila sobrevive', async () => {
    await withFreshSchema(async ({ schema: s }) => {
      const unico = await createUser(pool, { email: 'solo-admin@test', password: 'pass-1', role: ROLES.ADMIN }, { schema: s });
      await createUser(pool, { email: 'un-editor@test', password: 'pass-1', role: ROLES.EDITOR }, { schema: s });
      expect(await countAdmins(pool, { schema: s })).toBe(1);

      await expect(deleteUser(pool, unico.id, { schema: s })).rejects.toMatchObject({ code: 'last_admin' });
      expect(await countAdmins(pool, { schema: s })).toBe(1);

      // Un editor sí se puede borrar: la guarda es solo sobre el rol admin.
      const editor = await findUserByEmail(pool, 'un-editor@test', { schema: s });
      expect(await deleteUser(pool, editor.id, { schema: s })).toBe(true);
      expect(await countAdmins(pool, { schema: s })).toBe(1);
    });
  });

  it('guarda (b) bajo concurrencia: dos admins borrándose a la vez no pueden dejar el sistema sin ningún admin', async () => {
    await withFreshSchema(async ({ schema: s, app: a }) => {
      await createUser(pool, { email: 'race1@test', password: 'pass-1', role: ROLES.ADMIN }, { schema: s });
      await createUser(pool, { email: 'race2@test', password: 'pass-1', role: ROLES.ADMIN }, { schema: s });
      const [c1, c2] = await Promise.all([
        loginOn(a, 'race1@test', 'pass-1'),
        loginOn(a, 'race2@test', 'pass-1'),
      ]);
      const u1 = await findUserByEmail(pool, 'race1@test', { schema: s });
      const u2 = await findUserByEmail(pool, 'race2@test', { schema: s });

      // Cada uno intenta borrar al OTRO al mismo tiempo (no es autoborrado, así
      // que la guarda (a) no interviene): con un COUNT previo y suelto ambos
      // leerían "quedan 2" y la tabla acabaría sin admins.
      const [r1, r2] = await Promise.all([
        request(a).delete(`/api/admin/users/${u2.id}`).set('Cookie', c1),
        request(a).delete(`/api/admin/users/${u1.id}`).set('Cookie', c2),
      ]);

      const codigos = [r1.status, r2.status].sort();
      expect(codigos).toEqual([204, 409]);
      const rechazado = [r1, r2].find(r => r.status === 409);
      expect(rechazado.body.error).toMatch(/último/i);
      expect(await countAdmins(pool, { schema: s })).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Criterio 8 — TEST CRÍTICO: borrar al autor NO borra sus artículos
// ---------------------------------------------------------------------------
describe('Criterio 8 — borrar un usuario autor no borra sus artículos', { timeout: TIMEOUT_BCRYPT }, () => {
  it('el artículo sobrevive y su author_id queda en NULL (ON DELETE SET NULL)', async () => {
    // 1. Usuario autor (el author_id lo toma la app de la sesión, no del body).
    const autor = await postUser({ email: 'autor@test', password: 'pass-1', name: 'Autor', role: 'editor' });
    expect(autor.status).toBe(201);
    const autorId = autor.body.user.id;
    const autorCookie = await loginAs('autor@test', 'pass-1');

    // 2. Artículo escrito por él.
    const creado = await request(app).post('/api/admin/articles').set('Cookie', autorCookie)
      .send({ slug: 'articulo-del-autor', title: 'Artículo del autor', body_md: 'cuerpo', status: 'published' });
    expect(creado.status).toBe(201);
    const articuloId = creado.body.article.id;

    const { rows: antes } = await pool.query(
      `SELECT author_id FROM "${schema}".articles WHERE id = $1`, [articuloId],
    );
    expect(String(antes[0].author_id)).toBe(String(autorId));

    // 3. Se borra el usuario.
    const del = await request(app).delete(`/api/admin/users/${autorId}`).set('Cookie', adminCookie);
    expect(del.status).toBe(204);
    const { rows: sinUsuario } = await pool.query(`SELECT id FROM "${schema}".users WHERE id = $1`, [autorId]);
    expect(sinUsuario).toHaveLength(0);

    // 4. El artículo sigue existiendo, con author_id en NULL.
    const { rows: despues } = await pool.query(
      `SELECT id, title, author_id FROM "${schema}".articles WHERE id = $1`, [articuloId],
    );
    expect(despues).toHaveLength(1);
    expect(despues[0].title).toBe('Artículo del autor');
    expect(despues[0].author_id).toBeNull();

    // Y sigue publicado y visible por la API pública.
    const publico = await request(app).get('/api/articles/articulo-del-autor');
    expect(publico.status).toBe(200);
    expect(publico.body.article.title).toBe('Artículo del autor');
  });
});

// ---------------------------------------------------------------------------
// Criterio 9 — 401 sin cookie y 403 con rol editor en las 5 rutas
// ---------------------------------------------------------------------------
describe('Criterio 9 — autorización de las 5 rutas', { timeout: TIMEOUT_BCRYPT }, () => {
  it('401 sin cookie de sesión en las 5 rutas', async () => {
    expect((await request(app).get('/api/admin/users')).status).toBe(401);
    expect((await request(app).get(`/api/admin/users/${editorId}`)).status).toBe(401);
    expect((await request(app).post('/api/admin/users').send({ email: 'x@test', password: 'y' })).status).toBe(401);
    expect((await request(app).patch(`/api/admin/users/${editorId}`).send({ name: 'x' })).status).toBe(401);
    expect((await request(app).delete(`/api/admin/users/${editorId}`)).status).toBe(401);
    // Nada se creó ni se borró.
    expect((await request(app).get(`/api/admin/users/${editorId}`).set('Cookie', adminCookie)).status).toBe(200);
  });

  it('403 con rol editor en las 5 rutas (gestionar usuarios es solo de admin)', async () => {
    expect((await request(app).get('/api/admin/users').set('Cookie', editorCookie)).status).toBe(403);
    expect((await request(app).get(`/api/admin/users/${adminId}`).set('Cookie', editorCookie)).status).toBe(403);
    expect((await postUser({ email: 'por-editor@test', password: 'pass-1' }, editorCookie)).status).toBe(403);
    expect((await request(app).patch(`/api/admin/users/${adminId}`).set('Cookie', editorCookie).send({ role: 'editor' })).status).toBe(403);
    expect((await request(app).delete(`/api/admin/users/${adminId}`).set('Cookie', editorCookie)).status).toBe(403);

    // El editor no se pudo autopromover ni el admin fue tocado.
    const admin = await request(app).get(`/api/admin/users/${adminId}`).set('Cookie', adminCookie);
    expect(admin.body.user.role).toBe('admin');
    const editor = await request(app).get(`/api/admin/users/${editorId}`).set('Cookie', adminCookie);
    expect(editor.body.user.role).toBe('editor');
  });
});

// ---------------------------------------------------------------------------
// Criterio 10 — el editor puede eliminar publicaciones
// ---------------------------------------------------------------------------
describe('Criterio 10 — el editor elimina publicaciones (DELETE de artículos)', { timeout: TIMEOUT_BCRYPT }, () => {
  it('204 al borrar un artículo con cookie de editor, y la fila desaparece', async () => {
    const creado = await request(app).post('/api/admin/articles').set('Cookie', editorCookie)
      .send({ slug: 'borrable-por-editor', title: 'Borrable', body_md: 'x' });
    expect(creado.status).toBe(201);
    const id = creado.body.article.id;

    const res = await request(app).delete(`/api/admin/articles/${id}`).set('Cookie', editorCookie);
    expect(res.status).toBe(204);
    const { rows } = await pool.query(`SELECT id FROM "${schema}".articles WHERE id = $1`, [id]);
    expect(rows).toHaveLength(0);
  });

  it('el editor completa el CRUD del blog: ver, crear, editar y eliminar', async () => {
    expect((await request(app).get('/api/admin/articles').set('Cookie', editorCookie)).status).toBe(200);
    const creado = await request(app).post('/api/admin/articles').set('Cookie', editorCookie)
      .send({ slug: 'crud-completo-editor', title: 'CRUD', body_md: 'x' });
    expect(creado.status).toBe(201);
    const id = creado.body.article.id;
    expect((await request(app).get(`/api/admin/articles/${id}`).set('Cookie', editorCookie)).status).toBe(200);
    expect((await request(app).patch(`/api/admin/articles/${id}`).set('Cookie', editorCookie).send({ title: 'CRUD v2' })).status).toBe(200);
    expect((await request(app).delete(`/api/admin/articles/${id}`).set('Cookie', editorCookie)).status).toBe(204);
  });

  it('el guard del DELETE de artículos admite admin y editor en el código', () => {
    const src = readFileSync(new URL('../src/articlesRouter.js', import.meta.url), 'utf8');
    const linea = sinComentarios(src)
      .split('\n')
      .find(l => l.includes("router.delete('/api/admin/articles/:id'"));
    expect(linea).toBeTruthy();
    expect(linea).not.toMatch(/requireRole\('admin'\)/);
    // Usa el mismo `adminGuard` que el resto del CRUD de artículos…
    expect(linea).toMatch(/adminGuard/);
    // …que es [requireAuth, requireRole('admin', 'editor')].
    expect(src).toMatch(/const adminGuard = \[requireAuth, requireRole\('admin', 'editor'\)\]/);
  });

  it('docs/api-contract.md documenta ese DELETE como admin, editor', () => {
    const doc = readFileSync(new URL('../docs/api-contract.md', import.meta.url), 'utf8');
    const linea = doc.split('\n').find(l => l.includes('`DELETE`') && l.includes('/api/admin/articles/:id'));
    expect(linea).toBeTruthy();
    expect(linea).toMatch(/admin, editor/);
  });
});

// ---------------------------------------------------------------------------
// Criterio 11 — el editor NO gana permisos fuera del blog
// ---------------------------------------------------------------------------
describe('Criterio 11 — el editor no gana permisos fuera del blog', { timeout: TIMEOUT_BCRYPT }, () => {
  it('sigue recibiendo 403 en las rutas de escritura de imágenes (feature 7)', async () => {
    const post = await request(app).post('/api/admin/images').set('Cookie', editorCookie)
      .field('seccion', 'hero')
      .attach('file', Buffer.from('89504e470d0a1a0a', 'hex'), { filename: 'x.png', contentType: 'image/png' });
    expect(post.status).toBe(403);
    expect((await request(app).patch('/api/admin/images/1').set('Cookie', editorCookie).send({ alt: 'x' })).status).toBe(403);
    expect((await request(app).delete('/api/admin/images/1').set('Cookie', editorCookie)).status).toBe(403);
  });

  it('sigue recibiendo 403 en el mantenedor de usuarios', async () => {
    expect((await request(app).get('/api/admin/users').set('Cookie', editorCookie)).status).toBe(403);
    expect((await postUser({ email: 'nope@test', password: 'pass-1' }, editorCookie)).status).toBe(403);
  });

  it('leads: el editor solo lee (no existe ningún DELETE de leads que pueda ganar)', async () => {
    expect((await request(app).get('/api/admin/leads').set('Cookie', editorCookie)).status).toBe(200);
    // No hay ruta de borrado de leads: cae en el catch-all 404, no en un 204.
    const del = await request(app).delete('/api/admin/leads/1').set('Cookie', editorCookie);
    expect(del.status).toBe(404);
    expect(del.body.error).toBe('Not found');
  });

  it('el rol editor sigue siendo el default de la columna `role`', async () => {
    const u = await createUser(pool, { email: 'default-role@test', password: 'pass-1' }, { schema });
    expect(u.role).toBe('editor');
    await deleteUser(pool, u.id, { schema });
  });
});

// ---------------------------------------------------------------------------
// Criterio 12 — cero cambios en el esquema
// ---------------------------------------------------------------------------
describe('Criterio 12 — cero cambios en el esquema', { timeout: TIMEOUT_BCRYPT }, () => {
  it('la tabla users conserva exactamente sus 6 columnas (ni `activo` ni nada nuevo)', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'users'`,
      [schema],
    );
    expect(rows.map(r => r.column_name).sort())
      .toEqual(['created_at', 'email', 'id', 'name', 'password_hash', 'role'].sort());
  });

  it('src/db.js no añade DDL para esta feature (sin columna `activo`, sin tabla nueva)', () => {
    const dbSrc = readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
    expect(dbSrc).not.toMatch(/activo/i);
    // El único ADD COLUMN sobre users sigue siendo el `role` de la feature 15.
    const addColumns = dbSrc.match(/ALTER TABLE "\$\{schema\}"\.users ADD COLUMN[^\n]*/g) || [];
    expect(addColumns).toHaveLength(1);
    expect(addColumns[0]).toMatch(/role TEXT NOT NULL DEFAULT 'editor'/);
    // Y las tablas creadas siguen siendo las conocidas. `planes` se sumó con la
    // feature 9 (CRUD de precios), que sí trae DDL propio; lo que este test
    // protege es que la feature 8 (y cualquier otra) no toque `users`.
    const tablas = (dbSrc.match(/CREATE TABLE IF NOT EXISTS "\$\{schema\}"\.(\w+)/g) || [])
      .map(m => m.split('.').pop());
    expect(tablas.sort()).toEqual(['articles', 'images', 'leads', 'planes', 'users']);
  });

  it('ensureSchema sigue siendo idempotente con datos dentro', async () => {
    const u = await createUser(pool, { email: 'idempotente@test', password: 'pass-1', name: 'Idem' }, { schema });
    await ensureSchema(pool, { schema });   // segundo arranque simulado
    const { rows } = await pool.query(`SELECT name, role FROM "${schema}".users WHERE id = $1`, [u.id]);
    expect(rows[0]).toMatchObject({ name: 'Idem', role: 'editor' });
    await deleteUser(pool, u.id, { schema });
  });
});

// ---------------------------------------------------------------------------
// Criterio 13 — documentación
// ---------------------------------------------------------------------------
describe('Criterio 13 — documentación', () => {
  it('docs/api-contract.md documenta los 5 endpoints de usuarios', () => {
    const doc = readFileSync(new URL('../docs/api-contract.md', import.meta.url), 'utf8');
    expect(doc).toMatch(/\/api\/admin\/users/);
    expect(doc).toMatch(/\/api\/admin\/users\/:id/);
    for (const metodo of ['`GET`', '`POST`', '`PATCH`', '`DELETE`']) expect(doc).toContain(metodo);
    // Los dos 409 propios del DELETE.
    expect(doc).toMatch(/último/i);
    expect(doc).toMatch(/propio usuario/i);
  });

  it('docs/architecture.md y docs/database.md explican el modelo de roles y la invariante I3', () => {
    const arq = readFileSync(new URL('../docs/architecture.md', import.meta.url), 'utf8');
    expect(arq).toMatch(/usersRouter\.js/);
    expect(arq).toMatch(/\/api\/admin\/users/);
    const db = readFileSync(new URL('../docs/database.md', import.meta.url), 'utf8');
    expect(db).toMatch(/PUBLIC_COLS/);
    expect(db).toMatch(/password_hash/);
  });
});
