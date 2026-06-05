#!/usr/bin/env node
// Crea un usuario admin desde la CLI.
//   node scripts/create-user.js <email> <password> [name]
//
// Lee `DATABASE_URL` y `DB_SCHEMA` desde el entorno (mismo .env del server).
// Útil para crear el primer admin manualmente cuando aún no hay UI de alta.

import 'dotenv/config';
import { createPool, ensureSchema } from '../src/db.js';
import { createUser } from '../src/users.js';

const [, , email, password, ...rest] = process.argv;
const name = rest.join(' ').trim();

function usage(code = 1) {
  const msg = 'Uso: node scripts/create-user.js <email> <password> [name]';
  if (code === 0) console.log(msg);
  else console.error(msg);
  process.exit(code);
}

if (!email || !password) usage(1);

const schema = process.env.DB_SCHEMA || 'public';

const pool = createPool();
try {
  await ensureSchema(pool, { schema });
  const user = await createUser(pool, { email, password, name }, { schema });
  console.log(`[create-user] OK id=${user.id} email=${user.email} name="${user.name ?? ''}"`);
  process.exit(0);
} catch (err) {
  if (err?.code === 'email_taken' || err?.message === 'email_taken') {
    console.error(`[create-user] el email "${email}" ya está registrado`);
    process.exit(2);
  }
  console.error('[create-user] error:', err?.message || err);
  process.exit(1);
} finally {
  await pool.end().catch(() => {});
}
