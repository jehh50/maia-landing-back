import { Router } from 'express';
import {
  CAMPOS_EDITABLES, isStringArray,
  createPlan, listPlanes, getPlanById, updatePlan, deletePlan,
} from './precios.js';
import { requireRole } from './roles.js';
import { asyncHandler } from './asyncHandler.js';

// Máximo de un `bigint` de Postgres (2^63 - 1). Un id por encima de esto no es
// "no encontrado" para Postgres: es un error de conversión (22003
// numeric_value_out_of_range) que, sin este guard, acabaría en un 500.
const PG_BIGINT_MAX = 9223372036854775807n;

const NOT_FOUND = 'Plan no encontrado';

const NOMBRE_MAX = 120;
const TRIAL_MAX  = 200;

// `precio_mensual` es NUMERIC(10,2): 8 dígitos enteros como mucho. Un valor por
// encima haría que Postgres lanzara 22003 (numeric_value_out_of_range) y el
// router respondería 500 por una entrada del usuario. Se valida antes, con el
// mismo criterio que `parseId`: entrada mala → 4xx, nunca 500.
const PRECIO_MAX = 99999999.99;

/**
 * Los ids son BIGSERIAL: aceptamos solo dígitos **y solo dentro del rango de un
 * `bigint`**. Cualquier otra cosa devuelve `null` y el router responde 404, así
 * que ni `/api/admin/precios/abc` (error 22P02 invalid_text_representation) ni
 * `/api/admin/precios/99999999999999999999999` (error 22003
 * numeric_value_out_of_range) llegan a Postgres para acabar en un 500. Mismo
 * patrón que `src/imagesRouter.js` (feature 7) y `src/usersRouter.js`
 * (feature 8); es el bug que cerró la feature 7 y no se debe reintroducir.
 */
function parseId(raw) {
  const s = String(raw ?? '');
  if (!/^\d{1,19}$/.test(s)) return null;
  if (BigInt(s) > PG_BIGINT_MAX) return null;
  return s;
}

/**
 * Número decimal a partir de un `number` o de un string numérico. `null` si no
 * lo es. Estricto a propósito: `Number('')`, `Number(null)`, `Number([])` y
 * `Number(true)` valen 0, así que un `Number()` a secas aceptaría basura como
 * si fuera un precio de 0.
 */
function parseDecimal(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Entero >= 0, o `null` si el valor no es válido (igual que en imágenes). */
function parseOrden(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/** Error de validación con el `field` que espera el contrato. */
function invalid(field, error) {
  return { field, error };
}

/**
 * Valida y normaliza los campos de un plan presentes en `body`.
 *
 * Devuelve `{ error, field }` si algo no cuadra (el router lo traduce a 422) o
 * `{ values }` con solo los campos presentes, ya normalizados. `requireNombre`
 * distingue el POST (nombre obligatorio) del PATCH (todo opcional).
 *
 * Las viñetas se validan aquí porque JSONB acepta cualquier cosa: sin esta
 * comprobación se podría persistir un número, un objeto o un array anidado y el
 * front reventaría al renderizar la lista.
 */
function validarPlan(body, { requireNombre }) {
  const values = {};

  if (body.nombre !== undefined || requireNombre) {
    const nombre = String(body.nombre ?? '').trim();
    if (!nombre) return invalid('nombre', 'nombre requerido');
    values.nombre = nombre.slice(0, NOMBRE_MAX);
  }

  if (body.precio_mensual !== undefined) {
    const precio = parseDecimal(body.precio_mensual);
    if (precio === null) {
      return invalid('precio_mensual', 'precio_mensual debe ser un número');
    }
    if (precio < 0) {
      return invalid('precio_mensual', 'precio_mensual no puede ser negativo');
    }
    if (precio > PRECIO_MAX) {
      return invalid('precio_mensual', `precio_mensual no puede superar ${PRECIO_MAX}`);
    }
    values.precio_mensual = precio;
  }

  if (body.descuento_pct !== undefined) {
    const pct = parseDecimal(body.descuento_pct);
    if (pct === null || pct < 0 || pct > 100) {
      return invalid('descuento_pct', 'descuento_pct debe ser un número entre 0 y 100');
    }
    values.descuento_pct = pct;
  }

  for (const campo of ['vinetas', 'vinetas_tachadas']) {
    if (body[campo] === undefined) continue;
    if (!isStringArray(body[campo])) {
      return invalid(campo, `${campo} debe ser un array de strings`);
    }
    values[campo] = body[campo];
  }

  for (const campo of ['destacado', 'es_custom']) {
    if (body[campo] === undefined) continue;
    if (typeof body[campo] !== 'boolean') {
      return invalid(campo, `${campo} debe ser booleano`);
    }
    values[campo] = body[campo];
  }

  if (body.trial_texto !== undefined) {
    values.trial_texto = body.trial_texto === null
      ? null
      : String(body.trial_texto).trim().slice(0, TRIAL_MAX);
  }

  if (body.orden !== undefined) {
    const orden = parseOrden(body.orden);
    if (orden === null) return invalid('orden', 'orden debe ser un entero >= 0');
    values.orden = orden;
  }

  return { values };
}

/**
 * Factory del router de precios — **solo planes** (feature 9). Los complementos
 * y sus paquetes son la feature 10 y no viven aquí.
 *
 * `GET /api/precios` es público (lo consume la landing); las cuatro rutas
 * `/api/admin/precios*` son **solo rol `admin`**, igual que el resto del
 * mantenedor del sitio.
 *
 * Este módulo no escribe SQL (C7): toda la persistencia vive en
 * `src/precios.js`.
 *
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool
 * @param {string} [opts.schema='public']
 * @param {import('express').RequestHandler} opts.requireAuth
 */
export function createPreciosRouter({ pool, schema = 'public', requireAuth } = {}) {
  if (!pool) throw new Error('createPreciosRouter requiere `pool`');
  if (!requireAuth) throw new Error('createPreciosRouter requiere `requireAuth`');

  const router = Router();
  const adminGuard = [requireAuth, requireRole('admin')];

  // --- Público ---

  router.get('/api/precios', asyncHandler(async (_req, res) => {
    try {
      const rows = await listPlanes(pool, schema);
      res.json({ rows });
    } catch (err) {
      console.error('[precios] list error', err);
      res.status(500).json({ error: 'Error al listar planes' });
    }
  }));

  // --- Admin (solo rol admin) ---

  router.get('/api/admin/precios/:id', ...adminGuard, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: NOT_FOUND });
    try {
      const plan = await getPlanById(pool, schema, id);
      if (!plan) return res.status(404).json({ error: NOT_FOUND });
      res.json({ plan });
    } catch (err) {
      console.error('[precios] get error', err);
      res.status(500).json({ error: 'Error al cargar plan' });
    }
  }));

  router.post('/api/admin/precios', ...adminGuard, asyncHandler(async (req, res) => {
    const { error, field, values } = validarPlan(req.body || {}, { requireNombre: true });
    if (error) return res.status(422).json({ error, field });

    try {
      const plan = await createPlan(pool, schema, values);
      res.status(201).json({ plan });
    } catch (err) {
      console.error('[precios] create error', err);
      res.status(500).json({ error: 'Error al crear plan' });
    }
  }));

  router.patch('/api/admin/precios/:id', ...adminGuard, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: NOT_FOUND });

    const { error, field, values } = validarPlan(req.body || {}, { requireNombre: false });
    if (error) return res.status(422).json({ error, field });

    // `precio_anual` y `ahorro_anual` son DERIVADOS: un body que solo los
    // traiga a ellos (o cualquier otro campo no editable) no actualiza nada.
    if (Object.keys(values).length === 0) {
      return res.status(422).json({
        error: `Nada que actualizar: se esperaba ${CAMPOS_EDITABLES.join(', ')}`,
      });
    }

    try {
      const plan = await updatePlan(pool, schema, id, values);
      if (!plan) return res.status(404).json({ error: NOT_FOUND });
      res.json({ plan });
    } catch (err) {
      console.error('[precios] update error', err);
      res.status(500).json({ error: 'Error al actualizar plan' });
    }
  }));

  router.delete('/api/admin/precios/:id', ...adminGuard, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: NOT_FOUND });
    try {
      const ok = await deletePlan(pool, schema, id);
      if (!ok) return res.status(404).json({ error: NOT_FOUND });
      res.status(204).end();
    } catch (err) {
      console.error('[precios] delete error', err);
      res.status(500).json({ error: 'Error al borrar plan' });
    }
  }));

  return router;
}
