import { describe, it, expect, vi } from 'vitest';
import { ROLES, hasRole, requireRole } from '../src/roles.js';

// Este archivo es 100% puro (feature 4, "Suite unitaria que corra sin
// Postgres"): solo ejercita funciones de `src/roles.js` sobre mocks de
// Express hechos a mano, sin `import` de `db.js` ni ningún `pool` — puede
// correr con Postgres apagado. La migración `ALTER TABLE users ADD COLUMN
// role` (la única parte de la suite de roles que sí necesita DB real) vive
// separada en `tests/roles.schema.test.js`.

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
