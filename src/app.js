import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createPool, ensureSchema, insertLead } from './db.js';
import { createMailer } from './email.js';
import { detectCountry } from './phone.js';
import { createAuthRouter } from './auth.js';
import { createArticlesRouter } from './articlesRouter.js';
import { createLeadsRouter } from './leadsRouter.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Acepta formato E.164 (`+` + 7–15 dígitos) tolerante a espacios, paréntesis y guiones.
const PHONE_RE = /^\+\d{7,15}$/;
const VALID_TIPOS = new Set(['demo', 'email', 'contacto']);

function normalizePhone(raw) {
  return String(raw || '').replace(/[\s\-()]/g, '').trim();
}

export function createApp(options = {}) {
  const corsOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN ?? '*';
  const schema     = options.schema     ?? process.env.DB_SCHEMA   ?? 'public';

  const pool = options.pool ?? createPool();

  const mailer = options.mailer ?? createMailer();

  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use(cookieParser());
  app.use(cors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(','),
    credentials: true,
  }));

  // --- Auth (feature 14) ---
  const auth = options.auth ?? createAuthRouter({ pool, schema, secret: options.authSecret });
  app.use(auth.router);
  app._auth = auth;

  // --- Admin: articles (feature 13) y leads (feature 16) ---
  app.use(createArticlesRouter({ pool, schema, requireAuth: auth.requireAuth }));
  app.use(createLeadsRouter   ({ pool, schema, requireAuth: auth.requireAuth }));

  app.get('/api/health', async (_req, res) => {
    try {
      const { rows } = await pool.query('SELECT 1 AS ok');
      res.json({ ok: true, db: rows[0].ok === 1, mailer: mailer.enabled });
    } catch (err) {
      console.error('Health DB error', err);
      res.status(503).json({ ok: false, db: false, mailer: mailer.enabled });
    }
  });

  app.post('/api/contact', async (req, res) => {
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
  });

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  app._pool   = pool;
  app._schema = schema;
  return app;
}

export { createPool, ensureSchema };
