import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createPool, ensureSchema, insertLead } from './db.js';
import { createMailer } from './email.js';
import { detectCountry } from './phone.js';
import { createAuthRouter } from './auth.js';
import { createArticlesRouter } from './articlesRouter.js';
import { createLeadsRouter } from './leadsRouter.js';
import { createUsersRouter } from './usersRouter.js';
import { createImagesRouter } from './imagesRouter.js';
import { createPreciosRouter } from './preciosRouter.js';
import { asyncHandler } from './asyncHandler.js';
import { createRateLimiter } from './rateLimit.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Acepta formato E.164 (`+` + 7–15 dígitos) tolerante a espacios, paréntesis y guiones.
const PHONE_RE = /^\+\d{7,15}$/;
const VALID_TIPOS = new Set(['demo', 'email', 'contacto']);

function normalizePhone(raw) {
  return String(raw || '').replace(/[\s\-()]/g, '').trim();
}

// --- Rate limiting (feature 3, ver docs/architecture.md §12) ---
// Defaults elegidos para tolerar el volumen de tests/contact.test.js (15
// POST) y tests/auth.test.js (5 POST) sin tocarlos, y a la vez ser
// razonables en producción. Ver progress/current.md, decisión 3.
const RATE_LIMIT_DEFAULTS = {
  contact: { windowMs: 60_000, max: 20 },      // 1 min / 20 req por IP
  auth:    { windowMs: 900_000, max: 10 },     // 15 min / 10 intentos por IP
};

function positiveNumberFromEnv(name) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resuelve un middleware de rate limit a partir de (en orden de precedencia):
 * 1. `override` explícito de la factory — `false`/`null` lo desactiva por
 *    completo (no se monta middleware); un objeto sobreescribe windowMs/max/
 *    now/keyGenerator.
 * 2. Variables de entorno `${envPrefix}_WINDOW_MS` / `${envPrefix}_MAX`.
 * 3. `defaults`.
 */
function resolveRateLimiter(override, envPrefix, defaults) {
  if (override === false || override === null) return null;
  const opts = override && typeof override === 'object' ? override : {};
  const windowMs = opts.windowMs ?? positiveNumberFromEnv(`${envPrefix}_WINDOW_MS`) ?? defaults.windowMs;
  const max      = opts.max      ?? positiveNumberFromEnv(`${envPrefix}_MAX`)       ?? defaults.max;
  return createRateLimiter({
    windowMs,
    max,
    now: opts.now,
    keyGenerator: opts.keyGenerator,
  });
}

// `asyncHandler` vive en su propio módulo (`./asyncHandler.js`) para que lo
// puedan importar también auth.js/articlesRouter.js/leadsRouter.js sin crear
// un ciclo de imports con este archivo (que ya importa esos routers). Se
// re-exporta aquí por compatibilidad con quien lo importe desde `app.js`.
export { asyncHandler };

// Middleware de errores JSON. Siempre se monta al final del pipeline (después
// del catch-all 404): cualquier excepción no capturada — síncrona (Express la
// reenvía solo) o asíncrona (reenviada explícitamente vía asyncHandler /
// next(err)) — responde JSON en vez del HTML por defecto de Express. Nunca se
// exponen stack, mensaje real ni detalles internos al cliente; eso va al log.
export function errorHandler(err, _req, res, next) {
  if (res.headersSent) return next(err);
  console.error('[app] unhandled error', err);
  res.status(500).json({ error: 'Error interno del servidor' });
}

export function createApp(options = {}) {
  const corsOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN ?? '*';
  const schema     = options.schema     ?? process.env.DB_SCHEMA   ?? 'public';

  const pool = options.pool ?? createPool();

  const mailer = options.mailer ?? createMailer();

  const rateLimitOptions = options.rateLimit ?? {};
  const contactLimiter = resolveRateLimiter(rateLimitOptions.contact, 'CONTACT_RATE_LIMIT', RATE_LIMIT_DEFAULTS.contact);
  const authLimiter    = resolveRateLimiter(rateLimitOptions.auth,    'AUTH_RATE_LIMIT',    RATE_LIMIT_DEFAULTS.auth);
  // Middleware "passthrough" cuando el limiter correspondiente se desactivó
  // explícitamente (`rateLimit: { contact: false }` / `{ auth: false }`).
  const passthrough = (_req, _res, next) => next();

  const app = express();
  // Render (`render.yaml`, plan free) pone exactamente un reverse proxy
  // delante de este proceso. `trust proxy: 1` hace que Express confíe en un
  // único hop de `X-Forwarded-For`: toma la IP que ese proxy añadió (la real
  // del cliente) e ignora cualquier IP que el cliente haya intentado inyectar
  // por delante en la cabecera. Sin esto, `req.ip` sería siempre la IP del
  // proxy de Render para todo el tráfico y el rate limiting por IP
  // bloquearía a todos los usuarios a la vez que a un único abusador. Con
  // `trust proxy: true` (confiar en toda la cadena) un cliente podría
  // spoofear su IP con su propio `X-Forwarded-For`. Ver
  // docs/architecture.md §12 y progress/current.md (decisión 4).
  app.set('trust proxy', options.trustProxy ?? 1);
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use(cookieParser());
  app.use(cors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(','),
    credentials: true,
  }));

  // --- Auth (feature 14) ---
  const auth = options.auth ?? createAuthRouter({
    pool, schema, secret: options.authSecret, rateLimiter: authLimiter,
  });
  app.use(auth.router);
  app._auth = auth;

  // --- Admin: articles (feature 13) y leads (feature 16) ---
  app.use(createArticlesRouter({ pool, schema, requireAuth: auth.requireAuth }));
  app.use(createLeadsRouter   ({ pool, schema, requireAuth: auth.requireAuth }));

  // --- Mantenedor de usuarios (feature 8) — solo rol admin ---
  app.use(createUsersRouter({ pool, schema, requireAuth: auth.requireAuth }));

  // --- Imágenes de secciones (feature 7) ---
  // `maxFileSize` sigue el mismo criterio que el rate limiting: default activo
  // sin configurar nada, override por env (`IMAGES_MAX_FILE_SIZE_BYTES`, leída
  // dentro de la factory, nunca en tiempo de import) o por esta opción.
  app.use(createImagesRouter({
    pool, schema,
    requireAuth: auth.requireAuth,
    maxFileSize: options.images?.maxFileSize,
  }));

  // --- Precios: planes de la landing (feature 9) ---
  // `GET /api/precios` es público; las cuatro rutas `/api/admin/precios*` son
  // solo rol admin.
  app.use(createPreciosRouter({ pool, schema, requireAuth: auth.requireAuth }));

  app.get('/api/health', asyncHandler(async (_req, res) => {
    try {
      const { rows } = await pool.query('SELECT 1 AS ok');
      res.json({ ok: true, db: rows[0].ok === 1, mailer: mailer.enabled });
    } catch (err) {
      console.error('Health DB error', err);
      res.status(503).json({ ok: false, db: false, mailer: mailer.enabled });
    }
  }));

  app.post('/api/contact', contactLimiter ?? passthrough, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const email    = String(body.email    || '').trim();
    const nombre   = String(body.nombre   || '').trim();
    const telefono = normalizePhone(body.telefono);
    const tipoRaw  = String(body.tipo     || '').trim();

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(422).json({ error: 'Email inválido o requerido', field: 'email' });
    }
    // Email-only flows (CTA final / ROI) no requieren nombre ni teléfono.
    const emailOnlyFlow = tipoRaw === 'email';
    if (!emailOnlyFlow) {
      if (!nombre)               return res.status(422).json({ error: 'Nombre requerido', field: 'nombre' });
      if (!PHONE_RE.test(telefono)) return res.status(422).json({ error: 'Teléfono inválido o requerido (formato +country…)', field: 'telefono' });
    }

    const { iso: paisIso, name: paisName } = detectCountry(telefono);

    const lead = {
      nombre:    nombre.slice(0, 120),
      empresa:   String(body.empresa   || '').trim().slice(0, 120),
      email,
      telefono:  telefono.slice(0, 40),
      pais:      paisName.slice(0, 80),
      pais_iso:  paisIso.slice(0, 4),
      industria: String(body.industria || '').trim().slice(0, 120),
      mensaje:   String(body.mensaje   || '').trim().slice(0, 2000),
      tipo:      VALID_TIPOS.has(tipoRaw) ? tipoRaw : 'demo',
    };

    let id;
    try {
      id = await insertLead(pool, lead, { schema });
    } catch (err) {
      console.error('[db] insert error', err);
      return res.status(500).json({ error: 'Error al guardar en base de datos' });
    }

    let mailResult;
    try {
      mailResult = await mailer.sendLead(lead, id);
    } catch (err) {
      mailResult = {
        status: 'failed',
        reason: err?.message || String(err),
        sentTo: [],
        messageIds: [],
        results: {},
      };
    }

    // Loggea cada uno de los dos envíos (ventas + usuario) por separado para
    // que las trazas reflejen el resultado individual de cada destinatario.
    const logOne = (label, result) => {
      if (!result) return;
      const target  = result.to || (label === 'sales' ? (mailer?.to ?? '') : lead.email);
      const logBase = `[mail] lead=${id} ${label}→${target}`;
      if (result.status === 'sent') {
        const detail = result.messageId
          ? `messageId=${result.messageId}`
          : `code=${result.statusCode ?? '?'}`;
        console.log(`${logBase} status=sent ${detail}`);
      } else if (result.status === 'skipped') {
        console.warn(`${logBase} status=skipped reason="${result.reason ?? 'unknown'}"`);
      } else {
        console.error(`${logBase} status=failed code=${result.statusCode ?? '?'} reason="${result.reason ?? 'unknown'}"`);
        if (result.body) console.error('[mail] provider body:', typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
      }
    };

    if (mailResult?.status === 'skipped' && !mailResult.results) {
      // Mailer global deshabilitado (sin SMTP_HOST). Un solo log informativo.
      console.warn(`[mail] lead=${id} status=skipped reason="${mailResult.reason ?? 'unknown'}"`);
    } else {
      logOne('sales', mailResult?.results?.sales);
      logOne('user',  mailResult?.results?.user);
    }

    // Respuesta al cliente: no exponer estado interno del envío.
    res.status(201).json({ ok: true, id: Number(id) });
  }));

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // Middleware de errores: siempre el último `app.use`, después del 404, para
  // que cualquier excepción no capturada en el pipeline (parseo de body,
  // routers, o estas rutas) responda JSON en vez del HTML por defecto de
  // Express. Ver definición arriba de `createApp`.
  app.use(errorHandler);

  app._pool   = pool;
  app._schema = schema;
  return app;
}

export { createPool, ensureSchema };
