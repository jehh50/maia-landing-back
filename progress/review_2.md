# Review — feature 2: Middleware de errores JSON

**Veredicto:** APPROVED
**Tests:** `npm test` → 8 suites / 93 tests, verde (ejecutado por mí).

> **Nota:** esta es la **segunda pasada** de revisión. La primera terminó en
> `CHANGES_REQUESTED` (ver historial de este mismo archivo / `progress/current.md`
> §"Corrección tras review") por cobertura incompleta de `asyncHandler`. Esta
> revisión verifica la corrección.

## Qué cambió desde la primera pasada

- `src/asyncHandler.js` (nuevo): `asyncHandler(fn)` extraído a módulo propio
  para poder importarlo desde `app.js`, `auth.js`, `articlesRouter.js` y
  `leadsRouter.js` sin ciclo de imports.
- `src/auth.js`: `POST /api/auth/login`, `GET /api/auth/me` envueltos; y
  `requireAuth` (el middleware exportado, usado por `articlesRouter.js` y
  `leadsRouter.js`) envuelto con `asyncHandler` en el punto de `return`
  (`src/auth.js:142`).
- `src/articlesRouter.js`: los 7 handlers async envueltos.
- `src/leadsRouter.js`: los 2 handlers async envueltos.
- `tests/app.test.js`: ampliado con un `describe` nuevo que provoca un throw
  real en `POST /api/auth/login` montado con `createApp()`.
- `docs/api-contract.md` y `progress/current.md`: corregidas las afirmaciones
  de cobertura.
- `docs/conventions.md` §7: regla nueva sobre `asyncHandler` obligatorio.
- `feature_list.json`: `scope` de la feature 2 actualizado.

## Verificación punto por punto (encargo del coordinador)

### 1. Ningún handler/middleware async sin envolver

Recontado yo mismo, no me fío del reporte:

```
grep -n "async " src/*.js
```

Handlers/middlewares Express registrados como `async`, con su estado tras el diff:

| Archivo | Handler/middleware | Envuelto |
|---|---|---|
| `src/app.js:64` | `GET /api/health` | `asyncHandler(...)` ✓ |
| `src/app.js:74` | `POST /api/contact` | `asyncHandler(...)` ✓ |
| `src/auth.js:97` | `POST /api/auth/login` | `asyncHandler(...)` ✓ |
| `src/auth.js:130` | `GET /api/auth/me` | `asyncHandler(...)` ✓ |
| `src/auth.js:142` | `requireAuth` (middleware exportado, usado en `articlesRouter.js`/`leadsRouter.js` como `adminGuard`/`guard` y en el `DELETE` de artículos) | `asyncHandler(requireAuth)` en el `return` ✓ |
| `src/articlesRouter.js:16,28,42,52,63,91,105` | 7 handlers (`GET /api/articles`, `GET /api/articles/:slug`, `GET/POST/PATCH/DELETE /api/admin/articles[...]`) | `asyncHandler(...)` en los 7 ✓ |
| `src/leadsRouter.js:13,29` | `GET /api/admin/leads`, `GET /api/admin/leads/:id` | `asyncHandler(...)` en los 2 ✓ |

Total: 13 handlers de ruta + 1 middleware (`requireAuth`) = 14 puntos de
registro async, los 14 envueltos. Confirmado también con:

```
grep -n "async " src/*.js | grep -v "asyncHandler("
```
→ solo devuelve funciones internas que **no** se registran directamente en
Express (`loadUserFromCookie` en `auth.js:70`, y las funciones de datos en
`articles.js`, `db.js`, `leads.js`, `users.js`, `email.js`), que no lo
necesitan porque sus errores se propagan vía `await` dentro de handlers que
ya están envueltos o dentro de `try/catch` que no relanza.

`router.post('/api/auth/logout', (req, res) => {...})` (`src/auth.js:124`) es
**síncrono**, no `async` — no necesita `asyncHandler` (Express 4 ya reenvía
sus throws solo). Correcto no tocarlo.

`requireRole(...)` (`src/roles.js:39`) también es síncrono. Correcto no
tocarlo.

**Resultado: no queda ningún handler ni middleware async sin envolver.**

### 2. Test real sobre una ruta montada con `createApp()`

`tests/app.test.js:149` — `it('credenciales válidas + secreto JWT roto:
responde JSON 500 genérico en vez de colgarse', ...)` dentro del `describe`
`'Middleware de errores JSON — throw real en una ruta de auth.js montada con
createApp()'` (`tests/app.test.js:132`).

Mecanismo: `src/auth.js:97-122`, `POST /api/auth/login` llama a
`signToken(user)` (`src/auth.js:119`) **después** de su único `try/catch`
(líneas 106-112, que solo cubre `findUserByEmail`). El test inyecta
`authSecret: {}` vía la factory `createApp({ pool, schema, mailer, corsOrigin,
authSecret })` (`tests/app.test.js:143-146`) — la misma opción ya usada por
`tests/auth.test.js:35`, `tests/articles.test.js:36` y `tests/leads.test.js:50`,
no un mecanismo nuevo ni monkey-patching. Con secreto inválido, `jwt.sign`
lanza síncronamente dentro de `signToken` (`src/auth.js:56`), fuera de
cualquier `try/catch`. El log de la corrida real lo confirma:

```
[app] unhandled error Error: secretOrPrivateKey is not valid key material
    at signToken (src/auth.js:56:16)
    at /var/www/html/maia-landing-back/src/auth.js:120:19
```

El test usa un usuario real creado con `createUser` (`tests/app.test.js:24-28,33`,
`beforeAll`) y `pool`/`schema` reales de Postgres — no se mockea `pool.query`
ni se parchea nada en tiempo de ejecución. Antes del fix esta request se habría
quedado colgada (async throw sin `asyncHandler` = promesa sin manejar);
después responde `500 { error: 'Error interno del servidor' }`, verificado por
`expect(res.status).toBe(500)` + `expect(res.body).toEqual({ error: 'Error
interno del servidor' })` + `expect(res.headers['set-cookie']).toBeUndefined()`
(la ausencia de cookie confirma que el fallo ocurrió antes de poder emitirla,
evidencia adicional de que el throw es real y no un 500 fabricado por otra
vía).

Es un test genuino sobre la app real vía la factory. Cumple el punto 2 del
encargo.

### 3. `docs/api-contract.md` y `progress/current.md` ya no sobre-prometen

`docs/api-contract.md:143-151` ("Errores no controlados") ahora dice
explícitamente: "rechazo de promesa dentro de un handler/middleware `async`
(requiere reenvío explícito — **todo handler `async` de la app está envuelto
con `asyncHandler`**...)" — afirmación verificable y verificada en el punto 1,
ya no la genérica "en cualquier ruta o middleware" de la primera pasada.

`progress/current.md:34-43,94-106` documenta explícitamente el hallazgo de la
primera revisión, lo corrige, y ya no repite "los únicos handlers async de la
app". Correcto.

### 4. `scope` de `feature_list.json` refleja los archivos tocados

`feature_list.json` id 2, `scope`: `["src/app.js", "src/asyncHandler.js",
"src/auth.js", "src/articlesRouter.js", "src/leadsRouter.js",
"tests/app.test.js", "docs/api-contract.md", "docs/conventions.md"]`.
Contrastado con `git status --short` / `git diff --stat`: `src/app.js`,
`src/auth.js`, `src/articlesRouter.js`, `src/leadsRouter.js` (modificados,
tracked), `src/asyncHandler.js` y `tests/app.test.js` (nuevos). `docs/api-contract.md`
y `docs/conventions.md` no están bajo git (todo `docs/` es `??` en este repo),
pero su contenido coincide con lo declarado. Coincide exactamente. Correcto.

### 5. `npm test` ejecutado por mí

```
Test Files  8 passed (8)
     Tests  93 passed (93)
```
Desglose por suite: `email.test.js` 9, `contact.test.js` 17, `app.test.js` 7,
`roles.test.js` 15, `articles.test.js` 13, `leads.test.js` 14, `phone.test.js`
8, `auth.test.js` 10. Suma de las 7 suites originales: 9+17+15+13+14+8+10 = 86,
exactamente el baseline. `app.test.js` pasó de 6 a 7 tests (el nuevo de
`auth.js`). Ningún test previo desapareció ni está `skip`.

### 6. Resto de `CHECKPOINT.md`

- **C1 — Tests verdes:** [x] 8/93, verificado por mí.
- **C2 — Cobertura del acceptance:** [x]
  - "Un throw no capturado en cualquier ruta responde JSON 500..." →
    ahora sí, verificado en el punto 1 (14/14 puntos de registro envueltos) +
    `tests/app.test.js:149` (throw real en `auth.js` vía `createApp()`).
  - "El error real se loggea con prefijo de módulo; el stack nunca sale" →
    `tests/app.test.js:83-96` ("un rechazo de promesa envuelto con
    asyncHandler no filtra el mensaje ni el stack real") + prefijo `[app]`
    en `src/app.js`.
  - "El 404 existente sigue funcionando igual" →
    `tests/app.test.js:113-118`.
  - "Test que provoca un throw en una ruta y verifica la forma JSON" →
    `tests/app.test.js:149` (real, sobre `createApp()`) +
    `tests/app.test.js:57-67`/`69-81` (mecanismo genérico).
- **C3 — Factories con DI intactas:** [x] `createApp({ pool, schema, mailer,
  corsOrigin, authSecret })` conserva su firma; `src/asyncHandler.js` es una
  utilidad pura sin estado ni lectura de `process.env`, no rompe el patrón.
  `authSecret` ya era una opción existente de la factory (usada por
  `tests/auth.test.js`, `tests/articles.test.js`, `tests/leads.test.js` antes
  de este cambio), no una puerta trasera nueva.
- **C4 — SQL seguro:** [x] Sin cambios de SQL en este diff.
- **C5 — Contrato de API:** [x] `docs/api-contract.md` actualizado y ahora
  preciso (ver punto 3).
- **C6 — Sin secretos:** [x] `authSecret: {}` en el test es un valor
  deliberadamente inválido para provocar el throw, no un secreto real.
- **C7 — Separación de capas:** [x] `asyncHandler.js` es una utilidad
  transversal de HTTP (no toca SQL); `articlesRouter.js`/`leadsRouter.js`
  siguen sin escribir SQL, `articles.js`/`leads.js` no se tocaron.
- **C8 — Errores manejados:** [x] Los `try/catch` existentes no se tocaron;
  el gap que cubría esta feature (código fuera de esos bloques) ya está
  cerrado en los 14 puntos de registro.
- **C9 — DDL idempotente:** [x] No aplica, sin cambios de esquema.
- **C10 — Escape de HTML en correo:** [x] No aplica, sin cambios en `email.js`.
- **C11 — Limpieza:** [x] Sin `console.log` de debug; JSDoc explicativo en
  `asyncHandler.js`, sin código muerto ni TODOs sueltos.
- **C12 — Alcance:** [x] El diff coincide con el `scope` actualizado (ver
  punto 4). No hay refactors oportunistas.
- **C13 — Trazabilidad:** [x] `progress/current.md` documenta con precisión
  la corrección, incluida la admisión explícita del error de la primera
  pasada ("mi afirmación... era falsa... que no había ejecutado antes de
  escribirlo").
- **C14 — Estado coherente:** [x] `feature_list.json` id 2 sigue
  `"status": "in_progress"`; no se marcó `done`.
- **C15 — Git:** Ignorado por instrucción explícita del coordinador (lo
  gestiona aparte). `progress/current.md` deja constancia de que sigue en
  `main`.

## Invariantes del sistema

- **I1:** [x] `src/app.js:114-141` conserva el `try/catch` interno de
  `insertLead`/`mailer.sendLead` dentro del handler de `/api/contact`; el
  `asyncHandler` que envuelve todo el handler no altera ese camino porque el
  error del mailer nunca escapa del `catch` interno. `POST /api/contact`
  sigue respondiendo `201` con mail fallido (sin test nuevo necesario, el
  comportamiento no cambió y los tests de `contact.test.js` — 17/17 — lo
  siguen cubriendo).
- **I2–I6:** Sin cambios observados, no tocados por este diff.

## Bloqueantes

Ninguno.

## Menores (no bloquean)

1. `docs/architecture.md:134-136` y `docs/architecture.md:447-448` (§14.3)
   siguen describiendo el estado *previo* a esta feature ("no hay middleware
   de manejo de errores" / lo lista como limitación abierta). Queda fuera del
   `scope` declarado de la feature 2, pero conviene actualizarlo en un commit
   de docs inmediato tras el merge para que no quede desincronizado con
   `docs/api-contract.md`.
2. `tests/app.test.js:120-129` — el JSON malformado responde `500` genérico
   vía `errorHandler`, aunque `body-parser` marca el error con `status: 400` y
   `expose: true` (visible en el log de la corrida). No es parte del
   `acceptance` de esta feature y no rompe nada, pero se pierde la distinción
   400 (input del cliente) vs 500 (bug del servidor) para ese caso puntual.
