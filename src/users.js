import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Crea un usuario con email único y password hasheado (bcrypt salt 12).
 * Lanza `Error('email_required')` o `Error('password_required')` si faltan campos.
 * Lanza `Error('email_taken')` si el email ya existe (violación de UNIQUE).
 */
export async function createUser(pool, { email, password, name = '' } = {}, { schema = 'public' } = {}) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) throw new Error('email_required');
  if (!password || String(password).length < 1) throw new Error('password_required');

  const passwordHash = await bcrypt.hash(String(password), SALT_ROUNDS);

  try {
    const { rows } = await pool.query(
      `INSERT INTO "${schema}".users (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, created_at`,
      [cleanEmail, passwordHash, String(name || '').trim().slice(0, 120)],
    );
    return rows[0];
  } catch (err) {
    if (err && err.code === '23505') {
      // unique_violation en email
      const e = new Error('email_taken');
      e.code = 'email_taken';
      throw e;
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

export const __test__ = { SALT_ROUNDS };
