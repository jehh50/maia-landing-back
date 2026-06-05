/**
 * Feature 15 — Roles de usuarios.
 *
 * Modelo simple de autorización por rol. El `req.user` lo populá el middleware
 * `requireAuth` que crea la feature 14 en `src/auth.js`. Aquí solo decidimos si
 * el rol del usuario está dentro del set permitido para el endpoint.
 */

export const ROLES = Object.freeze({
  ADMIN: 'admin',
  EDITOR: 'editor',
});

/**
 * `true` si `user.role` está en la lista de roles permitidos.
 * Devuelve `false` si `user` es null/undefined o no tiene `role`.
 *
 * @param {{ role?: string } | null | undefined} user
 * @param  {...string} roles
 * @returns {boolean}
 */
export function hasRole(user, ...roles) {
  if (!user || typeof user.role !== 'string') return false;
  if (roles.length === 0) return false;
  return roles.includes(user.role);
}

/**
 * Middleware Express factory. Responde 403 si el usuario autenticado no tiene
 * uno de los roles permitidos. Asume que un middleware previo (`requireAuth`)
 * populó `req.user`.
 *
 * Uso:
 *   router.delete('/leads/:id', requireAuth, requireRole('admin'), handler);
 *   router.patch('/posts/:id',  requireAuth, requireRole('admin', 'editor'), handler);
 *
 * @param  {...string} roles
 * @returns {(req: any, res: any, next: Function) => void}
 */
export function requireRole(...roles) {
  return function requireRoleMiddleware(req, res, next) {
    if (!hasRole(req && req.user, ...roles)) {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'No tienes permisos para realizar esta acción.',
      });
    }
    return next();
  };
}
