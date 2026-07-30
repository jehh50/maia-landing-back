import { Router } from 'express';
import multer from 'multer';
import {
  SECCIONES, ALLOWED_MIME_TYPES,
  isValidSeccion, isAllowedMime, extensionMatchesMime, sniffMime,
  createImage, listImages, getImageWithBytes, updateImage, deleteImage,
} from './images.js';
import { requireRole } from './roles.js';
import { asyncHandler } from './asyncHandler.js';

// Nombre del campo de archivo en el multipart/form-data.
const FILE_FIELD = 'file';

// Límite de tamaño por archivo. Activo sin configurar nada (mismo criterio que
// `src/rateLimit.js`: defaults sensatos + inyección por factory + override por
// env). 5 MB es holgado para un hero/CTA optimizado y a la vez acota lo que
// entra en la fila BYTEA. Configurable con `IMAGES_MAX_FILE_SIZE_BYTES` o con
// la opción `maxFileSize` de la factory.
const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

const FILENAME_MAX = 255;
const ALT_MAX = 300;

// Código propio para distinguir "el MIME no está en la whitelist" (→ 415) del
// resto de errores de multer (→ 413 / 422). No es un `MulterError`.
const UNSUPPORTED_MIME_CODE = 'IMAGES_UNSUPPORTED_MIME';

function positiveNumberFromEnv(name) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Máximo de un `bigint` de Postgres (2^63 - 1). Un id por encima de esto no es
// "no encontrado" para Postgres: es un error de conversión (22003
// numeric_value_out_of_range), que sin este guard acabaría en un 500.
const PG_BIGINT_MAX = 9223372036854775807n;

/**
 * Los ids son BIGSERIAL: aceptamos solo dígitos **y solo dentro del rango de un
 * `bigint`**. Cualquier otra cosa devuelve `null` y el router responde 404, así
 * que ni `/api/images/abc/raw` (error 22P02 invalid_text_representation) ni
 * `/api/images/99999999999999999999999/raw` (error 22003
 * numeric_value_out_of_range) llegan a Postgres para acabar en un 500.
 * Es lo que promete `docs/api-contract.md`: 404, nunca 500.
 */
function parseId(raw) {
  const s = String(raw ?? '');
  if (!/^\d{1,19}$/.test(s)) return null;
  if (BigInt(s) > PG_BIGINT_MAX) return null;
  return s;
}

/** Entero >= 0, o `null` si el valor no es válido. */
function parseOrden(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * Neutraliza el `originalname` que manda el cliente: nos quedamos con el
 * basename (sin rutas) y sin caracteres de control, que es lo que podría
 * romper cabeceras o rutas si algún día se reutiliza el nombre.
 */
function sanitizeFilename(raw) {
  const base = String(raw || 'imagen')
    .replace(/\\/g, '/')
    .split('/')
    .pop();
  // eslint-disable-next-line no-control-regex
  // Fuera caracteres de control (incluidos CR/LF, que romperian una cabecera)
  // y comillas dobles.
  const clean = base.replace(/[\x00-\x1f\x7f"]/g, '').trim();
  return (clean || 'imagen').slice(0, FILENAME_MAX);
}

/**
 * Factory del router de imágenes (feature 7).
 *
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool
 * @param {string} [opts.schema='public']
 * @param {import('express').RequestHandler} opts.requireAuth
 * @param {number} [opts.maxFileSize] - sobreescribe `IMAGES_MAX_FILE_SIZE_BYTES`
 *   y el default (5 MB). En bytes.
 */
export function createImagesRouter({ pool, schema = 'public', requireAuth, maxFileSize } = {}) {
  if (!pool) throw new Error('createImagesRouter requiere `pool`');
  if (!requireAuth) throw new Error('createImagesRouter requiere `requireAuth`');

  const fileSize = maxFileSize ?? positiveNumberFromEnv('IMAGES_MAX_FILE_SIZE_BYTES') ?? DEFAULT_MAX_FILE_SIZE_BYTES;

  // `memoryStorage`: el binario nunca toca el disco (el filesystem de Render es
  // efímero y escribir un temporal no aporta nada si el destino es la BD).
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize, files: 1, fields: 10 },
    fileFilter(_req, file, cb) {
      // Primera barrera: lo que **declara** el cliente. Es falsificable, así
      // que el handler vuelve a comprobar los magic bytes del buffer real
      // (`sniffMime`) antes de persistir.
      if (!isAllowedMime(file.mimetype) || !extensionMatchesMime(file.originalname, file.mimetype)) {
        const err = new Error('Tipo de archivo no permitido');
        err.code = UNSUPPORTED_MIME_CODE;
        return cb(err);
      }
      return cb(null, true);
    },
  });

  const mimeErrorMessage = `Tipo de archivo no permitido. Formatos aceptados: ${ALLOWED_MIME_TYPES.join(', ')}`;

  /**
   * Envuelve `upload.single()` para traducir los errores de multer a JSON con
   * el código correcto. Sin esto, multer los reenvía a `next(err)` y acabarían
   * como un 500 genérico en `errorHandler` — o peor, colgando la request.
   *
   * No es `async` a propósito (y por tanto no necesita `asyncHandler`, ver
   * docs/conventions.md §7): multer es de estilo callback y ya entrega sus
   * fallos por el callback, no como promesa rechazada.
   */
  function uploadSingleImage(req, res, next) {
    upload.single(FILE_FIELD)(req, res, (err) => {
      if (!err) return next();
      if (err.code === UNSUPPORTED_MIME_CODE) {
        return res.status(415).json({ error: mimeErrorMessage, field: FILE_FIELD });
      }
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            error: `El archivo excede el tamaño máximo permitido (${fileSize} bytes)`,
            field: FILE_FIELD,
          });
        }
        // LIMIT_UNEXPECTED_FILE, LIMIT_FILE_COUNT, LIMIT_FIELD_COUNT…: entrada
        // mal formada, no un fallo del servidor.
        console.error('[images] upload error', err.code);
        return res.status(422).json({ error: 'Archivo inválido', field: FILE_FIELD });
      }
      // Cualquier otra cosa sí es inesperada: al middleware de errores.
      return next(err);
    });
  }

  const router = Router();
  const adminGuard = [requireAuth, requireRole('admin')];

  // --- Públicos ---

  router.get('/api/images', asyncHandler(async (req, res) => {
    const seccionRaw = req.query.seccion;
    const seccion = seccionRaw === undefined ? undefined : String(seccionRaw).trim();
    if (seccion !== undefined && seccion !== '' && !isValidSeccion(seccion)) {
      return res.status(422).json({ error: `seccion inválida. Valores válidos: ${SECCIONES.join(', ')}`, field: 'seccion' });
    }
    try {
      const rows = await listImages(pool, schema, { seccion: seccion || undefined });
      res.json({ rows });
    } catch (err) {
      console.error('[images] list error', err);
      res.status(500).json({ error: 'Error al listar imágenes' });
    }
  }));

  router.get('/api/images/:id/raw', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Imagen no encontrada' });
    try {
      const img = await getImageWithBytes(pool, schema, id);
      if (!img || !img.bytes) return res.status(404).json({ error: 'Imagen no encontrada' });
      res.set('Content-Type', img.mime_type);
      res.set('Content-Length', String(img.bytes.length));
      // El binario lo subió un admin y el MIME está en whitelist, pero servir
      // contenido subido desde el origen de la API merece cinturón: `nosniff`
      // impide que el navegador reinterprete el cuerpo como HTML/JS.
      res.set('X-Content-Type-Options', 'nosniff');
      res.status(200).end(img.bytes);
    } catch (err) {
      console.error('[images] raw error', err);
      res.status(500).json({ error: 'Error al cargar imagen' });
    }
  }));

  // --- Admin (solo rol admin) ---

  router.post('/api/admin/images', ...adminGuard, uploadSingleImage, asyncHandler(async (req, res) => {
    const body = req.body || {};

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(422).json({ error: 'Archivo requerido', field: FILE_FIELD });
    }

    const seccion = String(body.seccion || '').trim();
    if (!seccion) {
      return res.status(422).json({ error: 'seccion requerida', field: 'seccion' });
    }
    if (!isValidSeccion(seccion)) {
      return res.status(422).json({ error: `seccion inválida. Valores válidos: ${SECCIONES.join(', ')}`, field: 'seccion' });
    }

    // Segunda barrera de MIME: los magic bytes del buffer real. El `mimetype`
    // que trae multer es el que declaró el cliente y se puede falsificar; esto
    // rechaza un archivo cuyo contenido no es la imagen que dice ser.
    const sniffed = sniffMime(req.file.buffer);
    if (!sniffed || sniffed !== req.file.mimetype) {
      return res.status(415).json({ error: mimeErrorMessage, field: FILE_FIELD });
    }

    let orden = 0;
    if (body.orden !== undefined && String(body.orden).trim() !== '') {
      orden = parseOrden(body.orden);
      if (orden === null) {
        return res.status(422).json({ error: 'orden debe ser un entero >= 0', field: 'orden' });
      }
    }

    const alt = body.alt !== undefined ? String(body.alt).trim().slice(0, ALT_MAX) : null;

    try {
      const image = await createImage(pool, schema, {
        seccion,
        filename:   sanitizeFilename(req.file.originalname),
        mime_type:  sniffed,
        bytes:      req.file.buffer,
        size_bytes: req.file.buffer.length,
        alt,
        orden,
      });
      res.status(201).json({ image });
    } catch (err) {
      console.error('[images] create error', err);
      res.status(500).json({ error: 'Error al crear imagen' });
    }
  }));

  router.patch('/api/admin/images/:id', ...adminGuard, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Imagen no encontrada' });

    const body = req.body || {};
    const patch = {};

    if (body.alt !== undefined) {
      patch.alt = body.alt === null ? null : String(body.alt).trim().slice(0, ALT_MAX);
    }
    if (body.orden !== undefined) {
      const orden = parseOrden(body.orden);
      if (orden === null) {
        return res.status(422).json({ error: 'orden debe ser un entero >= 0', field: 'orden' });
      }
      patch.orden = orden;
    }
    if (body.seccion !== undefined) {
      const seccion = String(body.seccion).trim();
      if (!isValidSeccion(seccion)) {
        return res.status(422).json({ error: `seccion inválida. Valores válidos: ${SECCIONES.join(', ')}`, field: 'seccion' });
      }
      patch.seccion = seccion;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(422).json({ error: 'Nada que actualizar: se esperaba alt, orden o seccion' });
    }

    try {
      const image = await updateImage(pool, schema, id, patch);
      if (!image) return res.status(404).json({ error: 'Imagen no encontrada' });
      res.json({ image });
    } catch (err) {
      console.error('[images] update error', err);
      res.status(500).json({ error: 'Error al actualizar imagen' });
    }
  }));

  router.delete('/api/admin/images/:id', ...adminGuard, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Imagen no encontrada' });
    try {
      const ok = await deleteImage(pool, schema, id);
      if (!ok) return res.status(404).json({ error: 'Imagen no encontrada' });
      res.status(204).end();
    } catch (err) {
      console.error('[images] delete error', err);
      res.status(500).json({ error: 'Error al borrar imagen' });
    }
  }));

  return router;
}
