import { Router } from 'express';
import {
  createArticle, updateArticle, deleteArticle,
  getArticleById, getArticleBySlug, listArticles,
} from './articles.js';
import { requireRole } from './roles.js';
import { asyncHandler } from './asyncHandler.js';

export function createArticlesRouter({ pool, schema = 'public', requireAuth }) {
  if (!pool) throw new Error('createArticlesRouter requiere `pool`');
  if (!requireAuth) throw new Error('createArticlesRouter requiere `requireAuth`');

  const router = Router();

  // --- Públicos ---
  router.get('/api/articles', asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    try {
      const rows = await listArticles(pool, schema, { status: 'published', limit, offset });
      res.json({ rows });
    } catch (err) {
      console.error('[articles] list error', err);
      res.status(500).json({ error: 'Error al listar artículos' });
    }
  }));

  router.get('/api/articles/:slug', asyncHandler(async (req, res) => {
    try {
      const a = await getArticleBySlug(pool, schema, req.params.slug);
      if (!a || a.status !== 'published') return res.status(404).json({ error: 'Artículo no encontrado' });
      res.json({ article: a });
    } catch (err) {
      console.error('[articles] get error', err);
      res.status(500).json({ error: 'Error al cargar artículo' });
    }
  }));

  // --- Admin (auth + role editor/admin) ---
  const adminGuard = [requireAuth, requireRole('admin', 'editor')];

  router.get('/api/admin/articles', adminGuard, asyncHandler(async (_req, res) => {
    try {
      const rows = await listArticles(pool, schema, { limit: 200, offset: 0 });
      res.json({ rows });
    } catch (err) {
      console.error('[articles] admin list error', err);
      res.status(500).json({ error: 'Error al listar artículos' });
    }
  }));

  router.get('/api/admin/articles/:id', adminGuard, asyncHandler(async (req, res) => {
    try {
      const a = await getArticleById(pool, schema, req.params.id);
      if (!a) return res.status(404).json({ error: 'Artículo no encontrado' });
      res.json({ article: a });
    } catch (err) {
      console.error('[articles] admin get error', err);
      res.status(500).json({ error: 'Error al cargar artículo' });
    }
  }));

  router.post('/api/admin/articles', adminGuard, asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (!body.title || !String(body.title).trim()) {
      return res.status(422).json({ error: 'title requerido', field: 'title' });
    }
    if (!body.body_md && body.body_md !== '') {
      return res.status(422).json({ error: 'body_md requerido', field: 'body_md' });
    }
    try {
      const article = await createArticle(pool, schema, {
        slug:      body.slug,
        title:     String(body.title).trim(),
        excerpt:   body.excerpt ? String(body.excerpt) : null,
        body_md:   String(body.body_md || ''),
        cover_url: body.cover_url ? String(body.cover_url) : null,
        status:    body.status === 'published' ? 'published' : 'draft',
        author_id: req.user?.id ?? null,
      });
      res.status(201).json({ article });
    } catch (err) {
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'Slug ya existe', field: 'slug' });
      }
      console.error('[articles] create error', err);
      res.status(500).json({ error: 'Error al crear artículo' });
    }
  }));

  router.patch('/api/admin/articles/:id', adminGuard, asyncHandler(async (req, res) => {
    try {
      const article = await updateArticle(pool, schema, req.params.id, req.body || {});
      if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });
      res.json({ article });
    } catch (err) {
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'Slug ya existe', field: 'slug' });
      }
      console.error('[articles] update error', err);
      res.status(500).json({ error: 'Error al actualizar artículo' });
    }
  }));

  // El rol `editor` también borra publicaciones: la descripción de la feature 8
  // dice que el editor "puede ver, crear, editar y eliminar una publicación", y
  // el humano lo confirmó explícitamente (`feature_list.json`, feature 8,
  // `decision_humano` (a)). Antes era `requireRole('admin')` a secas, lo que lo
  // dejaba fuera del único verbo del CRUD de artículos que sí necesita.
  router.delete('/api/admin/articles/:id', adminGuard, asyncHandler(async (req, res) => {
    try {
      const ok = await deleteArticle(pool, schema, req.params.id);
      if (!ok) return res.status(404).json({ error: 'Artículo no encontrado' });
      res.status(204).end();
    } catch (err) {
      console.error('[articles] delete error', err);
      res.status(500).json({ error: 'Error al borrar artículo' });
    }
  }));

  return router;
}
