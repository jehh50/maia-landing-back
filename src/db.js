import pg from 'pg';

const { Pool } = pg;

export function createPool(config = {}) {
  const connectionString = config.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString && !config.host) {
    throw new Error('DATABASE_URL no configurada (o pasa { host, user, database } a createPool)');
  }

  const poolConfig = connectionString
    ? { connectionString }
    : {
        host:     config.host,
        port:     config.port ?? 5432,
        user:     config.user,
        password: config.password,
        database: config.database,
      };

  if (config.ssl ?? (process.env.PGSSL === 'true')) {
    poolConfig.ssl = { rejectUnauthorized: false };
  }

  poolConfig.max = config.max ?? 10;
  poolConfig.idleTimeoutMillis = config.idleTimeoutMillis ?? 30000;

  return new Pool(poolConfig);
}

export async function ensureSchema(pool, { schema = 'public' } = {}) {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schema}".leads (
      id          BIGSERIAL PRIMARY KEY,
      nombre      TEXT,
      empresa     TEXT,
      email       TEXT NOT NULL,
      telefono    TEXT,
      pais        TEXT,
      pais_iso    TEXT,
      industria   TEXT,
      mensaje     TEXT,
      tipo        TEXT NOT NULL DEFAULT 'demo',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Migraciones idempotentes para tablas creadas en features previos
  await pool.query(`ALTER TABLE "${schema}".leads ADD COLUMN IF NOT EXISTS industria TEXT`);
  await pool.query(`ALTER TABLE "${schema}".leads ADD COLUMN IF NOT EXISTS pais      TEXT`);
  await pool.query(`ALTER TABLE "${schema}".leads ADD COLUMN IF NOT EXISTS pais_iso  TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS leads_email_idx      ON "${schema}".leads (email)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS leads_created_at_idx ON "${schema}".leads (created_at DESC)`);

  // --- users (feature 14: login admin) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schema}".users (
      id            BIGSERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name          TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_email_idx ON "${schema}".users (email)`);

  // Feature 15 — Roles de usuarios (admin/editor).
  // Se añade `role` con `ALTER ... ADD COLUMN IF NOT EXISTS` para que la
  // migración sea idempotente. Si la tabla `users` aún no existe (feature 14
  // pendiente en alguna rama), ignoramos el error 42P01 (undefined_table):
  // al siguiente arranque, una vez `users` creada, este ALTER tomará efecto.
  try {
    await pool.query(
      `ALTER TABLE "${schema}".users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'editor'`,
    );
  } catch (err) {
    if (err && err.code !== '42P01') throw err;
  }

  // --- articles (feature 13: mantenedor de blog) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schema}".articles (
      id           BIGSERIAL PRIMARY KEY,
      slug         TEXT UNIQUE NOT NULL,
      title        TEXT NOT NULL,
      excerpt      TEXT,
      body_md      TEXT NOT NULL,
      cover_url    TEXT,
      status       TEXT NOT NULL DEFAULT 'draft',
      author_id    BIGINT REFERENCES "${schema}".users(id) ON DELETE SET NULL,
      published_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS articles_status_idx ON "${schema}".articles (status, published_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS articles_slug_idx   ON "${schema}".articles (slug)`);
}

export async function insertLead(pool, lead, { schema = 'public' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO "${schema}".leads
       (nombre, empresa, email, telefono, pais, pais_iso, industria, mensaje, tipo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      lead.nombre    ?? '',
      lead.empresa   ?? '',
      lead.email,
      lead.telefono  ?? '',
      lead.pais      ?? '',
      lead.pais_iso  ?? '',
      lead.industria ?? '',
      lead.mensaje   ?? '',
      lead.tipo      ?? 'demo',
    ],
  );
  return rows[0].id;
}
