// Capa de datos para la tabla `articles`. Solo SQL puro; el router HTTP vive en articlesRouter.js.

export function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // quita acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

const COLS = 'id, slug, title, excerpt, body_md, cover_url, status, author_id, published_at, created_at, updated_at';

export async function createArticle(pool, schema, payload) {
  const slug = payload.slug?.trim() || slugify(payload.title);
  const status = payload.status === 'published' ? 'published' : 'draft';
  const publishedAt = status === 'published' ? new Date() : null;
  const { rows } = await pool.query(
    `INSERT INTO "${schema}".articles (slug, title, excerpt, body_md, cover_url, status, author_id, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLS}`,
    [
      slug,
      payload.title,
      payload.excerpt ?? null,
      payload.body_md ?? '',
      payload.cover_url ?? null,
      status,
      payload.author_id ?? null,
      publishedAt,
    ],
  );
  return rows[0];
}

export async function updateArticle(pool, schema, id, patch) {
  const current = await getArticleById(pool, schema, id);
  if (!current) return null;

  const next = {
    slug:      patch.slug      ?? current.slug,
    title:     patch.title     ?? current.title,
    excerpt:   patch.excerpt   ?? current.excerpt,
    body_md:   patch.body_md   ?? current.body_md,
    cover_url: patch.cover_url ?? current.cover_url,
    status:    patch.status    ?? current.status,
  };

  // Si pasa a published por primera vez, set published_at.
  let publishedAt = current.published_at;
  if (current.status !== 'published' && next.status === 'published') {
    publishedAt = new Date();
  }

  const { rows } = await pool.query(
    `UPDATE "${schema}".articles
        SET slug = $1, title = $2, excerpt = $3, body_md = $4, cover_url = $5,
            status = $6, published_at = $7, updated_at = NOW()
      WHERE id = $8
      RETURNING ${COLS}`,
    [next.slug, next.title, next.excerpt, next.body_md, next.cover_url, next.status, publishedAt, id],
  );
  return rows[0] || null;
}

export async function deleteArticle(pool, schema, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM "${schema}".articles WHERE id = $1`,
    [id],
  );
  return rowCount > 0;
}

export async function getArticleById(pool, schema, id) {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM "${schema}".articles WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

export async function getArticleBySlug(pool, schema, slug) {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM "${schema}".articles WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  return rows[0] || null;
}

export async function listArticles(pool, schema, { status, limit = 50, offset = 0 } = {}) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE status = $${params.length}`;
  }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  params.push(Math.max(Number(offset) || 0, 0));
  const sql = `
    SELECT ${COLS}
    FROM "${schema}".articles
    ${where}
    ORDER BY COALESCE(published_at, updated_at) DESC, id DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

export async function countArticles(pool, schema, { status } = {}) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE status = $1`;
  }
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM "${schema}".articles ${where}`, params);
  return rows[0].n;
}
