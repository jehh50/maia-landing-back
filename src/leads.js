// Helpers de lectura para tabla `leads`. La escritura sigue en `app.js#POST /api/contact`.

const COLS = 'id, nombre, empresa, email, telefono, pais, pais_iso, industria, mensaje, tipo, created_at';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX     = 200;

function sanitizeLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return LIMIT_DEFAULT;
  return Math.min(Math.floor(n), LIMIT_MAX);
}

function sanitizeOffset(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export async function listLeads(pool, schema, { tipo, pais_iso, q, limit, offset } = {}) {
  const limitN  = sanitizeLimit(limit);
  const offsetN = sanitizeOffset(offset);
  const where   = [];
  const params  = [];

  if (tipo) {
    params.push(String(tipo));
    where.push(`tipo = $${params.length}`);
  }
  if (pais_iso) {
    params.push(String(pais_iso).toUpperCase());
    where.push(`pais_iso = $${params.length}`);
  }
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim()}%`);
    const i = params.length;
    where.push(`(nombre ILIKE $${i} OR email ILIKE $${i} OR empresa ILIKE $${i})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalQ = await pool.query(
    `SELECT COUNT(*)::int AS n FROM "${schema}".leads ${whereSql}`,
    params,
  );
  const total = totalQ.rows[0].n;

  params.push(limitN, offsetN);
  const { rows } = await pool.query(
    `SELECT ${COLS}
       FROM "${schema}".leads
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { rows, total, limit: limitN, offset: offsetN };
}

export async function getLeadById(pool, schema, id) {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM "${schema}".leads WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}
