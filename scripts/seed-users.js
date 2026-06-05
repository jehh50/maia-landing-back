#!/usr/bin/env node
/**
 * Feature 15 — Seed del admin inicial.
 *
 * Uso:
 *   MAIA_ADMIN_EMAIL=admin@maia.test MAIA_ADMIN_PASSWORD=secret node scripts/seed-users.js
 *
 * Comportamiento:
 *   - Lee email/password de env. Si falta alguno → error y exit(1).
 *   - Importa dinámicamente `../src/users.js` (feature 14). Si no existe,
 *     muestra mensaje claro y sale con exit(1).
 *   - Si el user existe → actualiza `role='admin'`.
 *   - Si no existe → lo crea con `role='admin'` usando `createUser`.
 *   - Al final imprime el `{ id, email }` del admin asegurado.
 */

import 'dotenv/config';
import { createPool, ensureSchema } from '../src/db.js';
import { ROLES } from '../src/roles.js';

const email    = (process.env.MAIA_ADMIN_EMAIL    || '').trim().toLowerCase();
const password = (process.env.MAIA_ADMIN_PASSWORD || '').trim();
const schema   = (process.env.DB_SCHEMA || 'public').trim();

function fail(msg, code = 1) {
  console.error(`[seed-users] ${msg}`);
  process.exit(code);
}

if (!email)    fail('Falta MAIA_ADMIN_EMAIL en el entorno.');
if (!password) fail('Falta MAIA_ADMIN_PASSWORD en el entorno.');

let usersModule;
try {
  usersModule = await import('../src/users.js');
} catch (err) {
  if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/i.test(String(err.message)))) {
    fail('Falta src/users.js (feature 14 pendiente). No se puede crear el admin todavía.');
  }
  throw err;
}

const { createUser, findUserByEmail } = usersModule;
if (typeof createUser !== 'function' || typeof findUserByEmail !== 'function') {
  fail('src/users.js no exporta createUser/findUserByEmail (feature 14 incompleta).');
}

const pool = createPool();
try {
  await ensureSchema(pool, { schema });

  let user = await findUserByEmail(pool, email, { schema });
  if (user) {
    await pool.query(
      `UPDATE "${schema}".users SET role = $1 WHERE id = $2`,
      [ROLES.ADMIN, user.id],
    );
    console.log(`[seed-users] OK — usuario existente promovido a admin: id=${user.id} email=${user.email}`);
  } else {
    user = await createUser(pool, { email, password, name: 'Admin', role: ROLES.ADMIN }, { schema });
    // Defensa: si `createUser` no soporta el campo `role`, forzamos UPDATE.
    await pool.query(
      `UPDATE "${schema}".users SET role = $1 WHERE id = $2`,
      [ROLES.ADMIN, user.id],
    );
    console.log(`[seed-users] OK — admin creado: id=${user.id} email=${user.email}`);
  }
} catch (err) {
  console.error('[seed-users] Error:', err && err.message ? err.message : err);
  process.exit(1);
} finally {
  await pool.end().catch(() => {});
}
