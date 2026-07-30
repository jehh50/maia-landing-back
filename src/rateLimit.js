/**
 * Rate limiter en memoria (ventana fija) por clave, sin dependencias
 * externas. Suficiente para Render free (un solo proceso) — ver
 * docs/architecture.md §12 y feature 3 de `feature_list.json`.
 *
 * No usa `setTimeout`/`setInterval` para expirar entradas: el barrido es
 * perezoso (ocurre en la propia request cuando el mapa crece demasiado) para
 * no dejar timers vivos que compliquen el cierre limpio del proceso (o de
 * los tests).
 */

const DEFAULT_MESSAGE = 'Demasiadas solicitudes. Inténtalo de nuevo más tarde.';
const SWEEP_THRESHOLD = 5000;

/**
 * @param {object} opts
 * @param {number} opts.windowMs - duración de la ventana en ms (> 0).
 * @param {number} opts.max - máximo de requests por clave dentro de la ventana (> 0).
 * @param {() => number} [opts.now] - reloj inyectable (default `Date.now`). Los
 *   tests lo sobreescriben para simular el paso del tiempo sin esperas reales.
 * @param {(req: import('express').Request) => string} [opts.keyGenerator] -
 *   default: IP resuelta por Express (`req.ip`, respeta `trust proxy`).
 * @param {string} [opts.message] - mensaje del error 429.
 * @returns {import('express').RequestHandler}
 */
export function createRateLimiter({
  windowMs,
  max,
  now = Date.now,
  keyGenerator = (req) => req.ip,
  message = DEFAULT_MESSAGE,
} = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('createRateLimiter requiere `windowMs` numérico > 0');
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error('createRateLimiter requiere `max` numérico > 0');
  }
  if (typeof now !== 'function') {
    throw new Error('createRateLimiter requiere que `now` sea una función');
  }

  // key -> { count, resetAt }
  const hits = new Map();

  // Poda incondicional: borra toda entrada ya expirada, sin mirar el tamaño
  // del Map. Es la pieza que hace el trabajo real de liberar memoria; se
  // separa de la decisión de "cuándo llamarla" (ver `maybeSweep`) para poder
  // testearla de forma aislada desde `__internals.pruneExpired` sin depender
  // de alcanzar `SWEEP_THRESHOLD` con miles de claves reales.
  function pruneExpired(t) {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= t) hits.delete(key);
    }
  }

  // Disparador perezoso: solo poda cuando el Map ya creció lo bastante como
  // para que valga la pena recorrerlo entero. Por debajo de
  // `SWEEP_THRESHOLD` las entradas expiradas se quedan en memoria (coste
  // acotado: como mucho `SWEEP_THRESHOLD` objetos pequeños, del orden de
  // cientos de KB — trivial para el plan free de Render) hasta que el propio
  // tráfico haga crecer el Map o la clave se reutilice (en cuyo caso se
  // sobreescribe al comprobar `entry.resetAt <= t` en el middleware). Ver
  // docs/architecture.md §4 para el trade-off completo.
  function maybeSweep(t) {
    if (hits.size >= SWEEP_THRESHOLD) pruneExpired(t);
  }

  const rateLimiter = function rateLimiter(req, res, next) {
    const t = now();
    const key = keyGenerator(req) || 'unknown';

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      // Sin cabeceras RateLimit-*/Retry-After ni el conteo en el body: el
      // acceptance de la feature exige no filtrar cuántos intentos quedan
      // (ver docs/api-contract.md y progress/current.md, decisión 5).
      return res.status(429).json({ error: message });
    }

    maybeSweep(t);
    next();
  };

  // Superficie mínima para testear la poda sin generar `SWEEP_THRESHOLD`
  // (5000) IPs reales por HTTP: `hits` para inspeccionar el estado del Map,
  // `pruneExpired` para forzar la poda directamente con cualquier `t`, y
  // `SWEEP_THRESHOLD` para poder ejercitar también el disparo automático con
  // el número exacto de claves (llamadas directas al middleware, sin red).
  rateLimiter.__internals = { hits, pruneExpired, SWEEP_THRESHOLD };

  return rateLimiter;
}
