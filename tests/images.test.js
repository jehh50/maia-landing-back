import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createPool, ensureSchema } from '../src/db.js';
import { createUser } from '../src/users.js';
import { AUTH_COOKIE_NAME } from '../src/auth.js';
import {
  SECCIONES, ALLOWED_MIME_TYPES,
  sniffMime, extensionOf, extensionMatchesMime, isAllowedMime, isValidSeccion,
} from '../src/images.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres:///maia-landing?host=/var/run/postgresql';

const schema = `maia_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const fakeMailer = { enabled: false, to: 'sales@test', async sendLead() { return { status: 'skipped' }; } };

// --- Fixtures binarios ---
// PNG 1x1 real (67 bytes). Los de JPEG/WebP se construyen con su cabecera
// auténtica: el servidor solo inspecciona los magic bytes (`sniffMime`), no
// decodifica la imagen, así que una cabecera válida + relleno es una entrada
// legítima para lo que el endpoint comprueba.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+4d2ZvwAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG_MIN = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),   // SOI + APP0
  Buffer.alloc(16, 0x20),
  Buffer.from([0xff, 0xd9]),               // EOI
]);
const WEBP_MIN = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x20, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from('VP8 ', 'ascii'),
  Buffer.alloc(16, 0x00),
]);
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');

const SMALL_LIMIT_BYTES = 128;

let app, appSmallLimit, pool, adminCookie, editorCookie;

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.find(c => c.startsWith(`${AUTH_COOKIE_NAME}=`));
}

/** Sube una imagen como admin. Devuelve la respuesta de supertest. */
function upload(target, { seccion, alt, orden, buffer = PNG_1X1, filename = 'hero.png', contentType = 'image/png', cookie } = {}) {
  const req = request(target).post('/api/admin/images');
  if (cookie !== null) req.set('Cookie', cookie ?? adminCookie);
  if (seccion !== undefined) req.field('seccion', String(seccion));
  if (alt !== undefined) req.field('alt', String(alt));
  if (orden !== undefined) req.field('orden', String(orden));
  if (buffer !== null) req.attach('file', buffer, { filename, contentType });
  return req;
}

beforeAll(async () => {
  pool = createPool({ connectionString: TEST_DB_URL });
  await ensureSchema(pool, { schema });

  await createUser(pool, { email: 'admin@test',  password: 'pass-1', name: 'Admin'  }, { schema });
  await createUser(pool, { email: 'editor@test', password: 'pass-1', name: 'Editor' }, { schema });
  await pool.query(`UPDATE "${schema}".users SET role = 'admin' WHERE email = 'admin@test'`);

  app = createApp({ pool, schema, mailer: fakeMailer, corsOrigin: '*', authSecret: 'test-secret-images' });
  // Segunda app sobre el MISMO schema, solo para ejercitar el límite de tamaño
  // inyectado por la factory (verifica que es configurable sin env).
  appSmallLimit = createApp({
    pool, schema, mailer: fakeMailer, corsOrigin: '*', authSecret: 'test-secret-images',
    images: { maxFileSize: SMALL_LIMIT_BYTES },
  });

  adminCookie  = await loginAs('admin@test',  'pass-1');
  editorCookie = await loginAs('editor@test', 'pass-1');
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// Criterio 1 — tabla `images` en ensureSchema(), idempotente
// ---------------------------------------------------------------------------
describe('Criterio 1 — esquema `images` (ensureSchema)', () => {
  it('crea la tabla images con todas las columnas esperadas y bytes en BYTEA', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'images'`,
      [schema],
    );
    const byName = Object.fromEntries(rows.map(r => [r.column_name, r]));
    for (const col of ['id', 'seccion', 'filename', 'mime_type', 'bytes', 'size_bytes', 'alt', 'orden', 'created_at', 'updated_at']) {
      expect(byName[col], `falta la columna ${col}`).toBeTruthy();
    }
    expect(byName.bytes.data_type).toBe('bytea');
    expect(byName.alt.is_nullable).toBe('YES');
    expect(byName.created_at.data_type).toBe('timestamp with time zone');
  });

  it('es idempotente: correr ensureSchema de nuevo no falla ni borra datos existentes', async () => {
    const res = await upload(app, { seccion: 'hero', alt: 'sobrevive', orden: 99 });
    expect(res.status).toBe(201);
    const id = res.body.image.id;

    await ensureSchema(pool, { schema });   // segundo arranque simulado

    const { rows } = await pool.query(`SELECT alt FROM "${schema}".images WHERE id = $1`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].alt).toBe('sobrevive');

    await pool.query(`DELETE FROM "${schema}".images WHERE id = $1`, [id]);
  });
});

// ---------------------------------------------------------------------------
// Criterio 2 — prefijo de rutas (/api público, /api/admin escritura)
// ---------------------------------------------------------------------------
describe('Criterio 2 — prefijo de rutas', () => {
  it('la escritura vive en /api/admin/images: POST /api/images no existe (404)', async () => {
    const res = await request(app).post('/api/images').set('Cookie', adminCookie)
      .field('seccion', 'hero').attach('file', PNG_1X1, { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('los 5 endpoints están montados en las rutas convenidas', async () => {
    const created = await upload(app, { seccion: 'hero', alt: 'rutas' });
    expect(created.status).toBe(201);                                     // POST /api/admin/images
    const id = created.body.image.id;

    expect((await request(app).get('/api/images')).status).toBe(200);     // GET /api/images
    expect((await request(app).get(`/api/images/${id}/raw`)).status).toBe(200); // GET /api/images/:id/raw
    const patched = await request(app).patch(`/api/admin/images/${id}`)
      .set('Cookie', adminCookie).send({ alt: 'rutas v2' });
    expect(patched.status).toBe(200);                                     // PATCH /api/admin/images/:id
    expect((await request(app).delete(`/api/admin/images/${id}`).set('Cookie', adminCookie)).status).toBe(204); // DELETE
  });
});

// ---------------------------------------------------------------------------
// Criterio 3 — POST 201 con metadatos, sin `bytes`
// ---------------------------------------------------------------------------
describe('Criterio 3 — POST /api/admin/images', () => {
  it('201 con los metadatos de la imagen creada y SIN el campo bytes', async () => {
    const res = await upload(app, { seccion: 'cta_final', alt: 'MaIA', orden: 1, filename: 'maia.png' });
    expect(res.status).toBe(201);
    const img = res.body.image;
    expect(img.seccion).toBe('cta_final');
    expect(img.filename).toBe('maia.png');
    expect(img.mime_type).toBe('image/png');
    expect(img.size_bytes).toBe(PNG_1X1.length);
    expect(img.alt).toBe('MaIA');
    expect(img.orden).toBe(1);
    expect(img.created_at).toBeTruthy();
    expect(img.updated_at).toBeTruthy();
    expect(Object.keys(img)).not.toContain('bytes');

    await request(app).delete(`/api/admin/images/${img.id}`).set('Cookie', adminCookie);
  });

  it('persiste el binario íntegro (el /raw devuelve exactamente los bytes subidos)', async () => {
    const res = await upload(app, { seccion: 'hero', buffer: JPEG_MIN, filename: 'foto.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    const raw = await request(app).get(`/api/images/${res.body.image.id}/raw`).responseType('blob');
    expect(Buffer.compare(raw.body, JPEG_MIN)).toBe(0);
    await request(app).delete(`/api/admin/images/${res.body.image.id}`).set('Cookie', adminCookie);
  });
});

// ---------------------------------------------------------------------------
// Criterio 4 — códigos de error de la subida (422 / 415 / 413), siempre JSON
// ---------------------------------------------------------------------------
describe('Criterio 4 — errores de la subida', () => {
  it('422 { error, field } si no viene archivo', async () => {
    const res = await upload(app, { seccion: 'hero', buffer: null });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('file');
    expect(res.body.error).toBeTruthy();
  });

  it('422 { error, field } si falta seccion', async () => {
    const res = await upload(app, {});
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('seccion');
  });

  it('422 { error, field } si seccion no es un valor válido', async () => {
    const res = await upload(app, { seccion: 'footer-inexistente' });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('seccion');
  });

  it('422 si orden no es un entero >= 0', async () => {
    const res = await upload(app, { seccion: 'hero', orden: '-3' });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('orden');
  });

  it('415 { error, field: "file" } si el MIME no está en la whitelist', async () => {
    const res = await upload(app, { seccion: 'hero', buffer: Buffer.from('texto'), filename: 'nota.txt', contentType: 'text/plain' });
    expect(res.status).toBe(415);
    expect(res.body.field).toBe('file');
  });

  it('413 { error, field: "file" } si el archivo excede el límite de tamaño (JSON, no crash ni 500)', async () => {
    const big = Buffer.concat([PNG_1X1, Buffer.alloc(SMALL_LIMIT_BYTES * 8, 0)]);
    const res = await upload(appSmallLimit, { seccion: 'hero', buffer: big, filename: 'grande.png' });
    expect(res.status).toBe(413);
    expect(res.body.field).toBe('file');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('el mismo archivo pasa con el límite por defecto (el límite es configurable por la factory)', async () => {
    const big = Buffer.concat([PNG_1X1, Buffer.alloc(SMALL_LIMIT_BYTES * 8, 0)]);
    const res = await upload(app, { seccion: 'hero', buffer: big, filename: 'grande.png' });
    expect(res.status).toBe(201);
    await request(app).delete(`/api/admin/images/${res.body.image.id}`).set('Cookie', adminCookie);
  });

  it('todos los errores de subida responden JSON, nunca el HTML por defecto de Express', async () => {
    for (const res of [
      await upload(app, { seccion: 'hero', buffer: null }),
      await upload(app, {}),
      await upload(app, { seccion: 'hero', buffer: SVG_BYTES, filename: 'x.svg', contentType: 'image/svg+xml' }),
    ]) {
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(typeof res.body.error).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Criterio 5 — whitelist de MIME; SVG excluido a propósito
// ---------------------------------------------------------------------------
describe('Criterio 5 — whitelist de MIME', () => {
  it('la whitelist es exactamente image/png, image/jpeg e image/webp', () => {
    expect([...ALLOWED_MIME_TYPES].sort()).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(isAllowedMime('image/svg+xml')).toBe(false);
  });

  it('acepta los tres formatos de la whitelist', async () => {
    const casos = [
      { buffer: PNG_1X1,  filename: 'a.png',  contentType: 'image/png',  mime: 'image/png' },
      { buffer: JPEG_MIN, filename: 'b.jpeg', contentType: 'image/jpeg', mime: 'image/jpeg' },
      { buffer: WEBP_MIN, filename: 'c.webp', contentType: 'image/webp', mime: 'image/webp' },
    ];
    for (const caso of casos) {
      const res = await upload(app, { seccion: 'hero', ...caso });
      expect(res.status, `${caso.filename} debería aceptarse`).toBe(201);
      expect(res.body.image.mime_type).toBe(caso.mime);
      await request(app).delete(`/api/admin/images/${res.body.image.id}`).set('Cookie', adminCookie);
    }
  });

  it('415 al subir un SVG: está excluido a propósito (XSS al servirlo en crudo)', async () => {
    const res = await upload(app, { seccion: 'hero', buffer: SVG_BYTES, filename: 'logo.svg', contentType: 'image/svg+xml' });
    expect(res.status).toBe(415);
    expect(res.body.field).toBe('file');
  });

  it('el motivo de excluir SVG está escrito en docs/architecture.md', () => {
    const doc = readFileSync(new URL('../docs/architecture.md', import.meta.url), 'utf8');
    const parrafo = doc.split('\n').filter(l => /svg/i.test(l)).join('\n');
    expect(parrafo).toMatch(/svg/i);
    expect(parrafo).toMatch(/xss/i);
  });

  it('415 si el cliente miente en el mimetype: se validan los magic bytes reales', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
    const res = await upload(app, { seccion: 'hero', buffer: html, filename: 'trampa.png', contentType: 'image/png' });
    expect(res.status).toBe(415);
    expect(res.body.field).toBe('file');
  });

  it('415 si la extensión no corresponde al MIME declarado', async () => {
    const res = await upload(app, { seccion: 'hero', buffer: PNG_1X1, filename: 'imagen.txt', contentType: 'image/png' });
    expect(res.status).toBe(415);
  });

  it('sniffMime reconoce png/jpeg/webp y devuelve null para lo demás (nunca lanza)', () => {
    expect(sniffMime(PNG_1X1)).toBe('image/png');
    expect(sniffMime(JPEG_MIN)).toBe('image/jpeg');
    expect(sniffMime(WEBP_MIN)).toBe('image/webp');
    expect(sniffMime(SVG_BYTES)).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
    expect(sniffMime(null)).toBeNull();
    expect(sniffMime(undefined)).toBeNull();
  });

  it('extensionOf / extensionMatchesMime / isValidSeccion son puros y coherentes', () => {
    expect(extensionOf('foto.JPG')).toBe('.jpg');
    expect(extensionOf('sin-extension')).toBe('');
    expect(extensionOf('.oculto')).toBe('');
    expect(extensionMatchesMime('a.jpeg', 'image/jpeg')).toBe(true);
    expect(extensionMatchesMime('a.jpg', 'image/jpeg')).toBe(true);
    expect(extensionMatchesMime('a.png', 'image/jpeg')).toBe(false);
    expect(extensionMatchesMime('a.svg', 'image/svg+xml')).toBe(false);
    expect(SECCIONES).toContain('hero');
    expect(SECCIONES).toContain('cta_final');
    expect(isValidSeccion('hero')).toBe(true);
    expect(isValidSeccion('no-existe')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Criterio 6 — GET /api/images público, filtro ?seccion=, orden ASC, sin bytes
// ---------------------------------------------------------------------------
describe('Criterio 6 — GET /api/images (público)', () => {
  const creados = [];

  beforeAll(async () => {
    const seeds = [
      { seccion: 'hero',      orden: 3, alt: 'hero-3', filename: 'hero-3.png' },
      { seccion: 'hero',      orden: 1, alt: 'hero-1', filename: 'hero-1.png' },
      { seccion: 'hero',      orden: 2, alt: 'hero-2', filename: 'hero-2.png' },
      { seccion: 'cta_final', orden: 0, alt: 'maia',   filename: 'maia.png'   },
    ];
    for (const seed of seeds) {
      const res = await upload(app, seed);
      if (res.status !== 201) throw new Error(`seed falló: ${res.status} ${JSON.stringify(res.body)}`);
      creados.push(res.body.image.id);
    }
  });

  afterAll(async () => {
    for (const id of creados) {
      await request(app).delete(`/api/admin/images/${id}`).set('Cookie', adminCookie);
    }
  });

  it('200 sin cookie: es público', async () => {
    const res = await request(app).get('/api/images');
    expect(res.status).toBe(200);
    expect(res.body.rows).toBeInstanceOf(Array);
    expect(res.body.rows.length).toBeGreaterThanOrEqual(4);
  });

  it('devuelve la lista ordenada por orden ascendente', async () => {
    const res = await request(app).get('/api/images?seccion=hero');
    expect(res.status).toBe(200);
    expect(res.body.rows.map(r => r.alt)).toEqual(['hero-1', 'hero-2', 'hero-3']);
    const ordenes = res.body.rows.map(r => r.orden);
    expect(ordenes).toEqual([...ordenes].sort((a, b) => a - b));
  });

  it('filtra por ?seccion=', async () => {
    const res = await request(app).get('/api/images?seccion=cta_final');
    expect(res.status).toBe(200);
    expect(res.body.rows.every(r => r.seccion === 'cta_final')).toBe(true);
    expect(res.body.rows.some(r => r.alt === 'maia')).toBe(true);
    expect(res.body.rows.some(r => r.seccion === 'hero')).toBe(false);
  });

  it('422 si ?seccion= no es una sección válida', async () => {
    const res = await request(app).get('/api/images?seccion=inventada');
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('seccion');
  });

  it('el campo bytes NUNCA sale en el JSON (análogo de la invariante I3)', async () => {
    const lista = await request(app).get('/api/images');
    expect(lista.body.rows.length).toBeGreaterThan(0);
    for (const row of lista.body.rows) {
      expect(Object.keys(row)).not.toContain('bytes');
      expect(row.bytes).toBeUndefined();
    }
    // Ni siquiera como clave literal en el texto crudo de la respuesta
    // (`size_bytes` sí, `"bytes"` no).
    expect(lista.text).not.toMatch(/"bytes"/);

    // Mismo chequeo en las otras respuestas JSON que devuelven una imagen.
    const creada = await upload(app, { seccion: 'hero', alt: 'sin-bytes' });
    expect(Object.keys(creada.body.image)).not.toContain('bytes');
    const patched = await request(app).patch(`/api/admin/images/${creada.body.image.id}`)
      .set('Cookie', adminCookie).send({ alt: 'sin-bytes v2' });
    expect(Object.keys(patched.body.image)).not.toContain('bytes');
    expect(patched.text).not.toMatch(/"bytes"/);
    await request(app).delete(`/api/admin/images/${creada.body.image.id}`).set('Cookie', adminCookie);
  });

  it('src/images.js solo lee la columna bytes en la query del endpoint /raw', () => {
    const src = readFileSync(new URL('../src/images.js', import.meta.url), 'utf8');
    // La lista de columnas "de metadatos" no menciona `bytes` como columna suelta.
    const metaCols = src.match(/const META_COLS = '([^']+)'/)[1];
    expect(metaCols.split(',').map(s => s.trim())).not.toContain('bytes');
    // Y la que sí la lee es la de /raw.
    const rawCols = src.match(/const RAW_COLS = '([^']+)'/)[1];
    expect(rawCols.split(',').map(s => s.trim())).toContain('bytes');
  });
});

// ---------------------------------------------------------------------------
// Criterio 7 — GET /api/images/:id/raw
// ---------------------------------------------------------------------------
describe('Criterio 7 — GET /api/images/:id/raw (público)', () => {
  it('sirve el binario con su Content-Type real, sin cookie', async () => {
    const created = await upload(app, { seccion: 'hero', buffer: WEBP_MIN, filename: 'w.webp', contentType: 'image/webp' });
    expect(created.status).toBe(201);
    const res = await request(app).get(`/api/images/${created.body.image.id}/raw`).responseType('blob');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/webp');
    expect(res.headers['content-length']).toBe(String(WEBP_MIN.length));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(res.body, WEBP_MIN)).toBe(0);
    await request(app).delete(`/api/admin/images/${created.body.image.id}`).set('Cookie', adminCookie);
  });

  it('404 si el id no existe', async () => {
    const res = await request(app).get('/api/images/99999999/raw');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });

  it('404 (no 500) si el id no es numérico', async () => {
    const res = await request(app).get('/api/images/no-soy-un-id/raw');
    expect(res.status).toBe(404);
  });

  // Hallazgo menor 1 del review (progress/review_7.md §9.1): un id de solo
  // dígitos pero fuera del rango de `bigint` provocaba el error 22003 de
  // Postgres y un 500, contradiciendo lo que promete docs/api-contract.md
  // ("404 … nunca un 500"). `parseId` ahora acota también el rango.
  it('404 (no 500) si el id desborda el rango de bigint, en las tres rutas con :id', async () => {
    const desbordado = '99999999999999999999999';
    const raw = await request(app).get(`/api/images/${desbordado}/raw`);
    expect(raw.status).toBe(404);
    expect(raw.body.error).toBeTruthy();

    const patch = await request(app).patch(`/api/admin/images/${desbordado}`)
      .set('Cookie', adminCookie).send({ alt: 'x' });
    expect(patch.status).toBe(404);

    const del = await request(app).delete(`/api/admin/images/${desbordado}`).set('Cookie', adminCookie);
    expect(del.status).toBe(404);
  });

  it('404 en el límite exacto de bigint y en el primer valor que lo excede', async () => {
    const maxBigint = '9223372036854775807';         // 2^63 - 1, válido para Postgres
    const primeroFuera = '9223372036854775808';      // 2^63, fuera de rango
    expect((await request(app).get(`/api/images/${maxBigint}/raw`)).status).toBe(404);
    expect((await request(app).get(`/api/images/${primeroFuera}/raw`)).status).toBe(404);
    // Y un id de 20+ dígitos (más allá de lo que la regex admite)
    expect((await request(app).get('/api/images/12345678901234567890/raw')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Criterio 8 — PATCH /api/admin/images/:id
// ---------------------------------------------------------------------------
describe('Criterio 8 — PATCH /api/admin/images/:id', () => {
  it('cambia alt, orden y seccion', async () => {
    const created = await upload(app, { seccion: 'hero', alt: 'antes', orden: 5 });
    const id = created.body.image.id;

    const res = await request(app).patch(`/api/admin/images/${id}`).set('Cookie', adminCookie)
      .send({ alt: 'después', orden: 7, seccion: 'cta_final' });
    expect(res.status).toBe(200);
    expect(res.body.image.alt).toBe('después');
    expect(res.body.image.orden).toBe(7);
    expect(res.body.image.seccion).toBe('cta_final');
    // No toca el binario ni sus metadatos
    expect(res.body.image.mime_type).toBe('image/png');
    expect(res.body.image.size_bytes).toBe(PNG_1X1.length);

    await request(app).delete(`/api/admin/images/${id}`).set('Cookie', adminCookie);
  });

  it('acepta un solo campo editable (no exige los tres)', async () => {
    const created = await upload(app, { seccion: 'hero', alt: 'solo-alt', orden: 4 });
    const id = created.body.image.id;
    const res = await request(app).patch(`/api/admin/images/${id}`).set('Cookie', adminCookie).send({ orden: 8 });
    expect(res.status).toBe(200);
    expect(res.body.image.orden).toBe(8);
    expect(res.body.image.alt).toBe('solo-alt');
    expect(res.body.image.seccion).toBe('hero');
    await request(app).delete(`/api/admin/images/${id}`).set('Cookie', adminCookie);
  });

  it('404 si no existe', async () => {
    const res = await request(app).patch('/api/admin/images/99999999').set('Cookie', adminCookie).send({ alt: 'x' });
    expect(res.status).toBe(404);
  });

  it('422 { error } si el body no trae ningún campo editable', async () => {
    const created = await upload(app, { seccion: 'hero', alt: 'nada' });
    const id = created.body.image.id;
    const res = await request(app).patch(`/api/admin/images/${id}`).set('Cookie', adminCookie)
      .send({ mime_type: 'image/gif', size_bytes: 1, filename: 'otro.png' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBeTruthy();
    await request(app).delete(`/api/admin/images/${id}`).set('Cookie', adminCookie);
  });

  it('422 si seccion no es válida', async () => {
    const created = await upload(app, { seccion: 'hero' });
    const id = created.body.image.id;
    const res = await request(app).patch(`/api/admin/images/${id}`).set('Cookie', adminCookie).send({ seccion: 'nope' });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('seccion');
    await request(app).delete(`/api/admin/images/${id}`).set('Cookie', adminCookie);
  });
});

// ---------------------------------------------------------------------------
// Criterio 9 — DELETE /api/admin/images/:id
// ---------------------------------------------------------------------------
describe('Criterio 9 — DELETE /api/admin/images/:id', () => {
  it('204 sin body y la fila desaparece de la BD', async () => {
    const created = await upload(app, { seccion: 'hero', alt: 'a borrar' });
    const id = created.body.image.id;

    const res = await request(app).delete(`/api/admin/images/${id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(204);
    expect(res.text).toBeFalsy();

    const { rows } = await pool.query(`SELECT id FROM "${schema}".images WHERE id = $1`, [id]);
    expect(rows).toHaveLength(0);
    expect((await request(app).get(`/api/images/${id}/raw`)).status).toBe(404);
  });

  it('404 si no existe', async () => {
    const res = await request(app).delete('/api/admin/images/99999999').set('Cookie', adminCookie);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Criterio 10 — autorización: escritura solo admin, GET públicos
// ---------------------------------------------------------------------------
describe('Criterio 10 — autorización', () => {
  let id;

  beforeAll(async () => {
    const created = await upload(app, { seccion: 'hero', alt: 'authz' });
    id = created.body.image.id;
  });

  afterAll(async () => {
    await request(app).delete(`/api/admin/images/${id}`).set('Cookie', adminCookie);
  });

  it('401 sin cookie de sesión en POST, PATCH y DELETE', async () => {
    const post = await upload(app, { seccion: 'hero', cookie: null });
    expect(post.status).toBe(401);
    const patch = await request(app).patch(`/api/admin/images/${id}`).send({ alt: 'x' });
    expect(patch.status).toBe(401);
    const del = await request(app).delete(`/api/admin/images/${id}`);
    expect(del.status).toBe(401);
  });

  it('403 con rol editor en POST, PATCH y DELETE (solo admin escribe)', async () => {
    const post = await upload(app, { seccion: 'hero', cookie: editorCookie });
    expect(post.status).toBe(403);
    const patch = await request(app).patch(`/api/admin/images/${id}`).set('Cookie', editorCookie).send({ alt: 'x' });
    expect(patch.status).toBe(403);
    const del = await request(app).delete(`/api/admin/images/${id}`).set('Cookie', editorCookie);
    expect(del.status).toBe(403);
  });

  it('los dos GET siguen siendo públicos (sin cookie)', async () => {
    expect((await request(app).get('/api/images')).status).toBe(200);
    expect((await request(app).get(`/api/images/${id}/raw`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Criterio 11 — separación de capas (C7)
// ---------------------------------------------------------------------------
describe('Criterio 11 — separación de capas (C7)', () => {
  const routerSrc = readFileSync(new URL('../src/imagesRouter.js', import.meta.url), 'utf8');
  const dataSrc   = readFileSync(new URL('../src/images.js', import.meta.url), 'utf8');

  it('src/imagesRouter.js no escribe SQL', () => {
    const sinComentarios = routerSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(sinComentarios).not.toMatch(/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/);
    expect(sinComentarios).not.toMatch(/pool\.query/);
  });

  it('src/images.js no importa express ni toca req/res', () => {
    expect(dataSrc).not.toMatch(/from ['"]express['"]/);
    expect(dataSrc).not.toMatch(/\breq\./);
    expect(dataSrc).not.toMatch(/\bres\.(status|json|send|set)\b/);
  });

  it('src/images.js parametriza todo valor de usuario e interpola solo `schema` (C4)', () => {
    const queries = dataSrc.match(/`[^`]*(SELECT|INSERT|UPDATE|DELETE)[^`]*`/g) || [];
    expect(queries.length).toBeGreaterThan(0);
    // Interpolaciones permitidas: `schema` (siempre entre comillas dobles, viene
    // de env o del test, nunca de una request), las constantes de columnas del
    // módulo, y `where` (fragmento armado en el propio módulo, verificado abajo).
    const PERMITIDAS = /^\$\{(schema|META_COLS|RAW_COLS|where)\}$/;
    for (const q of queries) {
      for (const i of q.match(/\$\{[^}]+\}/g) || []) {
        expect(i, `interpolación no permitida en: ${q}`).toMatch(PERMITIDAS);
      }
      expect(q).toMatch(/"\$\{schema\}"/);
    }
    // `where` nunca lleva un valor de usuario: solo un placeholder posicional.
    const asignacionesWhere = dataSrc.match(/where = `[^`]*`/g) || [];
    expect(asignacionesWhere.length).toBeGreaterThan(0);
    for (const a of asignacionesWhere) {
      expect(a).toMatch(/\$\$\{params\.length\}/);
      expect(a.match(/\$\{[^}]+\}/g)).toEqual(['${params.length}']);
    }
    // Y todo valor de usuario viaja en el array de parámetros.
    expect(dataSrc).toMatch(/params\.push\(seccion\)/);
  });
});

// ---------------------------------------------------------------------------
// Criterio 13 — documentación (api-contract + .env.example)
// ---------------------------------------------------------------------------
describe('Criterio 13 — documentación', () => {
  it('docs/api-contract.md documenta los 5 endpoints', () => {
    const doc = readFileSync(new URL('../docs/api-contract.md', import.meta.url), 'utf8');
    expect(doc).toMatch(/GET \/api\/images/);
    expect(doc).toMatch(/\/api\/images\/:id\/raw/);
    expect(doc).toMatch(/\/api\/admin\/images/);
    for (const code of ['413', '415']) expect(doc).toContain(code);
  });

  it('.env.example documenta por nombre la variable del límite de tamaño', () => {
    const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    expect(env).toMatch(/^IMAGES_MAX_FILE_SIZE_BYTES=/m);
  });

  it('docs/database.md documenta la tabla images', () => {
    const doc = readFileSync(new URL('../docs/database.md', import.meta.url), 'utf8');
    expect(doc).toMatch(/`images`/);
    expect(doc).toMatch(/bytes/i);
  });
});
