# Review — feature 3: Rate limiting en endpoints públicos

**Veredicto:** APPROVED
**Tests:** `npm test` → 9 suites / 107 tests, verde (baseline previo 8 suites/93 tests +
1 suite nueva `tests/ratelimit.test.js` con 14 tests; `tests/app.test.js`, ya
existente de la feature 2, aporta las otras 14 tests que suman a 93→107 junto
con ratelimit). Ejecutado por mí (no me fío del reporte del implementer):
schemas `maia_test_*` no quedaron huérfanos tras la corrida
(`psql -d maia-landing -Atc "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'maia_test_%'"` → vacío).

## Alcance verificado (diff real vs. `progress/current.md`)

`git status --short` muestra además `src/articlesRouter.js`, `src/leadsRouter.js`,
`README.md`, `.gitignore` como modificados. Revisé su diff: son el envoltorio
`asyncHandler` de la **feature 2** (ya aprobada — `progress/review_2.md` /
`feature_list.json` la marcaba `done` antes de esta sesión), simplemente
siguen sin commitear porque nada se ha commiteado en el repo. No son parte del
alcance de la feature 3 y `progress/current.md` no los reclama como propios de
esta sesión — coherente, no es un hallazgo C13. Los archivos realmente nuevos
de la feature 3 (`src/rateLimit.js`, `tests/ratelimit.test.js`) y los tocados
(`src/app.js`, `src/auth.js`, `.env.example`, `docs/architecture.md`,
`docs/api-contract.md`) sí coinciden exactamente con la tabla "Archivos
tocados" de `progress/current.md`.

`tests/contact.test.js` y `tests/auth.test.js` **no aparecen en `git status`**:
no se tocaron, tal como afirma `progress/current.md`. Confirmado también por
`npm test` en verde.

## Puntos atacados a fondo

**1. ¿El default protege de verdad?** Los límites son defaults activos (no
hace falta configurar nada en Render): `CONTACT_RATE_LIMIT_MAX=20` / 60s
(`src/app.js:24-25`, `RATE_LIMIT_DEFAULTS.contact`) y
`AUTH_RATE_LIMIT_MAX=10` / 15min (`RATE_LIMIT_DEFAULTS.auth`). Verifiqué que
`resolveRateLimiter` (`src/app.js:35-46`) construye el limiter con esos
defaults incluso cuando `createApp()` se llama sin ninguna opción de
`rateLimit` (cubierto por el test "createApp no rompe si no se pasa
`rateLimit`" en `tests/ratelimit.test.js:247-251`, que además comprueba que
sigue devolviendo `201`, o sea que el limiter **está montado y activo** por
defecto, no apagado). 20 req/min por IP frena un script de spam sin fricción
para un usuario real llenando el form; 10 intentos/15min por IP es un límite
de fuerza bruta razonable (no elimina el ataque distribuido por IPs
rotativas, pero eso es una limitación inherente a cualquier limitador por IP,
no un defecto de esta implementación — está documentado como tal en
`docs/architecture.md` §13, fila "Rate limit en memoria, sin Redis"). No es
una feature "que solo protege si alguien configura una env var": el
`.env.example` documenta las variables pero el valor por defecto ya protege
sin que nadie las configure en Render.

**2. Fuga de memoria.** `src/rateLimit.js:46-51` — `sweep(t)` solo actúa
cuando `hits.size >= SWEEP_THRESHOLD` (5000) y entonces borra **todas** las
entradas ya expiradas (`entry.resetAt <= t`) del `Map`. Esto es
autolimitante (una vez que el mapa cruza 5000 se vuelve a podar en cada
request no bloqueada hasta bajar del umbral) pero tiene dos debilidades
reales que dejo constando como hallazgo menor, no bloqueante:
  - **No está testeado.** Ningún test de `tests/ratelimit.test.js` ejercita
    `SWEEP_THRESHOLD` ni verifica que el `Map` efectivamente se poda; el
    propio `hits`/`sweep` no se exponen (`__internals`) para poder testearlo
    sin generar 5000 IPs distintas.
  - **Sin poda proactiva por debajo del umbral.** Si el tráfico único nunca
    llega a 5000 claves concurrentes (razonable para esta landing en Render
    free), entradas ya expiradas pueden persistir indefinidamente sin
    liberarse. El impacto de memoria es bajo en la práctica (~5000 entradas
    × objeto pequeño, del orden de cientos de KB, trivial para el plan free),
    así que no lo elevo a bloqueante, pero el diseño no tiene evicción
    temporal real, solo un tope de tamaño con poda diferida. Recomendación
    para una futura iteración: exponer `sweep`/tamaño del mapa en
    `__internals` y añadir un test que fuerce el umbral, o bajar el umbral y
    documentar explícitamente el trade-off en `docs/architecture.md` (hoy
    solo dice "sin dependencias externas", no menciona el umbral 5000 ni el
    criterio de poda).

**3. `trust proxy`.** Verifiqué empíricamente (script ad-hoc con
Express+supertest, descartado tras la prueba) que con `trust proxy=1`:
`X-Forwarded-For: 1.2.3.4, 9.9.9.9` → `req.ip === '9.9.9.9'` (ignora el valor
que un cliente intentaría inyectar por delante), igual que documentan
`docs/architecture.md` §4 y `progress/current.md` decisión 4. Esto coincide
con el test `tests/ratelimit.test.js:127-147`. **Importante matiz que no
está explícito en la documentación**: esta protección depende de que el
proxy de Render efectivamente **añada** su propio hop a `X-Forwarded-For` en
vez de reenviar la petición a nivel TCP sin tocar cabeceras — si eso no
fuera así, un único valor spoofeado por el cliente (`X-Forwarded-For:
6.6.6.6` sin segundo hop) sería aceptado tal cual como `req.ip` con
`trust proxy=1` (lo comprobé también en el mismo script: un XFF de un solo
valor se toma literal). Es el comportamiento estándar y documentado de
Render (routing tier añade `X-Forwarded-For`/`X-Forwarded-Proto`, patrón
idéntico al recomendado para Heroku/Render en la documentación de Express),
así que no lo bloqueo, pero no hay forma de verificarlo sin desplegar; lo
dejo anotado como supuesto de infraestructura, no un defecto del código.
Grep de `req.protocol`/`req.secure`/`req.hostname` en `src/`: no hay ningún
uso fuera de `req.ip` en `rateLimit.js`, así que `trust proxy` no toca
`cookie.secure` (que depende de `NODE_ENV`, no de `req.protocol`) ni ningún
otro comportamiento existente — confirmado por grep y por que
`tests/auth.test.js` (cookies) sigue en verde sin tocarse.

**4. 429 sin filtrar información.** Comprobado en corrida real de
`npm test`, no solo leyendo el código: `tests/ratelimit.test.js:64-71` y
`:177-179` verifican explícitamente `retry-after`, `ratelimit-limit`,
`ratelimit-remaining` y `x-ratelimit-remaining` ausentes, y que el body es
exactamente `{ error }` (`Object.keys(r3.body).sort()).toEqual(['error'])`).
`src/rateLimit.js:64-69` no setea ninguna cabecera antes del `res.status(429)
.json(...)`, coherente con `docs/api-contract.md` (líneas 62-66 y 106-109).

**5. Tests sin esperas reales.** `grep` de `setTimeout`/`sleep` en
`tests/ratelimit.test.js` y `src/rateLimit.js`: los únicos matches son
comentarios explicativos y `Date.now()` usado solo para generar el nombre
del schema de test (no para el rate limit). El reloj del limiter viene
siempre de `makeClock()` (`tests/ratelimit.test.js:44-47`), un contador
mutable en memoria — nunca `Date.now` real ni `setTimeout`.

**6. Tests previos intactos.** `git status --short` no lista
`tests/contact.test.js` ni `tests/auth.test.js` como modificados — no hay
diff que revisar porque no se tocaron. `npm test` los corre en verde (15 POST
de contact, 5 POST de auth, ver conteo en `progress/current.md`) por debajo
de los defaults `CONTACT_RATE_LIMIT_MAX=20` / `AUTH_RATE_LIMIT_MAX=10`.

**7. I4 y flujo de login/logout/me.** `src/auth.js:119-124` — el 401 sigue
siendo idéntico (`'Credenciales inválidas'`) tanto si `findUserByEmail`
devuelve `null` como si `verifyPassword` es `false`; el rate limiter
(`loginRateLimiter`) es un middleware previo al handler, no altera esa
lógica. `logout` no lleva rate limiter (`src/auth.js:132-135`, sin cambios) y
`me` tampoco (`asyncHandler` es el único cambio, no afecta su código).
Cubierto explícitamente por
`tests/ratelimit.test.js:213-231` — `it('no afecta a /api/auth/logout ni
/api/auth/me (solo se limita el login)')` — y por `tests/auth.test.js`
("401 con credenciales inválidas" / "401 cuando el usuario no existe"),
ambos en verde.

## Cobertura de `acceptance` (feature 3, `feature_list.json`)

1. "Limitados por IP con ventana configurable por env" →
   `tests/ratelimit.test.js:268` `it('CONTACT_RATE_LIMIT_MAX/WINDOW_MS se usan
   cuando la factory no sobreescribe rateLimit.contact')` y `:286`
   `it('AUTH_RATE_LIMIT_MAX se usa cuando la factory no sobreescribe
   rateLimit.auth')`. Documentado en `.env.example` y `docs/architecture.md` §12.
2. "429 con `{ error }` sin filtrar intentos restantes" →
   `tests/ratelimit.test.js:50` y `:163` (ambos primeros `it()` de cada
   `describe`), verifican headers y forma del body.
3. "Inyectable/desactivable por la factory, sin reloj real" →
   `tests/ratelimit.test.js:149` `it("se puede desactivar por completo vía la
   factory (rateLimit: { contact: false })")` y `:233` equivalente para
   `auth`; `makeClock()` en todos los demás tests.
4. "Tests existentes de contact/auth siguen verdes sin tocarlos" → confirmado
   arriba (punto 6).
5. "docs/api-contract.md documenta el 429" → confirmado, líneas 54-66 y
   98-109 de `docs/api-contract.md`.

## Checkpoints

- C1 Tests verdes: [x] — `npm test` → 9 suites / 107 tests, corrido por mí.
- C2 Cobertura del acceptance: [x] — ver sección arriba, cita archivo + `it()`.
- C3 Factories con DI: [x] — `createRateLimiter`, `createApp({ rateLimit })`,
  `createAuthRouter({ rateLimiter })`; `process.env` solo se lee dentro del
  cuerpo de `createApp()`/`resolveRateLimiter` (runtime), no en tiempo de
  import (`src/rateLimit.js` no importa ni lee `process.env` en absoluto).
- C4 SQL seguro: [x] — sin cambios de SQL en esta feature.
- C5 Contrato de API: [x] — `docs/api-contract.md` documenta 429 en ambos
  endpoints con el mismo formato de error.
- C6 Sin secretos: [x] — `.env.example` documenta solo nombres, sin valores.
- C7 Separación de capas: [x] — `rateLimit.js` no toca SQL ni conoce
  routers concretos; `app.js`/`auth.js` mantienen HTTP en su capa.
- C8 Errores manejados: [x] — no aplica lógica async nueva sin cubrir; rutas
  ya envueltas con `asyncHandler` (feature 2, verificado que sigue intacto).
- C9 DDL idempotente: [x] — no aplica, sin cambios de esquema.
- C10 Escape HTML en correo: [x] — no aplica, feature no toca email.
- C11 Limpieza: [x] — sin `console.log` de debug nuevo (grep limpio en los
  archivos tocados); único `console.log` del repo (`app.js:192`) es
  preexistente y de logging estructurado `[mail]`, no de esta feature.
- C12 Alcance: [x] — el diff de la feature 3 en sí (`rateLimit.js`, `app.js`,
  `auth.js`, `ratelimit.test.js`, `.env.example`, docs) toca solo esta
  feature. Los cambios sueltos en `articlesRouter.js`/`leadsRouter.js`/
  `README.md`/`.gitignore` son residuo sin commitear de la feature 2 ya
  aprobada, no de esta sesión.
- C13 Trazabilidad: [x] — `progress/current.md` refleja exactamente los
  archivos de la feature 3; el resto del `git status` se explica por
  commits pendientes de una feature anterior ya aprobada.
- C14 Estado coherente: [x] — `feature_list.json` tiene la feature 3 en
  `"status": "in_progress"`, no `done` (correcto, pendiente de este review).
- C15 Git: ignorado por instrucción explícita.

## Invariantes

- I1: [x] sin tocar (contact sigue devolviendo 201 con mail fallido).
- I2: [x] sin tocar.
- I3: [x] sin tocar.
- I4: [x] — verificado en el punto 7 de arriba, mismo 401 en ambas ramas.
- I5: [x] sin tocar (`requireAuth` recarga de DB, `asyncHandler` no cambia esa lógica).
- I6: [x] — `trust proxy` no interfiere con `cookieOpts` (no usa `req.protocol`),
  confirmado por grep y por `tests/auth.test.js` en verde.

## Bloqueantes

Ninguno.

## Menores (no bloquean)

1. `src/rateLimit.js:46-51` (`sweep`) — sin test que ejercite el umbral de
   poda (`SWEEP_THRESHOLD = 5000`) ni evicción proactiva por debajo de ese
   umbral. Bajo impacto de memoria en la práctica, pero recomendable exponer
   `sweep`/tamaño del `Map` vía `__internals` y añadir un test, o documentar
   explícitamente el umbral y el criterio de poda en `docs/architecture.md`
   §4 (hoy solo dice "sin dependencias externas", no detalla el mecanismo de
   evicción).
2. El supuesto de que Render añade `X-Forwarded-For` de forma nativa
   (base de toda la defensa de `trust proxy: 1` contra spoofing) no se puede
   verificar sin desplegar; es el patrón estándar documentado para
   Render/Heroku, pero vale la pena confirmarlo con un request real contra
   el servicio desplegado la primera vez que se toque este código.
