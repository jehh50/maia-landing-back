import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, ensureSchema } from '../src/db.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres:///maia-landing?host=/var/run/postgresql';

// Separado de `tests/roles.test.js` (feature 4, "Suite unitaria que corra sin
// Postgres"): este archivo es la única parte de la suite de roles que abre
// una conexión real a Postgres (migración `ALTER TABLE users ADD COLUMN
// role`). El resto de `roles.js` (ROLES, hasRole, requireRole) es lógica pura
// y vive en `tests/roles.test.js`, que puede correr sin DB. Contenido
// idéntico al describe original, solo movido de archivo — ningún `it()` se
// borró ni se modificó.
describe('ensureSchema añade columna `role` a users', () => {
  const schema = `maia_test_roles_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let pool;

  beforeAll(async () => {
    pool = createPool({ connectionString: TEST_DB_URL });
    // Simulamos que feature 14 corrió antes y dejó la tabla mínima.
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await pool.query(`
      CREATE TABLE "${schema}".users (
        id    BIGSERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL
      )
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });

  it('después de ensureSchema, users.role existe con default "editor"', async () => {
    await ensureSchema(pool, { schema });

    const { rows } = await pool.query(
      `SELECT column_name, column_default, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'role'`,
      [schema],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].is_nullable).toBe('NO');
    // El default puede venir como `'editor'::text` según el driver/pg.
    expect(String(rows[0].column_default)).toMatch(/editor/);

    // El default se aplica al INSERT sin role.
    const ins = await pool.query(
      `INSERT INTO "${schema}".users (email) VALUES ($1) RETURNING role`,
      ['roleless@test.com'],
    );
    expect(ins.rows[0].role).toBe('editor');
  });

  it('ensureSchema NO rompe cuando la tabla users no existe (ALTER tolerante)', async () => {
    const tmpSchema = `${schema}_no_users`;
    await pool.query(`CREATE SCHEMA "${tmpSchema}"`);
    try {
      // No creamos `users` aquí. ensureSchema creará leads y luego, dado que
      // su propia creación de `users` también está incluida desde feature 14,
      // el ALTER debería ejecutarse OK. Lo importante: no debe lanzar.
      await expect(ensureSchema(pool, { schema: tmpSchema })).resolves.not.toThrow();
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${tmpSchema}" CASCADE`);
    }
  });
});
