import { Router } from 'express';
import {
  VALID_ROLES, isValidRole,
  createUser, listUsers, getUserById, updateUser, deleteUser,
} from './users.js';
import { requireRole } from './roles.js';
import { asyncHandler } from './asyncHandler.js';

// Máximo de un `bigint` de Postgres (2^63 - 1). Un id por encima de esto no es
// "no encontrado" para Postgres: es un error de conversión (22003
// numeric_value_out_of_range) que, sin este guard, acabaría en un 500.
const PG_BIGINT_MAX = 9223372036854775807n;

const ROLE_ERROR = `role inválido. Valores válidos: ${VALID_ROLES.join(', ')}`;
const NOT_FOUND  = 'Usuario no encontrado';

/**
 * Los ids son BIGSERIAL: aceptamos solo dígitos **y solo dentro del rango de un
 * `bigint`**. Cualquier otra cosa devuelve `null` y el router responde 404, así
 * que ni `/api/admin/users/abc` (error 22P02 invalid_text_representation) ni
 * `/api/admin/users/99999999999999999999999` (error 22003
 * numeric_value_out_of_range) llegan a Postgres para acabar en un 500. Mismo
 * patrón que `src/imagesRouter.js` (feature 7).
 */
function parseId(raw) {
  const s = String(raw ?? '');
  if (!/^\d{1,19}$/.test(s)) return null;
  if (BigInt(s) > PG_BIGINT_MAX) return null;
  return s;
}

/**
 * Factory del router del mantenedor de usuarios (feature 8).
 *
 * Los cinco endpoints son **solo rol `admin`**: gestionar usuarios no es parte
 * del acceso del rol `editor` (que solo llega al blog). No hay ninguna ruta
 * pública de usuarios.
 *
 * Este módulo no escribe SQL (C7): toda la persistencia vive en `src/users.js`.
 *
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool
 * @param {string} [opts.schema='public']
 * @param {import('express').RequestHandler} opts.requireAuth
 */
export function createUsersRouter({ pool, schema = 'public', requireAuth } = {}) {
  if (!pool) throw new Error('createUsersRouter requiere `pool`');
  if (!requireAuth) throw new Error('createUsersRouter requiere `requireAuth`');

  const router = Router();
  const adminGuard = [requireAuth, requireRole('admin')];

  router.get('/api/admin/users', ...adminGuard, asyncHandler(async (_req, res) => {
    try {
      const rows = await listUsers(pool, { schema });
      res.json({ rows });
    } catch (err) {
      console.error('[users] list error', err);
      res.status(500).json({ error: 'Error al listar usuarios' });
    }
  }));

  router.get('/api/admin/users/:id', ...adminGuard, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: NOT_FOUND });
    try {
      const user = await getUserById(pool, id, { schema });
      if (!user) return res.status(404).json({ error: NOT_FOUND });
      res.json({ user });
    } catch (err) {
      console.error('[users] get error', err);
      res.status(500).json({ error: 'Error al cargar usuario' });
    }
  }));

  router.post('/api/admin/users', ...adminGuard, asyncHandler(async (req, res) => {
    const body = req.body || {};

    const email = String(body.email || '').trim();
    if (!email) return res.status(422).json({ error: 'email requerido', field: 'email' });

    const password = body.password === undefined ? '' : String(body.password);
    if (!password) return res.status(422).json({ error: 'password requerido', field: 'password' });

    // `role` es opcional: si no viene, `createUser` aplica el default `editor`
    // (el mismo de la columna). Si viene, tiene que ser válido.
    if (body.role !== undefined && !isValidRole(body.role)) {
      return res.status(422).json({ error: ROLE_ERROR, field: 'role' });
    }

    try {
      const user = await createUser(
        pool,
        {
          email,
          password,
          name: body.name !== undefined ? String(body.name) : '',
          // No pasamos `role: undefined` explícito para no pisar el default de
          // la firma de `createUser`.
          ...(body.role !== undefined ? { role: body.role } : {}),
        },
        { schema },
      );
      res.status(201).json({ user });
    } catch (err) {
      if (err?.code === 'email_taken') {
        return res.status(409).json({ error: 'El email ya está en uso', field: 'email' });
      }
      // Se loguea el error REAL (C8, docs/conventions.md §7): un fallo
      // inesperado de Postgres sin traza es un incidente imposible de
      // diagnosticar. La contraseña **en claro** no puede acabar aquí: nunca
      // viaja a la base de datos — a la query va su hash bcrypt, calculado
      // antes (`hashPassword` en src/users.js) — y `err` es el error, no la
      // request, así que el body tampoco entra en la traza.
      //
      // Residual conocido y aceptado: si algún día `users` tuviera un CHECK o
      // un NOT NULL que se violara, el `detail` que Postgres adjunta al error
      // ("La fila que falla contiene (…)") incluiría el **hash** de la fila.
      // Hoy es inalcanzable — la única restricción de `users` es el UNIQUE de
      // `email`, y ese caso (23505) se responde 409 antes de llegar a este
      // log. Si se añade una restricción nueva, hay que revisar esto.
      console.error('[users] create error', err);
      res.status(500).json({ error: 'Error al crear usuario' });
    }
  }));

  router.patch('/api/admin/users/:id', ...adminGuard, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: NOT_FOUND });

    const body = req.body || {};
    const patch = {};

    if (body.email !== undefined) {
      const email = String(body.email).trim();
      if (!email) return res.status(422).json({ error: 'email requerido', field: 'email' });
      patch.email = email;
    }
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.role !== undefined) {
      if (!isValidRole(body.role)) {
        return res.status(422).json({ error: ROLE_ERROR, field: 'role' });
      }
      patch.role = body.role;
    }
    // Decisión del humano: el admin SÍ puede cambiar la contraseña de otro
    // usuario. Se re-hashea en `updateUser` con el SALT_ROUNDS del módulo.
    if (body.password !== undefined) {
      const password = String(body.password);
      if (!password) return res.status(422).json({ error: 'password requerido', field: 'password' });
      patch.password = password;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(422).json({ error: 'Nada que actualizar: se esperaba email, name, role o password' });
    }

    try {
      const user = await updateUser(pool, id, patch, { schema });
      if (!user) return res.status(404).json({ error: NOT_FOUND });
      res.json({ user });
    } catch (err) {
      if (err?.code === 'email_taken') {
        return res.status(409).json({ error: 'El email ya está en uso', field: 'email' });
      }
      // Igual que en el POST: se loguea el error real (C8). La contraseña en
      // claro no llega a la base de datos ni, por tanto, a esta traza.
      console.error('[users] update error', err);
      res.status(500).json({ error: 'Error al actualizar usuario' });
    }
  }));

  router.delete('/api/admin/users/:id', ...adminGuard, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: NOT_FOUND });

    // Guarda (a): nadie se borra a sí mismo. `req.user.id` lo pone `requireAuth`
    // recargando el usuario de la DB en cada request (invariante I5).
    if (String(req.user?.id) === id) {
      return res.status(409).json({ error: 'No puedes eliminar tu propio usuario' });
    }

    try {
      // Guarda (b) — último admin: la resuelve `deleteUser` dentro de una
      // transacción con `FOR UPDATE`, no con un COUNT previo, para que dos
      // borrados concurrentes no puedan dejar el sistema sin ningún admin.
      const ok = await deleteUser(pool, id, { schema });
      if (!ok) return res.status(404).json({ error: NOT_FOUND });
      res.status(204).end();
    } catch (err) {
      if (err?.code === 'last_admin') {
        return res.status(409).json({ error: 'No puedes eliminar al último usuario con rol admin' });
      }
      console.error('[users] delete error', err);
      res.status(500).json({ error: 'Error al borrar usuario' });
    }
  }));

  return router;
}
