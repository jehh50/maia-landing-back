import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ROLES, hasRole, requireRole } from '../src/roles.js';
import { createPool, ensureSchema } from '../src/db.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres:///maia-landing?host=/var/run/postgresql';

// ---------- helpers de mock para Express ----------
function mockRes() {
  const res = {
    statusCode: null,
    body:       null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  vi.spyOn(res, 'status');
  vi.spyOn(res, 'json');
  return res;
}

describe('ROLES (constantes)', () => {
  it('expone admin y editor', () => {
    expect(ROLES.ADMIN).toBe('admin');
    expect(ROLES.EDITOR).toBe('editor');
  });

  it('es inmutable (Object.freeze)', () => {
    expect(Object.isFrozen(ROLES)).toBe(true);
  });
});

describe('hasRole(user, ...roles)', () => {
  it('admin coincide con admin → true', () => {
    expect(hasRole({ role: 'admin' }, 'admin')).toBe(true);
  });

  it('editor NO coincide con admin → false', () => {
    expect(hasRole({ role: 'editor' }, 'admin')).toBe(false);
  });

  it('editor coincide cuando la lista es [admin, editor] → true', () => {
    expect(hasRole({ role: 'editor' }, 'admin', 'editor')).toBe(true);
  });

  it('user null → false (sin sesión)', () => {
    expect(hasRole(null, 'admin')).toBe(false);
  });

  it('user undefined → false', () => {
    expect(hasRole(undefined, 'admin')).toBe(false);
  });

  it('user sin campo role → false', () => {
    expect(hasRole({ id: 1, email: 'a@b.com' }, 'admin')).toBe(false);
  });

  it('lista vacía de roles → false (deny by default)', () => {
    expect(hasRole({ role: 'admin' })).toBe(false);
  });
});

describe('requireRole(...roles) middleware', () => {
  it('rol insuficiente → res.status(403) y NO llama a next()', () => {
    const req  = { user: { role: 'editor' } };
    const res  = mockRes();
    const next = vi.fn();

    requireRole('admin')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('forbidden');
    expect(next).not.toHaveBeenCalled();
  });

  it('rol coincide → llama a next() sin tocar res', () => {
    const req  = { user: { role: 'admin' } };
    const res  = mockRes();
    const next = vi.fn();

    requireRole('admin')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('lista con múltiples roles permite a cualquiera de ellos (editor en [admin, editor])', () => {
    const req  = { user: { role: 'editor' } };
    const res  = mockRes();
    const next = vi.fn();

    requireRole('admin', 'editor')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('sin req.user → 403 (no autenticado / token inválido)', () => {
    const req  = {};
    const res  = mockRes();
    const next = vi.fn();

    requireRole('admin')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------- migración: ALTER TABLE add role ----------
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
