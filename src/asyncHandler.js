/**
 * Envuelve un handler (o middleware) `async` de Express para reenviar
 * cualquier rechazo de promesa al middleware de errores.
 *
 * En Express 4, un `throw` (o un `await` rechazado) dentro de una función
 * `async` registrada como ruta o middleware **no** llega solo a `next(err)`:
 * la promesa que devuelve el handler queda sin manejar y la request se
 * queda colgada sin respuesta (ni HTML, ni JSON). Express 4 solo intercepta
 * automáticamente las excepciones **síncronas**.
 *
 * Uso obligatorio: **todo** handler/middleware `async` que se registre en un
 * router (`router.get/post/patch/delete(..., asyncHandler(async (req, res) => {...}))`)
 * debe pasar por aquí, incluso si ya tiene su propio `try/catch` — es la red
 * de seguridad para el código que quede fuera de ese `try/catch` hoy o el día
 * que alguien edite el handler y se le olvide (ver docs/conventions.md §7).
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<any>} fn
 * @returns {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => void}
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
