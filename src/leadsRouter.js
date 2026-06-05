import { Router } from 'express';
import { listLeads, getLeadById } from './leads.js';
import { requireRole } from './roles.js';

export function createLeadsRouter({ pool, schema = 'public', requireAuth }) {
  if (!pool) throw new Error('createLeadsRouter requiere `pool`');
  if (!requireAuth) throw new Error('createLeadsRouter requiere `requireAuth`');

  const router = Router();
  const guard = [requireAuth, requireRole('admin', 'editor')];

  router.get('/api/admin/leads', guard, async (req, res) => {
    try {
      const result = await listLeads(pool, schema, {
        tipo:     req.query.tipo,
        pais_iso: req.query.pais_iso,
        q:        req.query.q,
        limit:    req.query.limit,
        offset:   req.query.offset,
      });
      res.json(result);
    } catch (err) {
      console.error('[leads] list error', err);
      res.status(500).json({ error: 'Error al listar leads' });
    }
  });

  router.get('/api/admin/leads/:id', guard, async (req, res) => {
    try {
      const lead = await getLeadById(pool, schema, req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
      res.json({ lead });
    } catch (err) {
      console.error('[leads] get error', err);
      res.status(500).json({ error: 'Error al cargar lead' });
    }
  });

  return router;
}
