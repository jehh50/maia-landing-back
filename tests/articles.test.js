import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createPool, ensureSchema } from '../src/db.js';
import { createUser } from '../src/users.js';
import { AUTH_COOKIE_NAME } from '../src/auth.js';
import { slugify } from '../src/articles.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres:///maia-landing?host=/var/run/postgresql';

const schema = `maia_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const fakeMailer = { enabled: false, to: 'sales@test', async sendLead() { return { status: 'skipped' }; } };

let app, pool, editorCookie, adminCookie;

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.find(c => c.startsWith(`${AUTH_COOKIE_NAME}=`));
}

beforeAll(async () => {
  pool = createPool({ connectionString: TEST_DB_URL });
  await ensureSchema(pool, { schema });

  // Crear editor y admin
  await createUser(pool, { email: 'editor@test', password: 'pass-1', name: 'Editor' }, { schema });
  await createUser(pool, { email: 'admin@test',  password: 'pass-1', name: 'Admin'  }, { schema });
  await pool.query(`UPDATE "${schema}".users SET role = 'admin' WHERE email = 'admin@test'`);
  // editor queda con default 'editor'

  app = createApp({ pool, schema, mailer: fakeMailer, corsOrigin: '*', authSecret: 'test-secret-articles' });

  editorCookie = await loginAs('editor@test', 'pass-1');
  adminCookie  = await loginAs('admin@test',  'pass-1');
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

describe('slugify', () => {
  it('normaliza acentos y espacios a kebab-case', () => {
    expect(slugify('Hola Mundo Tildé')).toBe('hola-mundo-tilde');
    expect(slugify('   espacios MÚLTIples ')).toBe('espacios-multiples');
    expect(slugify('  ¿Qué onda?!  ')).toBe('que-onda');
  });
});

describe('GET /api/articles (público)', () => {
  it('lista solo published', async () => {
    // seed: un draft + un published
    await request(app).post('/api/admin/articles').set('Cookie', editorCookie)
      .send({ title: 'Borrador 1', body_md: 'x', status: 'draft' });
    await request(app).post('/api/admin/articles').set('Cookie', editorCookie)
      .send({ title: 'Publicado 1', body_md: 'x', status: 'published' });

    const res = await request(app).get('/api/articles');
    expect(res.status).toBe(200);
    expect(res.body.rows).toBeInstanceOf(Array);
    expect(res.body.rows.every(r => r.status === 'published')).toBe(true);
    expect(res.body.rows.some(r => r.title === 'Publicado 1')).toBe(true);
    expect(res.body.rows.some(r => r.title === 'Borrador 1')).toBe(false);
  });

  it('404 si slug es draft', async () => {
    const create = await request(app).post('/api/admin/articles').set('Cookie', editorCookie)
      .send({ slug: 'mi-draft', title: 'Draft slug', body_md: 'x', status: 'draft' });
    expect(create.status).toBe(201);
    const res = await request(app).get('/api/articles/mi-draft');
    expect(res.status).toBe(404);
  });

  it('200 si slug es published', async () => {
    await request(app).post('/api/admin/articles').set('Cookie', editorCookie)
      .send({ slug: 'mi-publicado', title: 'P', body_md: 'cuerpo', status: 'published' });
    const res = await request(app).get('/api/articles/mi-publicado');
    expect(res.status).toBe(200);
    expect(res.body.article.title).toBe('P');
  });
});

describe('Admin /api/admin/articles', () => {
  it('401 sin cookie', async () => {
    const res = await request(app).get('/api/admin/articles');
    expect(res.status).toBe(401);
  });

  it('200 con cookie editor — lista TODOS (drafts y published)', async () => {
    const res = await request(app).get('/api/admin/articles').set('Cookie', editorCookie);
    expect(res.status).toBe(200);
    expect(res.body.rows.some(r => r.status === 'draft')).toBe(true);
  });

  it('POST 201 con cookie editor, autogenera slug si falta', async () => {
    const res = await request(app).post('/api/admin/articles').set('Cookie', editorCookie)
      .send({ title: 'Hola Mundo', body_md: 'cuerpo md' });
    expect(res.status).toBe(201);
    expect(res.body.article.slug).toBe('hola-mundo');
    expect(res.body.article.status).toBe('draft');
    expect(res.body.article.published_at).toBeNull();
  });

  it('POST 422 si falta title', async () => {
    const res = await request(app).post('/api/admin/articles').set('Cookie', editorCookie)
      .send({ body_md: 'cuerpo' });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('title');
  });

  it('POST 409 si slug duplicado', async () => {
    await request(app).post('/api/admin/articles').set('Cookie', editorCookie)
      .send({ slug: 'unico-xyz', title: 'A', body_md: 'x' });
    const dup = await request(app).post('/api/admin/articles').set('Cookie', editorCookie)
      .send({ slug: 'unico-xyz', title: 'B', body_md: 'y' });
    expect(dup.status).toBe(409);
    expect(dup.body.field).toBe('slug');
  });

  it('PATCH actualiza title y al pasar a published setea published_at', async () => {
    const create = await request(app).post('/api/admin/articles').set('Cookie', editorCookie)
      .send({ title: 'Para publicar', body_md: 'x', status: 'draft' });
    const id = create.body.article.id;
    expect(create.body.article.published_at).toBeNull();

    const res = await request(app).patch(`/api/admin/articles/${id}`).set('Cookie', editorCookie)
      .send({ title: 'Para publicar v2', status: 'published' });
    expect(res.status).toBe(200);
    expect(res.body.article.title).toBe('Para publicar v2');
    expect(res.body.article.status).toBe('published');
    expect(res.body.article.published_at).not.toBeNull();
  });

  // Este test afirmaba 403 hasta la feature 8. El humano confirmó que el rol
  // `editor` SÍ debe poder eliminar publicaciones (`feature_list.json`, feature
  // 8, `decision_humano` (a)): el editor "puede ver, crear, editar y eliminar
  // una publicación". Se ACTUALIZA al comportamiento nuevo (204), no se borra.
  it('DELETE 204 con cookie editor (el editor sí borra publicaciones, feature 8)', async () => {
    const create = await request(app).post('/api/admin/articles').set('Cookie', editorCookie)
      .send({ title: 'A borrar', body_md: 'x' });
    const id = create.body.article.id;
    const res = await request(app).delete(`/api/admin/articles/${id}`).set('Cookie', editorCookie);
    expect(res.status).toBe(204);
    expect(res.text).toBeFalsy();
    // Y la fila desaparece de verdad.
    const { rows } = await pool.query(`SELECT id FROM "${schema}".articles WHERE id = $1`, [id]);
    expect(rows).toHaveLength(0);
  });

  it('DELETE sigue exigiendo sesión: 401 sin cookie', async () => {
    const create = await request(app).post('/api/admin/articles').set('Cookie', adminCookie)
      .send({ title: 'Sin sesión no se borra', body_md: 'x' });
    const id = create.body.article.id;
    const res = await request(app).delete(`/api/admin/articles/${id}`);
    expect(res.status).toBe(401);
    // Sigue existiendo.
    const check = await request(app).get(`/api/admin/articles/${id}`).set('Cookie', adminCookie);
    expect(check.status).toBe(200);
  });

  it('DELETE 404 con cookie editor si el artículo no existe', async () => {
    const res = await request(app).delete('/api/admin/articles/999999').set('Cookie', editorCookie);
    expect(res.status).toBe(404);
  });

  it('DELETE 204 con cookie admin', async () => {
    const create = await request(app).post('/api/admin/articles').set('Cookie', adminCookie)
      .send({ title: 'Borrar admin', body_md: 'x' });
    const id = create.body.article.id;
    const res = await request(app).delete(`/api/admin/articles/${id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(204);
  });

  it('GET /:id 404 si no existe', async () => {
    const res = await request(app).get('/api/admin/articles/999999').set('Cookie', editorCookie);
    expect(res.status).toBe(404);
  });
});
