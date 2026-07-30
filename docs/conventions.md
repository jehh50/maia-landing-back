# Convenciones — MaIA Landing Back

> Léelo antes de escribir código y otra vez antes de cerrar sesión.
> Regla general: **imita el archivo que estás tocando**. Este documento solo
> fija lo que no es obvio leyendo el código.

## 1. Lenguaje y módulos

- **JavaScript ESM**, Node 22. `"type": "module"` → siempre `import`/`export`,
  nunca `require`. Las rutas relativas llevan extensión: `import { x } from './db.js'`.
- **No hay TypeScript, ni build, ni linter automático.** No introduzcas ninguno
  sin que sea una feature explícita en `feature_list.json`.
- Sin dependencias nuevas salvo que la feature lo pida. Añadir un paquete es una
  decisión, no un detalle de implementación: justifícala en `progress/current.md`.

## 2. Patrón obligatorio: factory + inyección de dependencias

Ningún módulo lee `process.env` en tiempo de import, ni crea singletons globales.
Todo se construye con una factory que acepta overrides:

```js
export function createXRouter({ pool, schema = 'public', requireAuth }) {
  if (!pool) throw new Error('createXRouter requiere `pool`');
  const router = Router();
  // …
  return router;
}
```

- Valida las dependencias obligatorias al construir y lanza con mensaje explícito.
- Los defaults van en la firma (`schema = 'public'`), no dentro del cuerpo.
- Esto es lo que permite montar la app real y la de test **igual**. Romperlo
  rompe toda la estrategia de tests: es motivo de rechazo en review.

## 3. Separación de capas

```
xRouter.js   → HTTP: validación de entrada, códigos de estado, forma de la respuesta
x.js         → datos: SQL puro, sin conocer req/res
```

`articles.js`, `leads.js`, `images.js`, `users.js` y `precios.js` **no importan
express** y no saben nada de HTTP. `articlesRouter.js`, `leadsRouter.js`,
`imagesRouter.js`, `usersRouter.js` y `preciosRouter.js` **no escriben SQL**. Si
tu cambio necesita cruzar esa línea, es señal de que va en la capa equivocada.

Los módulos de datos pueden llevar helpers **puros** además del SQL cuando son
del dominio de la entidad y se testean solos (`slugify` en `articles.js`;
`sniffMime`/`MIME_WHITELIST` en `images.js`; `isValidRole` en `users.js`;
`calcPrecioAnual`/`calcAhorroAnual`/`toPlan` en `precios.js`). El
criterio sigue siendo el mismo: nada que sepa de `req`/`res`. El hasheo de
contraseñas también vive en la capa de datos (`SALT_ROUNDS` está una sola vez, en
`users.js`): un router nunca llama a bcrypt.

## 4. SQL

- Todo valor de usuario va **parametrizado** (`$1, $2, …`). Sin excepciones.
- El único elemento interpolado es `schema`, y siempre entre comillas dobles:
  `` `SELECT … FROM "${schema}".leads` ``. `schema` **jamás** proviene de input
  de usuario (viene de env o del código de test).
- Las columnas seleccionadas se declaran en una constante `COLS` del módulo, no
  con `SELECT *`.
- Los `limit`/`offset` se sanitizan siempre (ver `sanitizeLimit` en `leads.js`).

## 5. Respuestas HTTP

- Éxito: objeto nombrado — `{ rows }`, `{ article }`, `{ lead }`, `{ ok, id }`.
- Error: `{ error: '<mensaje en español>' }`, con `field` en validaciones (422/409).
- Códigos en uso: `422` validación, `401` no autenticado, `403` rol insuficiente,
  `404` no existe, `409` conflicto de unicidad (`err.code === '23505'`),
  `413` payload demasiado grande (solo subida de imágenes), `415` tipo de
  archivo no soportado (solo subida de imágenes), `429` rate limit,
  `500` error interno, `503` DB caída (solo `/api/health`).
- **Nunca** filtres detalles internos (stack, SQL, estado del mailer) al cliente.
  Eso va al log; al cliente va un mensaje genérico.
- Cualquier cambio de forma o de código de estado → `docs/api-contract.md` en el
  mismo commit.

## 6. Logging

```js
console.error('[leads] list error', err);
```

Prefijo entre corchetes con el módulo: `[startup]`, `[mail]`, `[auth]`,
`[leads]`, `[articles]`, `[images]`, `[users]`, `[precios]`. **Cero `console.log` de debug** en
el código que entregas. Nunca loguees passwords, tokens, hashes ni el contenido
de `.env`. En las rutas que reciben una contraseña en el body (login,
`POST`/`PATCH` de usuarios) **no se loguea el body ni el objeto de error
completo**: solo `err.code`/`err.message`.

## 7. Errores

- Handlers async: `try/catch` completo. Un `await` sin catch en una ruta es un bug.
- Loguea el error real, responde el mensaje genérico.
- Las funciones "de consulta" (`detectCountry`, `verifyPassword`) devuelven un
  valor neutro ante fallo, **no lanzan**. Mantén esa propiedad.
- **Todo handler o middleware `async` que registres en un router
  (`router.get/post/patch/delete(...)`, o un middleware async como
  `requireAuth`) debe envolverse con `asyncHandler` de `src/asyncHandler.js`:
  `router.get('/x', asyncHandler(async (req, res) => { ... }))`.** Express 4
  **no** reenvía automáticamente un `throw`/rechazo dentro de una función
  `async` al middleware de errores — la request se queda colgada sin
  respuesta. Esto aplica **aunque el handler ya tenga su propio `try/catch`**:
  `asyncHandler` es la red de seguridad para lo que quede fuera de ese bloque
  hoy, o el día que alguien edite el handler y se le olvide envolver el código
  nuevo. Si añades una ruta o un middleware `async` nuevo y se te olvida
  `asyncHandler`, un bug en ese código quedará colgado en vez de responder
  `500` — es fácil de olvidar, así que revísalo explícitamente en cada PR que
  toque un router. El middleware de errores global (`errorHandler` en
  `src/app.js`) es quien finalmente responde el JSON genérico; ver
  `docs/api-contract.md` § "Errores no controlados".

## 8. Nombres

| Cosa | Convención | Ejemplo |
|---|---|---|
| Archivos | camelCase, `.js` | `articlesRouter.js` |
| Factories | `createX` | `createMailer` |
| Funciones de datos | verbo + entidad | `listLeads`, `getLeadById` |
| Columnas SQL y campos de la API | `snake_case` | `pais_iso`, `body_md` |
| Campos del formulario público | español (heredado del front) | `nombre`, `empresa`, `telefono` |
| Constantes de módulo | `SCREAMING_SNAKE` | `LIMIT_MAX`, `PHONE_RE` |

No renombres campos en español a inglés: son contrato con el front.

## 9. Tests

- Viven en `tests/`, un archivo por módulo: `tests/<modulo>.test.js`.
- `vitest` + `supertest`. Integración real contra Postgres, schema efímero por
  suite (copia el `beforeAll`/`afterAll` de `tests/contact.test.js`).
- El mailer **sí** se falsea (objeto que acumula envíos en un array). La DB no.
- Nombres de test descriptivos y en español, describiendo el resultado
  observable: `'401 con credenciales inválidas'`.
- Cada criterio de `acceptance` de la feature necesita al menos un test que lo
  cubra. Escribes el test en el mismo cambio que el código, no después.

## 10. Correo y HTML

- Todo string de usuario pasa por `escapeHtml()` antes de interpolarse. Sin
  excepciones.
- Plantillas compatibles con clientes de correo: tablas de 600px, sin flex/grid,
  sin `box-shadow`, hex completos, `font-family` con fallback `Arial, sans-serif`.
- Paleta: naranja `#E8440A`, texto `#1A1410`, bordes `#F0EBE8`, fondo `#FAFAF9`,
  muted `#A89E9A`.
- Cada plantilla tiene versión `text` **y** `html`.

## 11. Secretos

- **Nunca** leas ni escribas valores de `.env`. Si necesitas una variable nueva:
  documenta nombre y propósito en `.env.example` y en `progress/current.md`, y
  deja que un humano la configure.
- Toda variable nueva se documenta también en `docs/architecture.md` §12 y en
  `render.yaml` con `sync: false` si es sensible.

## 12. Git

- **No commitees a `main`.** Rama por tarea:
  `feat/<id>-<slug>`, `fix/<id>-<slug>`, `docs/<slug>`, `chore/<slug>`.
- Commits en formato convencional, en español, imperativo, ≤ 72 caracteres:

  ```
  feat(contact): rate limiting en POST /api/contact
  fix(email): evitar timeout al enviar por Resend
  docs(api): documentar filtros de /api/admin/leads
  test(leads): cubrir filtro pais_iso
  ```

  Scopes habituales: `contact`, `auth`, `articles`, `leads`, `email`, `db`,
  `api`, `harness`.
- Un commit = un cambio coherente. No mezcles features.
- El cuerpo del commit explica el **porqué**, no repite el diff.
- No commitees `.env`, dumps, ni archivos temporales.

## 13. Archivos del arnés

`AGENTS.md`, `CLAUDE.md`, `CHECKPOINT.md`, `feature_list.json`, `docs/`,
`progress/` y `.claude/` **se versionan**. No los añadas a `.gitignore`.
