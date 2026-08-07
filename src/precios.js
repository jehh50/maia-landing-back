// Capa de datos para la tabla `planes` (feature 9 — sección de precios).
// Solo SQL puro y helpers puros; el router HTTP vive en `preciosRouter.js`.
// Este módulo no importa express ni toca `req`/`res` (CHECKPOINT.md C7).
//
// ALCANCE: **solo planes**. Los complementos y sus paquetes son la feature 10.

/**
 * Columnas que salen por la API. Lista fija, cero `SELECT *`
 * (docs/conventions.md §4). `precio_anual` y `ahorro_anual` NO están aquí
 * porque **no son columnas**: se derivan en `toPlan()`.
 */
const COLS = [
  'id',
  'nombre',
  'precio_mensual',
  'descuento_pct',
  'vinetas',
  'vinetas_tachadas',
  'destacado',
  'trial_texto',
  'es_custom',
  'orden',
  'created_at',
  'updated_at',
].join(', ');

/** Campos que el `PATCH` puede tocar. Los derivados y los de auditoría no. */
export const CAMPOS_EDITABLES = Object.freeze([
  'nombre', 'precio_mensual', 'descuento_pct', 'vinetas', 'vinetas_tachadas',
  'destacado', 'trial_texto', 'es_custom', 'orden',
]);

/** Meses de un año: el ahorro anual es la diferencia mensual por 12. */
const MESES_POR_ANIO = 12;

/**
 * Convierte a número lo que el driver `pg` devuelve para una columna `NUMERIC`.
 *
 * **Trampa conocida**: `pg` entrega `NUMERIC` como **string** de JavaScript
 * (`"19.00"`), no como número — para no perder precisión en valores que no
 * caben en un `double`. Si no se convierte, el front recibe `"19.00"` donde
 * espera `19` y cualquier comparación numérica (`precio > 100`, un `sort`)
 * falla en silencio. Los importes de esta tabla son precios de una landing,
 * muy lejos del límite de precisión de un `double`, así que la conversión es
 * segura. Devuelve `0` ante cualquier valor no numérico (nunca `NaN`, que
 * `JSON.stringify` convertiría en `null`).
 */
export function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Precio **mensual facturando anualmente** (no el total del año).
 *
 * Es el mismo significado que el campo `annual` del front: lo confirma la
 * aritmética de los ahorros que la web muestra hoy — `(19−17)×12 = 24`,
 * `(199−179)×12 = 240`, `(599−540)×12 = 708`. Tratarlo como total del año
 * dejaría todos los precios mal por un factor de 12.
 *
 * `Math.round()` es decisión del humano: el precio derivado se muestra como
 * entero, no como float.
 */
export function calcPrecioAnual(precioMensual, descuentoPct) {
  return Math.round(toNumber(precioMensual) * (1 - toNumber(descuentoPct) / 100));
}

/** Ahorro de un año completo pagando anualmente, en la misma moneda. */
export function calcAhorroAnual(precioMensual, precioAnual) {
  return Math.round((toNumber(precioMensual) - toNumber(precioAnual)) * MESES_POR_ANIO);
}

/** `true` si `v` es un array cuyos elementos son todos strings. */
export function isStringArray(v) {
  return Array.isArray(v) && v.every(item => typeof item === 'string');
}

/**
 * Da forma pública a una fila de `planes`:
 *
 * 1. Convierte los `NUMERIC` (string en `pg`) a número de JavaScript.
 * 2. Añade los campos **derivados** `precio_anual` y `ahorro_anual`, que no se
 *    persisten: si se guardaran, podrían desincronizarse del precio y del
 *    descuento.
 * 3. Caso Custom (`es_custom = true`, el Enterprise de la web): los dos
 *    derivados salen en `null`. Un plan sin cifra pública no puede acabar
 *    anunciando "ahorras $0/año" solo porque su precio almacenado sea 0.
 *
 * Devuelve `null` si `row` es nulo, para que el router pueda responder 404.
 */
export function toPlan(row) {
  if (!row) return null;

  const precioMensual = toNumber(row.precio_mensual);
  const descuentoPct  = toNumber(row.descuento_pct);

  const precioAnual = row.es_custom ? null : calcPrecioAnual(precioMensual, descuentoPct);
  const ahorroAnual = row.es_custom ? null : calcAhorroAnual(precioMensual, precioAnual);

  return {
    id:               row.id,
    nombre:           row.nombre,
    precio_mensual:   precioMensual,
    descuento_pct:    descuentoPct,
    precio_anual:     precioAnual,
    ahorro_anual:     ahorroAnual,
    vinetas:          row.vinetas ?? [],
    vinetas_tachadas: row.vinetas_tachadas ?? [],
    destacado:        row.destacado,
    trial_texto:      row.trial_texto,
    es_custom:        row.es_custom,
    orden:            row.orden,
    created_at:       row.created_at,
    updated_at:       row.updated_at,
  };
}

/**
 * Valores por defecto de un plan nuevo, alineados con los `DEFAULT` de la
 * columna. Se aplican también al merge del `PATCH` cuando la fila actual
 * trajera un nulo inesperado.
 */
function withDefaults(payload = {}) {
  return {
    nombre:           payload.nombre,
    precio_mensual:   payload.precio_mensual   ?? 0,
    descuento_pct:    payload.descuento_pct    ?? 0,
    vinetas:          payload.vinetas          ?? [],
    vinetas_tachadas: payload.vinetas_tachadas ?? [],
    destacado:        payload.destacado        ?? false,
    trial_texto:      payload.trial_texto      ?? null,
    es_custom:        payload.es_custom        ?? false,
    orden:            payload.orden            ?? 0,
  };
}

export async function createPlan(pool, schema, payload) {
  const p = withDefaults(payload);
  const { rows } = await pool.query(
    `INSERT INTO "${schema}".planes
       (nombre, precio_mensual, descuento_pct, vinetas, vinetas_tachadas,
        destacado, trial_texto, es_custom, orden)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
     RETURNING ${COLS}`,
    [
      p.nombre,
      p.precio_mensual,
      p.descuento_pct,
      JSON.stringify(p.vinetas),
      JSON.stringify(p.vinetas_tachadas),
      p.destacado,
      p.trial_texto,
      p.es_custom,
      p.orden,
    ],
  );
  return toPlan(rows[0]);
}

/**
 * Todos los planes ordenados por `orden` ascendente (`id` como desempate
 * estable). Es lo que consume la landing.
 */
export async function listPlanes(pool, schema) {
  const { rows } = await pool.query(
    `SELECT ${COLS}
       FROM "${schema}".planes
      ORDER BY orden ASC, id ASC`,
  );
  return rows.map(toPlan);
}

/** Un plan por id, o `null` si no existe. */
export async function getPlanById(pool, schema, id) {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM "${schema}".planes WHERE id = $1 LIMIT 1`,
    [id],
  );
  return toPlan(rows[0] || null);
}

/**
 * Actualiza solo los campos editables. Igual que `updateImage`/`updateUser`:
 * read-then-merge con lista de columnas **fija**, sin construir un `SET`
 * dinámico — así no hay ningún sitio donde colar una interpolación (C4).
 *
 * `patch` llega ya validado por el router. Devuelve el plan actualizado, o
 * `null` si no existe.
 */
export async function updatePlan(pool, schema, id, patch = {}) {
  const { rows: currentRows } = await pool.query(
    `SELECT ${COLS} FROM "${schema}".planes WHERE id = $1 LIMIT 1`,
    [id],
  );
  const current = currentRows[0];
  if (!current) return null;

  const pick = (campo) => (patch[campo] !== undefined ? patch[campo] : current[campo]);

  const next = withDefaults({
    nombre:           pick('nombre'),
    // Los NUMERIC vuelven de `pg` como string; Postgres los acepta igual al
    // reescribirlos, así que el merge no necesita convertirlos.
    precio_mensual:   pick('precio_mensual'),
    descuento_pct:    pick('descuento_pct'),
    vinetas:          pick('vinetas'),
    vinetas_tachadas: pick('vinetas_tachadas'),
    destacado:        pick('destacado'),
    trial_texto:      patch.trial_texto !== undefined ? patch.trial_texto : current.trial_texto,
    es_custom:        pick('es_custom'),
    orden:            pick('orden'),
  });

  const { rows } = await pool.query(
    `UPDATE "${schema}".planes
        SET nombre = $1,
            precio_mensual = $2,
            descuento_pct = $3,
            vinetas = $4::jsonb,
            vinetas_tachadas = $5::jsonb,
            destacado = $6,
            trial_texto = $7,
            es_custom = $8,
            orden = $9,
            updated_at = NOW()
      WHERE id = $10
      RETURNING ${COLS}`,
    [
      next.nombre,
      next.precio_mensual,
      next.descuento_pct,
      JSON.stringify(next.vinetas),
      JSON.stringify(next.vinetas_tachadas),
      next.destacado,
      next.trial_texto,
      next.es_custom,
      next.orden,
      id,
    ],
  );
  return toPlan(rows[0] || null);
}

export async function deletePlan(pool, schema, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM "${schema}".planes WHERE id = $1`,
    [id],
  );
  return rowCount > 0;
}

/** Solo para tests: la lista de columnas que se audita en `tests/precios.test.js`. */
export const __test__ = Object.freeze({ COLS });
