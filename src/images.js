// Capa de datos para la tabla `images` (feature 7). Solo SQL puro y helpers
// puros; el router HTTP vive en imagesRouter.js. Este módulo no importa
// express ni toca `req`/`res` (CHECKPOINT.md C7).
//
// El binario se guarda en la columna `bytes` (BYTEA) — decisión del humano en
// `feature_list.json` (feature 7): el filesystem de Render es efímero y un
// proveedor externo exigiría credenciales nuevas.

/**
 * Secciones de la landing que hoy tienen imágenes editables.
 * `hero` → carrusel de 3 imágenes; `cta_final` → la imagen de MaIA del CTA
 * final (ver `contexto_front` de la feature 7). Añadir una sección nueva es
 * añadir un valor aquí, no un cambio de esquema.
 */
export const SECCIONES = Object.freeze(['hero', 'cta_final']);

/**
 * Whitelist de MIME types aceptados, con las extensiones válidas de cada uno.
 *
 * **SVG queda excluido a propósito**: un SVG es XML ejecutable (puede llevar
 * `<script>`, `onload`, `xlink:href` a `javascript:`) y `GET /api/images/:id/raw`
 * lo serviría en crudo con su propio Content-Type desde el origen de la API →
 * XSS almacenado. Ver docs/architecture.md §7.1.
 */
export const MIME_WHITELIST = Object.freeze({
  'image/png':  Object.freeze(['.png']),
  'image/jpeg': Object.freeze(['.jpg', '.jpeg']),
  'image/webp': Object.freeze(['.webp']),
});

export const ALLOWED_MIME_TYPES = Object.freeze(Object.keys(MIME_WHITELIST));

// Columnas que salen por la API. `bytes` NO está aquí a propósito: es el
// análogo de la invariante I3 (`password_hash` nunca sale por la API) para el
// binario. Ninguna query de listado/detalle debe seleccionarla.
const META_COLS = 'id, seccion, filename, mime_type, size_bytes, alt, orden, created_at, updated_at';

// Únicas columnas que lee el endpoint `/raw`: el binario más lo mínimo para
// construir las cabeceras de la respuesta.
const RAW_COLS = 'id, filename, mime_type, bytes, size_bytes';

export function isValidSeccion(seccion) {
  return SECCIONES.includes(seccion);
}

export function isAllowedMime(mimeType) {
  return Object.prototype.hasOwnProperty.call(MIME_WHITELIST, mimeType);
}

/** Extensión en minúsculas (con punto) de un nombre de archivo, o '' si no tiene. */
export function extensionOf(filename) {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot).toLowerCase();
}

/** `true` si la extensión del archivo corresponde al MIME declarado. */
export function extensionMatchesMime(filename, mimeType) {
  const allowed = MIME_WHITELIST[mimeType];
  if (!allowed) return false;
  return allowed.includes(extensionOf(filename));
}

/**
 * Detecta el MIME real leyendo los magic bytes de la cabecera del buffer, sin
 * dependencias nuevas. Devuelve `null` si no reconoce ninguno de los formatos
 * de la whitelist (nunca lanza).
 *
 * Existe porque el `mimetype` que entrega multer es el que declara el cliente
 * en el `Content-Type` de la parte multipart, y **es falsificable**: cualquiera
 * puede subir un `.html` diciendo `image/png`.
 */
export function sniffMime(buffer) {
  if (!buffer || typeof buffer.length !== 'number') return null;
  const b = buffer;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b.length >= 8
    && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'image/jpeg';
  }
  // WebP: "RIFF" ....(4 bytes de tamaño).... "WEBP"
  if (b.length >= 12
    && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

export async function createImage(pool, schema, payload) {
  const { rows } = await pool.query(
    `INSERT INTO "${schema}".images (seccion, filename, mime_type, bytes, size_bytes, alt, orden)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${META_COLS}`,
    [
      payload.seccion,
      payload.filename,
      payload.mime_type,
      payload.bytes,
      payload.size_bytes ?? (payload.bytes ? payload.bytes.length : 0),
      payload.alt ?? null,
      payload.orden ?? 0,
    ],
  );
  return rows[0];
}

/** Metadatos de una imagen (sin `bytes`). `null` si no existe. */
export async function getImageById(pool, schema, id) {
  const { rows } = await pool.query(
    `SELECT ${META_COLS} FROM "${schema}".images WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Única función que lee la columna `bytes`. La usa exclusivamente
 * `GET /api/images/:id/raw`. `null` si no existe.
 */
export async function getImageWithBytes(pool, schema, id) {
  const { rows } = await pool.query(
    `SELECT ${RAW_COLS} FROM "${schema}".images WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Lista de metadatos ordenada por `orden` ascendente (`id` como desempate
 * estable). Filtro opcional por `seccion`.
 */
export async function listImages(pool, schema, { seccion } = {}) {
  const params = [];
  let where = '';
  if (seccion) {
    params.push(seccion);
    where = `WHERE seccion = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT ${META_COLS}
       FROM "${schema}".images
       ${where}
      ORDER BY orden ASC, id ASC`,
    params,
  );
  return rows;
}

/**
 * Actualiza solo los campos editables (`alt`, `orden`, `seccion`). Nunca toca
 * `bytes`, `mime_type`, `filename` ni `size_bytes`: cambiar el binario es un
 * POST nuevo, no un PATCH.
 *
 * `patch` debe traer ya validados los campos presentes. Devuelve los metadatos
 * actualizados, o `null` si la imagen no existe.
 */
export async function updateImage(pool, schema, id, patch) {
  const current = await getImageById(pool, schema, id);
  if (!current) return null;

  const next = {
    alt:     patch.alt     !== undefined ? patch.alt     : current.alt,
    orden:   patch.orden   !== undefined ? patch.orden   : current.orden,
    seccion: patch.seccion !== undefined ? patch.seccion : current.seccion,
  };

  const { rows } = await pool.query(
    `UPDATE "${schema}".images
        SET alt = $1, orden = $2, seccion = $3, updated_at = NOW()
      WHERE id = $4
      RETURNING ${META_COLS}`,
    [next.alt, next.orden, next.seccion, id],
  );
  return rows[0] || null;
}

export async function deleteImage(pool, schema, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM "${schema}".images WHERE id = $1`,
    [id],
  );
  return rowCount > 0;
}
