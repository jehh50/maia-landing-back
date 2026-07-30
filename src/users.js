import bcrypt from 'bcryptjs';
import { ROLES } from './roles.js';

const SALT_ROUNDS = 12;

const NAME_MAX = 120;

/**
 * Columnas de `users` que pueden salir por la API. `password_hash` **NO** está
 * aquí y no debe estarlo nunca: es la invariante I3 de `CHECKPOINT.md`
 * (`password_hash` nunca sale por la API). Todas las queries del CRUD
 * (`listUsers`, `getUserById`, `createUser`, `updateUser`) seleccionan esta
 * constante — cero `SELECT *`.
 *
 * La única excepción deliberada es `findUserByEmail`, que sí lee
 * `password_hash` porque el login lo necesita para `verifyPassword`. No la
 * reutilices en los endpoints del CRUD.
 */
const PUBLIC_COLS = 'id, email, name, role, created_at';

/** Roles válidos del modelo plano de `src/roles.js`. */
export const VALID_ROLES = Object.freeze(Object.values(ROLES));

/** `true` si `role` es uno de los roles del modelo (`admin` | `editor`). */
export function isValidRole(role) {
  return VALID_ROLES.includes(role);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeName(name) {
  return String(name || '').trim().slice(0, NAME_MAX);
}

/** Hash bcrypt con el `SALT_ROUNDS` único del módulo (12). */
async function hashPassword(password) {
  return bcrypt.hash(String(password), SALT_ROUNDS);
}

/** Error de dominio con `code`, al estilo del `email_taken` que ya existía. */
function domainError(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

/**
 * Crea un usuario con email único y password hasheado (bcrypt salt 12).
 * Lanza `Error('email_required')` o `Error('password_required')` si faltan campos.
 * Lanza `Error('role_invalid')` si `role` no es `admin` ni `editor`.
 * Lanza `Error('email_taken')` si el email ya existe (violación de UNIQUE).
 *
 * `role` es opcional: el default replica el de la columna (`'editor'`), así que
 * el comportamiento de quien no lo pasa (scripts, tests previos) no cambia.
 */
export async function createUser(
  pool,
  { email, password, name = '', role = ROLES.EDITOR } = {},
  { schema = 'public' } = {},
) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) throw new Error('email_required');
  if (!password || String(password).length < 1) throw new Error('password_required');
  if (!isValidRole(role)) throw domainError('role_invalid');

  const passwordHash = await hashPassword(password);

  try {
    const { rows } = await pool.query(
      `INSERT INTO "${schema}".users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING ${PUBLIC_COLS}`,
      [cleanEmail, passwordHash, normalizeName(name), role],
    );
    return rows[0];
  } catch (err) {
    if (err && err.code === '23505') {
      // unique_violation en email
      throw domainError('email_taken');
    }
    throw err;
  }
}

/**
 * Busca un usuario por email (case-insensitive). Devuelve `null` si no existe.
 */
export async function findUserByEmail(pool, email, { schema = 'public' } = {}) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) return null;
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, name, role, created_at
       FROM "${schema}".users
      WHERE email = $1
      LIMIT 1`,
    [cleanEmail],
  );
  return rows[0] || null;
}

/**
 * Verifica una contraseña en texto plano contra el hash del usuario.
 * Devuelve `false` si el usuario es null o el password es inválido.
 */
export async function verifyPassword(user, password) {
  if (!user || !user.password_hash || !password) return false;
  try {
    return await bcrypt.compare(String(password), user.password_hash);
  } catch {
    return false;
  }
}

// --- CRUD de usuarios (feature 8) -----------------------------------------
// Todo lo de abajo selecciona `PUBLIC_COLS`: `password_hash` no sale por
// ninguna de estas funciones (invariante I3).

/**
 * Lista de usuarios ordenada por `id ASC` (orden de creación, estable).
 * Nunca incluye `password_hash`.
 */
export async function listUsers(pool, { schema = 'public' } = {}) {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLS} FROM "${schema}".users ORDER BY id ASC`,
  );
  return rows;
}

/** Un usuario por id, o `null` si no existe. Nunca incluye `password_hash`. */
export async function getUserById(pool, id, { schema = 'public' } = {}) {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLS} FROM "${schema}".users WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Cuenta los usuarios con rol `admin`.
 *
 * Acepta un `pool` **o un client** de `pg` (misma interfaz `.query`): eso es lo
 * que permite llamarla desde dentro de la transacción de `deleteUser` sin
 * duplicar el SQL de "cuántos admins hay".
 */
export async function countAdmins(poolOrClient, { schema = 'public' } = {}) {
  const { rows } = await poolOrClient.query(
    `SELECT COUNT(*)::int AS n FROM "${schema}".users WHERE role = $1`,
    [ROLES.ADMIN],
  );
  return rows[0].n;
}

/**
 * Actualiza los campos editables de un usuario: `email`, `name`, `role` y
 * `password`. Los campos ausentes en `patch` conservan su valor actual
 * (read-then-merge con lista de columnas **fija**, igual que `updateImage`: no
 * se construye un `SET` dinámico, así no hay dónde colar una interpolación).
 *
 * Si `patch.password` viene, se re-hashea con el mismo `SALT_ROUNDS` (12) del
 * módulo — nunca se guarda en texto plano y nunca se loguea.
 *
 * Devuelve el usuario actualizado (sin `password_hash`) o `null` si no existe.
 * Lanza `Error('email_taken')` (code `email_taken`) si el email nuevo choca con
 * otro usuario, y `Error('role_invalid')` si `role` no es válido.
 */
export async function updateUser(pool, id, patch = {}, { schema = 'public' } = {}) {
  const current = await getUserById(pool, id, { schema });
  if (!current) return null;

  if (patch.role !== undefined && !isValidRole(patch.role)) throw domainError('role_invalid');
  if (patch.email !== undefined && !normalizeEmail(patch.email)) throw domainError('email_required');

  const next = {
    email: patch.email !== undefined ? normalizeEmail(patch.email) : current.email,
    name:  patch.name  !== undefined ? normalizeName(patch.name)   : current.name,
    role:  patch.role  !== undefined ? patch.role                  : current.role,
  };

  // `null` = no tocar el hash actual (el COALESCE de la query lo resuelve).
  const passwordHash = patch.password !== undefined ? await hashPassword(patch.password) : null;

  try {
    const { rows } = await pool.query(
      `UPDATE "${schema}".users
          SET email = $1,
              name  = $2,
              role  = $3,
              password_hash = COALESCE($4::text, password_hash)
        WHERE id = $5
        RETURNING ${PUBLIC_COLS}`,
      [next.email, next.name, next.role, passwordHash, id],
    );
    return rows[0] || null;
  } catch (err) {
    if (err && err.code === '23505') throw domainError('email_taken');
    throw err;
  }
}

/**
 * Borra **físicamente** la fila del usuario (decisión del humano: no hay
 * borrado lógico ni columna `activo`). Los artículos de los que era autor
 * sobreviven con `author_id = NULL` — lo garantiza el
 * `ON DELETE SET NULL` de `articles.author_id` (`src/db.js`).
 *
 * Guarda del **último admin**: si el usuario a borrar es `admin` y es el único
 * que queda, lanza `Error('last_admin')` (code `last_admin`) y no borra nada —
 * si se permitiera, el sistema quedaría sin acceso al panel.
 *
 * Todo ocurre en **una transacción con `FOR UPDATE`**, no con un `COUNT`
 * previo y suelto: dos DELETE concurrentes de dos admins distintos podrían
 * leer ambos "quedan 2" y dejar la tabla sin ningún admin. La query de bloqueo
 * fija las filas de **todos** los admins más la fila objetivo, en un único
 * `SELECT ... ORDER BY id FOR UPDATE`:
 *
 *  - El orden determinista (`ORDER BY id`) y el hecho de que sea una sola
 *    sentencia evitan el deadlock que aparecería si cada transacción bloqueara
 *    primero su objetivo y después el resto de admins (A espera a B y B a A).
 *  - La segunda transacción queda bloqueada hasta que la primera commitea y,
 *    al desbloquearse, `READ COMMITTED` reevalúa el `WHERE` sobre la versión
 *    nueva de las filas: ya no ve al admin borrado, cuenta 1 y rechaza.
 *
 * Devuelve `true` si borró, `false` si el usuario no existía.
 */
export async function deleteUser(pool, id, { schema = 'public' } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: locked } = await client.query(
      `SELECT id, role
         FROM "${schema}".users
        WHERE role = $1 OR id = $2
        ORDER BY id
          FOR UPDATE`,
      [ROLES.ADMIN, id],
    );

    const target = locked.find((r) => String(r.id) === String(id));
    if (!target) {
      await client.query('ROLLBACK');
      return false;
    }

    if (target.role === ROLES.ADMIN) {
      // Dentro de la transacción y con las filas de admin ya bloqueadas, así
      // que este número no puede quedarse obsoleto entre el COUNT y el DELETE.
      const admins = await countAdmins(client, { schema });
      if (admins <= 1) throw domainError('last_admin');
    }

    const { rowCount } = await client.query(
      `DELETE FROM "${schema}".users WHERE id = $1`,
      [id],
    );
    await client.query('COMMIT');
    return rowCount > 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const __test__ = { SALT_ROUNDS, PUBLIC_COLS };
