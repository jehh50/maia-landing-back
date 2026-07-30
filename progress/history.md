# Historial de sesiones

> Bitácora **append-only**. Cada sesión cerrada se añade al final. No edites
> entradas anteriores; si algo se corrigió después, se dice en la entrada nueva.

Formato de entrada:

```markdown
## YYYY-MM-DD — feature <id>: <nombre>

**Resultado:** done | blocked | parcial
**Archivos:** src/x.js, tests/x.test.js
**Verificación:** npm test → N suites / M tests
**Notas:** decisiones, sorpresas, deuda dejada.
```

---

## 2026-07-27 — Configuración del arnés de agentes

**Resultado:** done
**Archivos:** `AGENTS.md`, `CLAUDE.md`, `CHECKPOINT.md`, `feature_list.json`,
`docs/` (architecture, context, conventions, verification, database, api-contract),
`progress/`, `.claude/agents/*`, `.claude/skills/`, `.gitignore`
**Verificación:** `npm test` → 7 suites / 86 tests, verde. Sin cambios en `src/`.
**Notas:**
- `architecture.md` se movió de la raíz a `docs/architecture.md`, que es la ruta
  que referencian AGENTS.md y los tres subagentes.
- `.gitignore` tenía `*.md`, lo que dejaba fuera de git todo el arnés. Se acotó.
- El arnés heredado describía un stack NestJS + TypeScript + Jest y una base
  `crm_application` que no son los de este repo (Node ESM + Express + vitest,
  base `maia_landing`). Corregido en AGENTS.md, CLAUDE.md y los subagentes.
- `docs/` y `progress/` no existían: se crearon desde cero a partir del código real.
- Deuda conocida heredada: `.env` está trackeado en git (feature 1 del backlog).
- Skills: se quitó `typescript-advanced-types` (el proyecto no usa TypeScript) y
  se instaló `jeffallan/claude-skills@javascript-pro` en su lugar. `skills-lock.json`
  quedó con dos entradas: `nodejs-backend-patterns` y `javascript-pro`.

---

## 2026-07-27 — feature 2: Middleware de errores JSON

**Resultado:** done
**Archivos:** `src/app.js`, `src/asyncHandler.js`, `src/auth.js`,
`src/articlesRouter.js`, `src/leadsRouter.js`, `tests/app.test.js`,
`docs/api-contract.md`, `docs/conventions.md`, `docs/architecture.md`,
`feature_list.json`
**Verificación:** `npm test` → 8 suites / 93 tests, verde (86 baseline + 7
nuevos en `tests/app.test.js`). Sin schemas `maia_test_*` huérfanos.
**Notas:**
- `errorHandler` (4 argumentos) montado en `src/app.js` como último
  `app.use`, después del catch-all 404: responde siempre
  `500 { "error": "Error interno del servidor" }` en JSON, nunca el HTML por
  defecto de Express, sin filtrar stack ni mensaje real (log con prefijo
  `[app]`); delega en `next(err)` si `res.headersSent`.
- Express 4 no reenvía solo un rechazo de promesa de un handler `async` a
  `next(err)` — se creó `asyncHandler` (`src/asyncHandler.js`, módulo
  compartido para evitar import circular) y se envolvieron los **14 puntos de
  registro async** de la app: 2 en `app.js`, 2 + `requireAuth` en `auth.js`, 7
  en `articlesRouter.js`, 2 en `leadsRouter.js`.
- **Primera pasada de review → CHANGES_REQUESTED**: solo se habían envuelto
  los 2 handlers de `app.js`; quedaban 11 sin cubrir y una afirmación falsa en
  `progress/current.md` ("los únicos handlers async de la app"). Corregido en
  una segunda vuelta, incluido un test real (no solo el mini-express
  sintético) que provoca un throw genuino en `POST /api/auth/login` montado
  con `createApp()` — inyectando `authSecret: {}` vía la factory para que
  `jwt.sign` reviente síncronamente fuera del único `try/catch` de ese
  handler. Segunda pasada → APPROVED (`progress/review_2.md`).
- Regla nueva documentada en `docs/conventions.md` §7: todo handler/middleware
  `async` registrado en un router debe envolverse con `asyncHandler`, incluso
  si ya tiene su propio `try/catch` — es la red de seguridad para lo que quede
  fuera de ese bloque hoy o el día que alguien edite el handler y se le
  olvide.
- `docs/architecture.md` actualizado: §2 menciona `src/asyncHandler.js`, §4
  documenta el `errorHandler` al final del pipeline y el porqué de
  `asyncHandler`, y §14 mueve "Sin middleware de errores" a "Resueltas".
- Deuda dejada, explícitamente fuera del `acceptance` de esta feature (no se
  tocó): un JSON malformado en el body responde `500` genérico vía
  `errorHandler` en vez de `400` (body-parser marca el error con
  `status: 400`/`expose: true`, que hoy no se respeta). Anotado por el
  reviewer como menor; si se decide perseguir, es candidata a feature nueva
  del backlog.

---

## 2026-07-27 — feature 3: Rate limiting en endpoints públicos

**Resultado:** done
**Archivos:** `src/rateLimit.js` (nuevo), `src/app.js`, `src/auth.js`,
`tests/ratelimit.test.js` (nuevo), `.env.example`, `docs/architecture.md`,
`docs/api-contract.md`, `feature_list.json`
**Verificación:** `npm test` → 9 suites / 110 tests, verde (93 baseline + 17
en `tests/ratelimit.test.js`). Sin schemas `maia_test_*` huérfanos.
**Notas:**
- `src/rateLimit.js`: `createRateLimiter({ windowMs, max, now, keyGenerator })`
  — contador de ventana fija en memoria (`Map<key, {count, resetAt}>`), sin
  dependencias nuevas (Render free es un solo proceso; no se introdujo
  Redis ni `express-rate-limit`, que habría tocado `package.json`, prohibido).
  `now` inyectable (default `Date.now`) para que los tests simulen el paso
  del tiempo sin `setTimeout` reales.
- Aplicado **solo** a `POST /api/contact` (montado en `createApp`, `src/app.js`)
  y `POST /api/auth/login` (inyectado en `createAuthRouter` vía la opción
  `rateLimiter`, `src/auth.js`) — nunca de forma global; `/api/health`,
  `/api/auth/me`, `/api/articles*` y las rutas admin no se ven afectadas.
- Defaults **activos sin configurar nada** en Render: `CONTACT_RATE_LIMIT_MAX=20`
  / ventana 60 s, `AUTH_RATE_LIMIT_MAX=10` / ventana 15 min. Elegidos para
  proteger de verdad (frenar spam/fuerza bruta scriptados) y a la vez tolerar
  el volumen de `tests/contact.test.js` (15 POST) y `tests/auth.test.js`
  (5 POST) sin tocar esos archivos — cada suite construye su propio
  `createApp()` con su propio limiter en memoria, sin contaminación cruzada.
  Configurables por env (`CONTACT_RATE_LIMIT_WINDOW_MS`/`MAX`,
  `AUTH_RATE_LIMIT_WINDOW_MS`/`MAX`) e inyectables/desactivables por la
  factory: `createApp({ rateLimit: { contact: {...}|false, auth: {...}|false } })`.
- `app.set('trust proxy', 1)` en `createApp`: Render pone exactamente un
  reverse proxy delante del proceso; sin esto `req.ip` sería siempre la IP
  de ese proxy para todo el tráfico (el rate limit por IP bloquearía a todos
  los usuarios a la vez que a un único abusador). `trust proxy: true`
  (confiar en toda la cadena) sería explotable: un cliente podría spoofear
  su IP con su propio `X-Forwarded-For`. Verificado empíricamente (script
  ad-hoc con Express + supertest, descartado tras la prueba, y cubierto
  también por un test real en `tests/ratelimit.test.js`) que con
  `trust proxy=1`, `X-Forwarded-For: 1.2.3.4, 9.9.9.9` produce
  `req.ip === '9.9.9.9'` — toma el hop más a la derecha (el que añadiría el
  proxy real) e ignora lo que el cliente intente inyectar por delante.
- `429 { "error": "<mensaje genérico>" }` — **sin** cabeceras `RateLimit-*`
  ni `Retry-After`: el `acceptance` exige no filtrar cuántos intentos
  quedan, y `RateLimit-Limit` combinado con los intentos observados
  permitiría calcularlo por resta; se descartó también `Retry-After` para no
  dar ninguna señal de temporización a un atacante.
- **Review (`progress/review_3.md`) → APPROVED sin bloqueantes**, con 2
  hallazgos menores:
  1. La poda del `Map` (`sweep`, gatillada por `hits.size >= SWEEP_THRESHOLD`
     = 5000) no estaba testeada. **Atendido antes de cerrar**: se separó en
     `pruneExpired(t)` (poda incondicional) y `maybeSweep(t)` (el disparador
     por tamaño), y el middleware expone `__internals = { hits,
     pruneExpired, SWEEP_THRESHOLD }` — superficie mínima solo para tests
     (no es API pública). 3 tests nuevos en `tests/ratelimit.test.js`
     (describe `"createRateLimiter — poda del Map (__internals)"`) llaman al
     middleware directamente (sin HTTP, helper `callLimiter`) para probar
     tanto `pruneExpired` de forma aislada como el cruce real de
     `SWEEP_THRESHOLD` (5000 claves via llamadas directas, no requests
     reales). `docs/architecture.md` §4 documenta ahora el umbral, el
     criterio de poda y el trade-off (memoria acotada en el peor caso, sin
     liberación proactiva por debajo del umbral).
  2. **Deuda conocida, no resuelta a propósito**: toda la defensa de
     `trust proxy: 1` contra spoofing asume que el proxy de Render añade su
     propio hop a `X-Forwarded-For` en vez de reenviar la conexión sin
     tocar cabeceras. Es el patrón estándar documentado para
     Render/Heroku/Vercel, pero no se puede verificar sin desplegar. Queda
     pendiente confirmarlo con un request real contra el servicio
     desplegado (`curl -s https://<servicio>.onrender.com/api/health` con
     un `X-Forwarded-For` propio y comparar contra logs, o instrumentar
     `req.ip` temporalmente) la primera vez que se toque este código o se
     investigue un falso positivo/negativo del rate limit en producción.
     Requiere acceso al servicio desplegado — no lo puede resolver un
     agente en este repo.
- No se tocó `package.json`, `render.yaml` ni `.node-version`. No se leyó ni
  escribió ningún valor de `.env`; las 4 variables nuevas están documentadas
  solo por nombre en `.env.example` y en `docs/architecture.md` §12.

---

## 2026-07-27 — feature 5: Refresh / renovación de sesión

**Resultado:** done
**Archivos:** `src/auth.js`, `tests/auth.test.js`, `.env.example`,
`docs/architecture.md`, `docs/api-contract.md`, `feature_list.json`
**Verificación:** `npm test` → 9 suites / 117 tests, verde (110 baseline + 7
nuevos en `tests/auth.test.js`, describe `"Renovación de sesión (feature
5)"`). Sin schemas `maia_test_*` huérfanos.
**Notas:**
- `src/auth.js`: `loadUserFromCookie` se convirtió en `loadSession()`, que
  además del usuario (recargado de DB, invariante I5) devuelve el `payload`
  decodificado del token — necesario para leer `exp` sin volver a verificar
  el JWT. Nueva función `renewCookieIfNeeded(res, payload)`: si al token le
  queda menos de la ventana de renovación (`resolvedRefreshWindowMs`) para
  expirar, firma un token nuevo (`signToken`, 7 días reales) y llama
  `res.cookie(COOKIE_NAME, freshToken, cookieOpts)` — **reutilizando
  literalmente el mismo objeto `cookieOpts`** que ya construye `login`, sin
  reconstruirlo, que es lo que garantiza que la cookie renovada lleve
  exactamente `httpOnly`/`sameSite`/`secure`/`path` que la original
  (invariante I6). Integrado en `requireAuth` (todas las rutas
  `/api/admin/*`) y en `GET /api/auth/me`; `POST /api/auth/login` (ya emite
  cookie fresca) y `POST /api/auth/logout` (borra la cookie) no pasan por
  esta lógica.
- Ventana configurable por `AUTH_REFRESH_WINDOW_MS` (env, default 1 día =
  `86400000` ms sobre un token de 7 días) o por la opción `refreshWindowMs`
  de `createAuthRouter`; si no es un número válido > 0 se usa el default,
  mismo criterio que las variables de rate limit de la feature 3.
- Reloj inyectable (`now`, default `Date.now`) añadido a `createAuthRouter`
  **solo** para decidir si el token está dentro de la ventana de renovación
  — no afecta a la firma del token nuevo (sigue usando `expiresIn: '7d'`
  real). Permite que los tests controlen esa decisión de forma determinista
  sin `setTimeout` ni depender del reloj del sistema (mismo patrón que
  `tests/ratelimit.test.js`); el `exp` de los tokens craftados a mano en los
  tests sigue siendo relativo al reloj real porque `jwt.verify` no acepta un
  reloj inyectado.
- Un token ya expirado nunca llega a `renewCookieIfNeeded`: `verifyToken`
  (`jwt.verify`) ya lo rechaza antes (`TokenExpiredError` → `null`), así que
  `loadSession` devuelve `user: null` y la request responde 401 sin
  `Set-Cookie`, tal cual antes de esta feature.
- `tests/auth.test.js`: 7 tests nuevos usando una app mínima
  (`express` + `cookie-parser` + `auth.router` + `auth.requireAuth`) y
  tokens firmados a mano con `jsonwebtoken` (mismo secreto que la app) para
  controlar `exp` con precisión, sin esperas reales. Cubren los 4 criterios
  de `acceptance` más las trampas explícitas de la consigna: no renovar
  fuera de la ventana (no `Set-Cookie` en cada request), `logout` no dispara
  renovación, y la cookie renovada conserva exactamente las opciones de
  producción (`cookieSecure: true` → `SameSite=None; Secure`).
- `docs/api-contract.md` documenta el cambio observable: `GET /api/auth/me`
  y las rutas `/api/admin/*` ahora pueden incluir `Set-Cookie` (antes solo
  pasaba en el login), condicionado a la ventana de renovación.
  `docs/architecture.md` §8 describe el comportamiento completo y §12
  documenta `AUTH_REFRESH_WINDOW_MS`.
- **Review (`progress/review_5.md`) → APPROVED sin bloqueantes**, con 2
  hallazgos menores:
  1. La tabla "Archivos tocados" de `progress/current.md` no listaba
     `docs/api-contract.md` pese a haberlo modificado realmente (sí
     mencionado en el plan). **Corregido** antes de cerrar la sesión.
  2. El guard `remainingMs <= 0` dentro de `renewCookieIfNeeded` es código
     defensivo hoy inalcanzable en el flujo normal — un token ya expirado
     nunca llega a esa función porque `verifyToken` lo filtra antes (401
     directo) — y no tiene un test que lo ejercite directamente (solo
     indirectamente, vía el 401 sin `Set-Cookie`). Aceptado como "cinturón y
     tirantes", no bloqueante; queda como deuda menor si alguien quisiera
     testear ese branch de forma aislada en el futuro.
- No se tocó `package.json`, `render.yaml` ni `.node-version`. No se leyó ni
  escribió ningún valor de `.env`; la variable nueva está documentada solo
  por nombre y default en `.env.example` y `docs/architecture.md` §12.

---

## 2026-07-28 — feature 1: Sacar .env del control de versiones

**Resultado:** done
**Archivos:** `(git index)` — `git rm --cached .env`; `.env.example`;
`feature_list.json`
**Verificación:** `npm test` → 9 suites / 117 tests, verde (sin cambios de
código de aplicación). Servidor arrancado manualmente (`node --watch
src/server.js`), `GET /api/health` → 200 `{"ok":true,"db":true,"mailer":true}`,
leyendo `.env` desde disco ya sin trackear. Sin procesos residuales.
**Notas:**
- `git rm --cached .env` ejecutado: `.env` deja de estar en el índice de git
  (`git ls-files .env` → vacío) pero **sigue existiendo en disco sin cambios**
  (`test -f .env` → PRESENT); nunca se leyó ni se citó su contenido en ningún
  momento de la sesión, ni siquiera indirectamente. `.gitignore` ya cubría
  `.env`/`.env.local` desde el saneo inicial del arnés, no requirió cambio.
- `.env.example` auditado contra todo `process.env.*`/`process.env[name]`
  usado en `src/` y `scripts/` (21 variables en uso). Único gap encontrado:
  `NODE_ENV` (usada en `src/auth.js` para `cookieSecure`, fijada a
  `production` por `render.yaml`) — añadida solo como comentario/placeholder,
  sin valor real. Se amplió también el comentario de `SMTP_HOST` para dejar
  explícita la convención `SMTP_HOST=resend` (HTTP API de Resend, `src/email.js`,
  reutiliza `SMTP_PASS`/`SMTP_USER`, sin variable nueva).
- **⚠️ ADVERTENCIA — el saneo del índice NO cierra la exposición.** El repo
  `maia-landing-back` es **público** en GitHub y `.env` estuvo trackeado
  desde antes de que existiera la regla de `.gitignore`: sus valores han sido
  legibles por cualquiera y **siguen en el historial de commits de git**,
  intactos — `git rm --cached` no los borra ni los invalida, solo detiene la
  sangría hacia adelante. Sigue pendiente, **a cargo de un humano** (fuera del
  alcance de esta feature, no lo hace ni lo puede hacer un agente):
  1. **Rotar** las credenciales cuyo *nombre* de variable es:
     `DATABASE_URL`, `SMTP_PASS`, `SMTP_USER`, `AUTH_SECRET`,
     `MAIA_ADMIN_PASSWORD` (en sus respectivos proveedores — Postgres,
     SMTP/Resend, regenerar el secreto JWT, cambiar la contraseña del admin —
     y actualizar las variables de entorno en Render). Ningún valor real de
     estas variables se ha leído, citado ni copiado en ningún archivo del
     repo en ningún momento de esta feature.
     `PORT, CORS_ORIGIN, DB_SCHEMA, PGSSL, SMTP_HOST, SMTP_PORT, SMTP_SECURE,
     MAIL_FROM, MAIL_TO, AUTH_REFRESH_WINDOW_MS, NODE_ENV, MAIA_ADMIN_EMAIL,
     CONTACT_RATE_LIMIT_*, AUTH_RATE_LIMIT_*` no son secretos y no requieren
     rotación.
  2. Opcionalmente, **purgar el historial de git** (`git filter-repo`/BFG) si
     se quiere eliminar el rastro además de rotar — decisión y ejecución
     humanas.
- **No se commiteó ni se pusheó nada**, por decisión explícita del humano
  (alcance acordado: "saneo local, sin commitear ni pushear nada"). El
  `git rm --cached .env` y los cambios en `.env.example` quedan solo en el
  índice/árbol de trabajo local para que el humano los revise y decida
  cuándo commitear. Sin ramas nuevas, sin `push`, sin reescritura de
  historial (`filter-repo`/`filter-branch`/BFG) ejecutada por el agente.
- **Review (`progress/review_1.md`) → APPROVED sin bloqueantes.** Único
  hallazgo: una autocrítica de proceso **del propio reviewer** (ejecutó
  `git diff --cached` sin `--name-only`/`--stat` en su propia verificación,
  lo que mostró 2 líneas de valores reales de `.env` en su terminal por
  estar el archivo en estado de borrado en el índice) — no atribuible al
  trabajo del implementer, que en ningún momento leyó ni citó valores de
  `.env`; ese contenido no se volvió a citar ni se escribió en ningún
  archivo. Verificado explícitamente que `.env.example`, `progress/current.md`
  y `feature_list.json` no contienen ningún valor real, solo nombres de
  variable.

---

## 2026-07-28 — feature 4: Suite unitaria que corra sin Postgres

**Resultado:** done
**Archivos:** `package.json`, `tests/roles.test.js`,
`tests/roles.schema.test.js` (nuevo), `docs/verification.md`,
`docs/architecture.md`, `docs/context.md`, `feature_list.json`
**Verificación:** `npm test` → 10 archivos / 117 tests, verde (mismo total que
el baseline anterior, repartido en un archivo más tras el split). `npm run
test:no-db` → 3 archivos / 30 tests, verde. Sin schemas `maia_test_*`
huérfanos.
**Notas:**
- `package.json`: único cambio, la línea `"test:no-db": "vitest run
  tests/phone.test.js tests/email.test.js tests/roles.test.js"` dentro de
  `"scripts"` — autorizado explícitamente por el humano el 2026-07-28 (nota
  de la feature en `feature_list.json`). `"test"`, `"dependencies"` y
  `"devDependencies"` intactos; `package-lock.json` sin diff.
- **Auditoría real de cada suite** (no por nombre de archivo, como pedía la
  consigna): `tests/phone.test.js` y `tests/email.test.js` ya eran 100%
  puros (sin `import` de `db.js`, sin `pool`). `tests/app.test.js` (feature 2)
  y `tests/ratelimit.test.js` (feature 3) resultaron mixtos pero con el
  `beforeAll` que abre Postgres a **nivel de archivo**, así que todo el
  archivo requiere DB para poder ejecutarse aunque algunas de sus
  aserciones no la usen — se dejaron íntegros fuera del comando rápido,
  decisión documentada explícitamente (partirlos habría sido más invasivo de
  lo que pide el `acceptance`, que solo nombra "phone, email y validación
  pura"). `tests/roles.test.js` (de una feature ya cerrada, no nombrada en
  la consigna pero auditada igual) resultó también mixto, con una estructura
  distinta: su `createPool`/`ensureSchema` estaban anidados **dentro de un
  describe concreto** (`"ensureSchema añade columna `role` a users"`), no en
  un `beforeAll` de archivo — los otros tres describes (`ROLES`, `hasRole`,
  `requireRole`) eran ya 100% puros. Se interpretó como la "validación pura"
  del `acceptance` (funciones de autorización, sin extraer nada de `src/app.js`
  porque sus regex de validación no están exportadas y tocarlas se habría
  salido del `scope` de la feature).
- Se separó `tests/roles.test.js` en dos archivos en vez de filtrar por
  `--testNamePattern`: la frontera "necesita DB / no la necesita" queda
  explícita en el árbol de `tests/` en vez de depender de un regex frágil
  ante un renombrado de test futuro. Ningún `it()` se borró ni se modificó —
  solo cambiaron de archivo los 2 tests de la migración `ALTER TABLE users
  ADD COLUMN role`, a `tests/roles.schema.test.js` (nuevo).
- **Verificación real de "pasa con Postgres apagado"**: sin detener el
  servicio del sistema, se apuntó `TEST_DATABASE_URL` a un puerto muerto
  (`postgres://nouser:nopass@127.0.0.1:1/nodb`). `npm run test:no-db` pasó
  igual (30/30); como control negativo, la misma variable rota contra
  `npm test -- tests/contact.test.js` falló con `ECONNREFUSED` dentro de
  `ensureSchema`/`beforeAll` — confirma que el aislamiento del comando rápido
  es real y no un artefacto de caché o de mocks. El reviewer repitió
  independientemente ambas pruebas.
- `docs/verification.md`: nueva §1.1 documenta `npm run test:no-db` — qué
  corre, cuándo usarlo, y qué **no** cubre explícitamente (sin SQL real, sin
  `POST /api/contact`/leads/articles/auth con JWT real/rate limiting/error
  middleware sobre una app real, sin la migración `role`; "no es señal de
  deploy seguro"). §2 y §6 lo referencian; §3 (baseline) corregido de 7/86
  (desactualizado desde antes de esta feature) a 10 archivos/117 tests.
- `docs/architecture.md`: nueva §11.1 con el mismo detalle; §11 actualiza el
  recuento de archivos/tests. §14 se reescribió más allá del `acceptance`
  estricto de esta feature, a petición del líder tras el APPROVED, porque el
  backlog quedó vacío y era el momento de sanear la sección completa: movió
  "Los tests requieren Postgres" a Resueltas (matizando que `npm test` sigue
  requiriendo DB, solo un subconjunto no) y también "Sin refresh de sesión"
  (que llevaba desde el 2026-07-27 sin reflejar el cierre de la feature 5);
  reescribió el punto de `.env` para distinguir "sacado del índice" (feature 1,
  hecho) de "rotación pendiente" (sigue abierto, solo lo hace un humano); y
  anotó que `ensureSchema` en cada arranque queda **aceptado
  conscientemente** (feature 6 descartada por el humano), no pendiente de
  implementación.
- `docs/context.md` §4: corregido "No hay suite que corra en seco" (ya no
  cierto del todo) para no contradecir `verification.md`/`architecture.md`.
- **Review (`progress/review_4.md`) → APPROVED sin bloqueantes ni hallazgos
  menores.** El reviewer verificó de forma independiente: el diff exacto de
  `package.json` (un único hunk), la correspondencia `it()` por `it()` del
  split de `roles.test.js` (15 tests totales, ninguno aguado ni eliminado),
  ambas ejecuciones con `TEST_DATABASE_URL` roto (positiva y de control), y
  `npm test` completo (117/117).
- No se tocó `render.yaml`, `.node-version`, ni ninguna dependencia. No se
  leyó ni escribió ningún valor de `.env`; esta feature no introduce
  variables de entorno nuevas. No se commiteó ni se pusheó nada.
- El backlog de `feature_list.json` queda sin features `pending` tras cerrar
  esta — todas las propuestas están `done` o `descartada`. La deuda abierta
  real que queda (rotación de credenciales, `ensureSchema` en boot aceptado
  conscientemente) está documentada en `docs/architecture.md` §14 y en el
  aviso persistente de `progress/current.md`.

---

## 2026-07-29 — feature 7: CRUD de imagenes.

**Resultado:** done (APPROVED sin bloqueantes, `progress/review_7.md`)
**Archivos nuevos:** `src/images.js`, `src/imagesRouter.js`, `tests/images.test.js`
**Archivos tocados:** `src/db.js`, `src/app.js`, `package.json` (una línea:
`multer`), `package-lock.json`, `.env.example`, `docs/database.md`,
`docs/architecture.md`, `docs/api-contract.md`, `docs/conventions.md`,
`docs/verification.md`, `docs/context.md`, `feature_list.json`
**Verificación:** `npm test` → 11 archivos / **166 tests**, verde (baseline
previo 10 / 117; +49 del archivo nuevo, ninguno borrado ni marcado `skip`).
`npm run test:no-db` → 3 archivos / 30 tests, sin cambios (`images.test.js`
necesita Postgres). Sin schemas `maia_test_*` huérfanos.

**Notas:**

- **El binario va en Postgres (columna `bytes` BYTEA)**, decisión del humano en
  `decision_humano` de la feature y no re-litigada: el filesystem de Render es
  efímero (un archivo escrito en disco se pierde en cada deploy) y S3/Cloudinary
  exigiría credenciales nuevas que hoy no existen. Se acepta el peso en la BD.
  `multer` con `memoryStorage`, así que el buffer va de la request a la columna
  sin tocar disco.
- **Rutas** (el `acceptance` original decía `POST /api/images` y "400" genérico;
  el líder lo corrigió a mitad de sesión al prefijo del repo y a los códigos que
  ya usa `articlesRouter.js`): público `GET /api/images` (`?seccion=`, orden
  `orden ASC, id ASC`) y `GET /api/images/:id/raw`; solo `admin`
  `POST /api/admin/images` (multipart), `PATCH /api/admin/images/:id` y
  `DELETE /api/admin/images/:id` (204 sin body). Las **tres** rutas de escritura
  dan 401 sin cookie y 403 con rol `editor`; los dos GET son públicos.
- **Códigos**: 422 `{ error, field }` (falta archivo, falta `seccion`, `seccion`
  fuera del enum, `orden` no entero ≥ 0), 415 `{ error, field: 'file' }` (MIME),
  413 `{ error, field: 'file' }` (tamaño). Los tres salen como
  `application/json`: el `MulterError` se atrapa explícitamente en el wrapper
  `uploadSingleImage` (`LIMIT_FILE_SIZE` → 413, otros `MulterError` → 422,
  cualquier otro error → `next(err)` como red del `errorHandler`). Sin ese
  wrapper multer haría `next(err)` y el cliente vería un 500. El reviewer
  ejercitó los 6 casos en vivo: ninguno devuelve HTML ni 500.
- **Validación de MIME en tres capas**, porque el `mimetype` que entrega multer
  es el `Content-Type` que declara el cliente y es falsificable: (1) MIME
  declarado en la whitelist, (2) extensión coherente con ese MIME —ambas en el
  `fileFilter`—, (3) **magic bytes del buffer real** (`sniffMime`: firma PNG de 8
  bytes, `FF D8 FF` de JPEG, `RIFF….WEBP` de WebP, a mano y sin dependencias
  nuevas) y que coincidan con el declarado. Lo que se persiste en `mime_type` es
  el MIME **detectado**. **Límite declarado**: no decodifica la imagen, así que
  un archivo con cabecera válida y cuerpo basura se aceptaría y el navegador
  simplemente no lo renderizaría; decodificar exigiría una librería de imagen no
  aprobada. Con `nosniff` + whitelist sin SVG, el peor caso es una imagen rota,
  no ejecución de código.
- **SVG excluido a propósito**, no es una omisión que haya que "arreglar": es XML
  ejecutable (`<script>`, `onload`/`onerror`, `<foreignObject>`,
  `xlink:href="javascript:"`) y `/raw` lo serviría en crudo con su propio
  `Content-Type` desde el origen de la API → **XSS almacenado** en el mismo
  origen donde vive la cookie de sesión del panel. El motivo está en
  `docs/architecture.md` **§7.1** (sección propia, no un comentario del código),
  reforzado en la tabla de decisiones y en `docs/api-contract.md`, con un test
  que exige que el doc lo explique y mencione XSS.
- **Análogo de la invariante I3 para `bytes`**: el binario nunca sale en JSON.
  `src/images.js` tiene `META_COLS` (sin `bytes`) para las 5 queries de
  listado/detalle/escritura y `RAW_COLS` (con `bytes`) usada solo por
  `getImageWithBytes()`, a la que solo llama `GET /api/images/:id/raw`. Cero
  `SELECT *` en todo `src/`. Dos tests: uno de comportamiento (recorre filas,
  `Object.keys`, y el **texto crudo** con `/"bytes"/`, distinguiendo `size_bytes`
  —que sí sale— de `bytes` —que no—, repetido en POST y PATCH) y uno estructural
  (parsea las constantes del propio fuente). El reviewer auditó las 6 queries una
  por una: correcto sin reservas.
- Otras decisiones: `seccion` es un enum en código (`SECCIONES`), no un `CHECK`,
  para que añadir una sección sea una línea y no una migración; el `PATCH` solo
  toca `alt`/`orden`/`seccion` y nunca el binario (reemplazar es un POST nuevo);
  `updateImage` hace read-merge-`UPDATE` con lista de columnas **fija**, sin
  `SET` dinámico, precisamente para que no haya dónde colar una interpolación;
  el límite de tamaño sigue el criterio de `src/rateLimit.js` (default 5 MB
  activo sin configurar nada, override por `IMAGES_MAX_FILE_SIZE_BYTES` leída
  **dentro** de la factory —C3— o por `createApp({ images: { maxFileSize } })`,
  que es lo que usan los tests con 128 bytes para ejercitar el 413); multer se
  monta **solo** en `POST /api/admin/images` y **después** del `adminGuard`, así
  que un anónimo o un `editor` recibe 401/403 sin que el binario se parsee.
- **Variable de entorno nueva:** `IMAGES_MAX_FILE_SIZE_BYTES`, documentada por
  **nombre** y propósito en `.env.example` y en `docs/architecture.md` §12. Es
  opcional (default 5 MB activo) y no es un secreto, así que no necesita
  `sync: false`. **No se leyó ni se escribió ningún valor de `.env`.**
- `multer` (^2.2.0) es la **única** dependencia añadida: una sola línea en
  `dependencies`. `test`, `test:no-db`, el resto de dependencies y
  devDependencies intactos; `render.yaml` y `.node-version` no se tocaron
  (mtime 2026-06-04, verificado por el reviewer). `package-lock.json` trae
  exactamente 10 entradas y todas son multer o sus transitivas.
- **Review:** APPROVED sin bloqueantes. El reviewer auditó `bytes`, la validación
  de MIME y los errores de subida **ejercitando la app**, no leyendo el informe
  del implementer, y los tres salieron correctos. De sus 6 menores se atendieron
  los dos marcados como "merecen atenderse antes de cerrar":
  1. **`parseId` no filtraba el desbordamiento de `bigint`**: un id de solo
     dígitos fuera de rango llegaba a Postgres, provocaba el error `22003` y
     acababa en **500 en vez de 404** en las tres rutas con `:id` —
     contradiciendo la promesa literal de `docs/api-contract.md` ("404 … nunca un
     500"). Se arregló **en el código, no bajando la promesa del doc**: `parseId`
     exige `/^\d{1,19}$/` **y** compara con `PG_BIGINT_MAX`
     (`9223372036854775807n`) vía `BigInt`, comprobación exacta y no aproximada.
     +2 tests: el id del repro del reviewer en `/raw`, `PATCH` y `DELETE`, más el
     límite exacto de `bigint`, el primer valor que lo excede y un id de 20
     dígitos.
  2. Sección `## Verificación` **duplicada** en `progress/current.md` (resto de
     plantilla que decía "(pendiente)" y contradecía al bloque real): borrada.
  Los menores 3 (`updateImage` read-then-write sin transacción: dos `PATCH`
  concurrentes pueden perder un campo; riesgo ~0 con un panel de un solo admin, y
  la alternativa —`SET` dinámico— es justo lo que evita la interpolación de SQL),
  4 (tercera copia de `positiveNumberFromEnv`, idéntica a las de `app.js` y
  `auth.js`: extraerla habría sido un refactor oportunista y una violación de
  C12 — candidata para una feature de limpieza futura) y 6 (recuento de
  criterios) quedan **anotados a propósito, no arreglados**. El menor 5 era un
  error de redacción del propio `acceptance` ("las cuatro rutas de escritura"
  cuando solo hay tres): el implementer lo declaró en vez de inventarse una
  cuarta ruta, el reviewer confirmó por `grep` que no había ninguna escapada, y
  el líder corrigió el texto del criterio.
- **Alcance:** el reviewer verificó por mtimes que solo se escribieron los
  archivos de esta feature. En particular `src/articlesRouter.js` **no se tocó** y
  su `DELETE` sigue con `requireRole('admin')`: la feature 8 no se adelantó.
- C15 queda incumplido a conciencia: **no se commiteó ni se pusheó nada** y no se
  creó rama, por instrucción explícita del humano — la misma excepción ya
  aceptada al cerrar las features 1, 3, 4 y 5. El trabajo queda en el árbol
  local; rama y commit sugeridos: `feat/7-crud-imagenes` y
  `feat(images): CRUD de imágenes de secciones con binario en Postgres`.
- **No se modificó `../maia-landing-front` ni `../maia-landing`.** Migrar
  `Hero.tsx`/`CTAFinal.tsx` para consumir esta API queda **fuera de alcance**: es
  trabajo de otro repo y nunca se modifica un repo hermano desde aquí. Hasta que
  eso se haga, el front sigue sirviendo las imágenes estáticas de `public/` y
  esta API queda disponible sin consumidor.

---

## 2026-07-30 — feature 8: CRUD de usuarios

**Resultado:** done (APPROVED del reviewer, `progress/review_8.md`)
**Archivos:** `src/usersRouter.js` (nuevo), `tests/users.test.js` (nuevo),
`src/users.js`, `src/app.js`, `src/articlesRouter.js`, `tests/articles.test.js`,
`docs/api-contract.md`, `docs/architecture.md`, `docs/database.md`,
`docs/conventions.md`, `docs/context.md`, `docs/verification.md`
**Verificación:** `npm test` → 12 archivos / 221 tests (baseline previo 11 / 166)

**Estado al cerrar:** done · **Inicio:** 2026-07-29 23:38 · **Cierre:** 2026-07-30

**Baseline verificado antes de tocar nada:** `pg_isready` OK
(`/var/run/postgresql:5432 - aceptando conexiones`) y `npm test` →
**11 archivos / 166 tests, verde**. Coincide con `docs/verification.md` §3.

## Plan

- [x] Ampliar `src/users.js` (capa de datos) con `listUsers`, `getUserById`,
      `updateUser`, `deleteUser`, `countAdmins` + `PUBLIC_COLS` (lista fija de
      columnas, sin `password_hash`, sin `SELECT *`). No romper `createUser` /
      `findUserByEmail` / `verifyPassword` (`auth.js` depende de ellas).
- [x] `src/usersRouter.js` nuevo: los 5 endpoints `/api/admin/users`, solo rol
      `admin`, cero SQL (C7), `parseId` con el guard de rango de `bigint`
      copiado de `imagesRouter.js`.
- [x] Montarlo en `src/app.js` (una línea, igual que el de imágenes).
- [x] Relajar el DELETE de artículos a `requireRole('admin','editor')`
      (decisión del humano) y **actualizar** el test que afirmaba 403.
- [x] `tests/users.test.js` nuevo, cubriendo los 14 criterios (con test
      explícito de I3, de las dos guardas del DELETE, del autor→artículo y de
      que el editor no gana permisos fuera del blog).
- [x] Docs: `api-contract.md`, `architecture.md`, `database.md`,
      `conventions.md`, `context.md`, `verification.md`.

## Archivos tocados

| Archivo | Qué cambió |
|---|---|
| `src/users.js` | **Ampliado** (capa de datos). Nuevo: `PUBLIC_COLS` (lista fija `id, email, name, role, created_at`, sin `password_hash`), `VALID_ROLES`/`isValidRole`, helpers privados `normalizeName`/`hashPassword`/`domainError`, y las cinco funciones del CRUD: `listUsers`, `getUserById`, `countAdmins`, `updateUser`, `deleteUser`. `createUser` ahora acepta `role` (default `'editor'`, el mismo de la columna) y devuelve `PUBLIC_COLS` (antes `id, email, name, created_at` → **añade `role`**, cambio aditivo). `findUserByEmail` y `verifyPassword` **intactas** (`auth.js` depende de ellas). `__test__` expone también `PUBLIC_COLS`. |
| `src/usersRouter.js` | **NUEVO**. Los 5 endpoints `/api/admin/users`, `adminGuard = [requireAuth, requireRole('admin')]`, cero SQL, `parseId` con guard de rango de `bigint`, y las dos guardas del DELETE. **[Post-review]** los `catch` del `POST` y del `PATCH` loguean ahora `err` completo (hallazgo menor 2, decisión 14). |
| `src/app.js` | Dos líneas: el `import` y `app.use(createUsersRouter({ pool, schema, requireAuth: auth.requireAuth }))`, tras el router de leads. Nada más. |
| `src/articlesRouter.js` | El `DELETE /api/admin/articles/:id` pasa de `requireAuth, requireRole('admin')` a usar el `adminGuard` ya existente (`admin`, `editor`), con comentario del porqué. Único cambio del archivo. |
| `tests/users.test.js` | **NUEVO**, **53** tests (52 + 1 del arreglo post-review), un `describe` por criterio del acceptance. |
| `tests/articles.test.js` | El test `DELETE 403 con cookie editor` **actualizado** a `DELETE 204 …` (ver justificación abajo) + 2 tests nuevos alrededor del mismo endpoint. 13 → 15 tests. |
| `docs/api-contract.md` | Sección nueva "Usuarios (feature 8)" con los 5 endpoints, sus códigos y las dos guardas; nota de cambio de permisos y fila `DELETE /api/admin/articles/:id` → `admin, editor`. |
| `docs/architecture.md` | §2 (árbol + factories + separación de capas), §4 (pipeline), §5 (tabla de endpoints), §7 (invariante I3 en `users`), §8 (tabla de roles + `SALT_ROUNDS`), **§8.1 nueva** (mantenedor de usuarios: I3, borrado físico, guardas y la transacción), §11 (12 archivos de test + los schemas efímeros extra), §13 (4 decisiones nuevas). |
| `docs/database.md` | §2 (constantes de columnas por módulo), §5 (nota en la fila `users` + **subsección nueva** "`users` — modelo de roles y el hash fuera de la API") y la lista de invariantes protegidas por los tests. |
| `docs/conventions.md` | §3 (`users.js`/`usersRouter.js` en la separación de capas; bcrypt vive en la capa de datos) y §6 (prefijos `[users]`/`[images]`; no loguear el body de rutas con contraseña). |
| `docs/context.md` | §1 (el panel incluye el mantenedor de usuarios) y §3 (dos decisiones nuevas). |
| `docs/verification.md` | §1.1 (qué no cubre `test:no-db`), §3 baseline (11/166 → **12/221**, con el porqué del cambio de recuento en `articles.test.js`) y §6 checklist. |
| `feature_list.json` | Feature 8 a `in_progress` durante el trabajo y a `done` (`closed: 2026-07-30`) tras el **APPROVED** del reviewer (`progress/review_8.md`). |
| `progress/current.md` | Este archivo. |

**No tocados a propósito:** `package.json`, `package-lock.json`, `render.yaml`,
`.node-version`, `src/db.js` (cero cambios de esquema), `src/auth.js`,
`src/roles.js`, `scripts/*`, `.env` (ni leído ni escrito), `.env.example` (no hay
variable nueva) y `../maia-landing-front` / `../maia-landing`. `README.md`
tampoco: solo documenta `POST /api/contact` y `/api/health` y ya estaba
desactualizado respecto a artículos, leads e imágenes; ampliarlo sería un cambio
de otra feature (la fuente de verdad es `docs/api-contract.md`).

## Decisiones tomadas

1. **`PUBLIC_COLS` para la invariante I3.** Mismo patrón que `META_COLS` en
   `images.js` (feature 7): una lista fija de columnas
   (`id, email, name, role, created_at`) que usan **todas** las queries del CRUD
   en su `SELECT`/`RETURNING`. Cero `SELECT *` en `src/users.js` y en
   `src/usersRouter.js`. `findUserByEmail` **no se tocó**: sigue leyendo
   `password_hash` porque el login lo necesita, y ningún endpoint del CRUD la
   usa. Hay dos tests: uno de comportamiento (recorre el listado, el detalle, el
   `POST` y el `PATCH` comprobando `Object.keys` **y el texto crudo** de la
   respuesta, incluida la ausencia de cualquier `$2a$…` suelto y del password en
   claro) y uno estructural (parsea `PUBLIC_COLS` del fuente y verifica que la
   única query que lee el hash es la de `findUserByEmail`).
2. **La guarda del último admin va en una transacción, no en un `COUNT` previo.**
   Un `COUNT` suelto seguido de un `DELETE` es una condición de carrera: dos
   borrados concurrentes de dos admins distintos leen ambos "quedan 2" y la
   tabla acaba **sin ningún admin**, que es exactamente el estado que la guarda
   existe para impedir. Un único `DELETE … WHERE … AND (SELECT COUNT(*) …) > 1`
   tampoco basta: bajo `READ COMMITTED` cada transacción evalúa la subconsulta
   contra su propio snapshot y las filas afectadas son distintas, así que no se
   bloquean entre sí. Lo implementado en `deleteUser`:
   `BEGIN` → **una sola** sentencia de bloqueo
   `SELECT id, role FROM users WHERE role = 'admin' OR id = $2 ORDER BY id FOR UPDATE`
   → si el objetivo no está, `ROLLBACK` y `false` (404) → si el objetivo es
   admin, `countAdmins(client)` **dentro** de la transacción y con las filas ya
   bloqueadas → si `<= 1`, `last_admin` (409) → `DELETE` → `COMMIT`. Dos
   detalles deliberados: (a) bloquear en **una sola sentencia con `ORDER BY id`**
   evita el deadlock que aparecería bloqueando primero el objetivo y después el
   resto de admins (A esperaría a B y B a A, `40P01`); (b) la segunda
   transacción, al desbloquearse, reevalúa el `WHERE` sobre la versión nueva de
   las filas, ya no ve al admin borrado y rechaza. Está **ejercitado con dos
   `DELETE` HTTP concurrentes reales** (`Promise.all`, admins borrándose
   mutuamente): exactamente un `204` y un `409`, y siempre queda ≥ 1 admin.
3. **Por qué `countAdmins` recibe `pool` *o* un `client`.** Es lo que permite
   llamarla desde dentro de la transacción de `deleteUser` sin duplicar el SQL de
   "cuántos admins hay" ni dejarla como función muerta que solo usan los tests.
4. **Alcance real de la guarda (b) por HTTP.** Anotado porque es fácil leerlo
   como un hueco de cobertura y no lo es: por HTTP, "borrar al último admin" con
   un solo request es **inalcanzable**, porque quien llama ya tiene que ser
   `admin`; si el objetivo es otro admin, entonces hay ≥ 2, y si el objetivo es
   uno mismo salta primero la guarda (a). El camino real por el que la guarda (b)
   protege el sistema es la **carrera** del punto 2, y así está testeado. Además
   hay un test directo a la capa de datos (`deleteUser` rechaza con
   `code: 'last_admin'` cuando queda un solo admin, y la fila sobrevive), que es
   la única forma determinista de ejercitar ese `409` sin concurrencia.
5. **El hasheo se queda en la capa de datos.** `updateUser` recibe `password` en
   claro y lo re-hashea con el `SALT_ROUNDS = 12` que **ya existía** en
   `users.js` (no se redefine en ningún sitio: hay un test que afirma
   `__test__.SALT_ROUNDS === 12` y otros que comprueban el prefijo
   `$2[aby]$12$` del hash persistido). El router nunca llama a bcrypt. El
   `UPDATE` usa `password_hash = COALESCE($4::text, password_hash)`, así que un
   `PATCH` sin `password` **no toca el hash** (test explícito).
6. **Nada de contraseñas en los logs.** Los `catch` del `POST` y del `PATCH`
   loguean solo `err.code`/`err.message`, nunca el objeto de error completo ni
   el body (que llevaría el password en claro). Hay tests que comprueban que
   ninguna respuesta contiene el password enviado.
7. **`updateUser` es read-then-merge con lista de columnas fija**, igual que
   `updateImage`: no se construye un `SET` dinámico, así no hay dónde colar una
   interpolación. Hereda el mismo trade-off ya aceptado en la feature 7 (dos
   `PATCH` concurrentes sobre el mismo usuario podrían pisarse un campo); con un
   panel de un admin es aceptable y la alternativa es peor.
8. **Validación del `email`: presencia, no formato.** El acceptance pide `422`
   "si falta email o password" y `409` si choca; añadir una regex de formato
   sería un `422` no pedido y un cambio de contrato no documentado. Se normaliza
   a lowercase + trim (test) y se rechaza vacío/solo espacios.
9. **`role` es opcional en el `POST`** y cae al default `editor` (el mismo de la
   columna, replicado en la firma de `createUser`); si viene, debe ser
   `admin`|`editor` o `422 { error, field: 'role' }`. `createUser` valida también
   por su cuenta (`role_invalid`), así que un llamador de la capa de datos no
   puede colar un rol inventado.
10. **`parseId` reutilizado tal cual de `imagesRouter.js`** (regex `^\d{1,19}$`
    + comparación con `PG_BIGINT_MAX` por `BigInt`), para que un id no numérico o
    desbordado sea `404` y no un `500` por `22P02`/`22003`. Test para las tres
    rutas con `:id`, incluidos el límite exacto de `bigint` y el primer valor que
    lo excede. Es la tercera copia de la constante/función (`imagesRouter.js` y
    aquí): extraerla a un módulo compartido sería un refactor oportunista fuera
    de alcance (C12), igual que se decidió con `positiveNumberFromEnv` en la
    feature 7. **Anotado como deuda menor**, candidato para una feature de
    limpieza.
11. **Orden del listado: `id ASC`** (orden de creación, estable, sin
    desempates ambiguos). Documentado en `docs/api-contract.md`.
12. **Cero cambios de esquema, verificado con test**, no solo por revisión: la
    tabla `users` conserva exactamente sus 6 columnas, `src/db.js` no menciona
    `activo`, su único `ADD COLUMN` sobre `users` sigue siendo el `role` de la
    feature 15, las tablas creadas siguen siendo las 4 conocidas, y
    `ensureSchema` se corre una segunda vez con datos dentro para reconfirmar la
    idempotencia. `src/db.js` no se tocó (mtime anterior al inicio de esta
    sesión).
13. **Robustez de la suite (dos ajustes, ninguno relaja una aserción).** En una
    de las diez corridas completas apareció **un** fallo intermitente en
    `users.test.js`. Las dos causas plausibles eran del entorno de test, no del
    código, y se eliminaron las dos: (a) los tests que pagan varias operaciones
    bcrypt (12 rounds ≈ 300 ms cada una) pueden pasarse del `testTimeout` de 5 s
    de vitest con 12 archivos en paralelo → cada `describe` con trabajo real
    lleva `{ timeout: TIMEOUT_BCRYPT }` (20 s); (b) la suite hace ~10 logins
    reales y el default de `POST /api/auth/login` es 10 por IP cada 15 min, así
    que el último login iba al borde de un `429` espurio → se desactiva el rate
    limiter **solo en esta suite** con `createApp({ rateLimit: { auth: false } })`,
    que es precisamente para lo que existe esa opción de la factory (el rate
    limiting tiene su propia suite, `tests/ratelimit.test.js`, y sus defaults de
    producción no se tocan). Tras el cambio: 4 corridas completas seguidas en
    verde (10 en total durante la sesión).

14. **[Post-review] Hallazgo menor 2 del reviewer, atendido.** Los `catch` del
    `POST` y del `PATCH` loguaban solo `err?.code || err?.message`, con un
    comentario que lo justificaba diciendo "para no loguear el body, que llevaría
    el password". El reviewer tenía razón en las dos mitades: el resultado era
    correcto pero el razonamiento era falso (`console.error('…', err)` nunca
    incluye el body de la request) y el coste real era quedarse **sin traza**
    ante un error inesperado de Postgres, en contra de C8 e incoherente con los
    otros tres handlers del mismo archivo. Ahora los cinco loguean `err`
    completo y el comentario dice la verdad: la contraseña en claro no puede
    aparecer en la traza porque **nunca viaja a la base de datos** (a la query va
    su hash bcrypt, calculado antes). Verificado con un test nuevo
    (`ante un error inesperado de Postgres loguea la traza real y la contraseña
    en claro no aparece en ella`): provoca un `23514` real de Postgres en un
    schema efímero, captura `console.error` y comprueba que la traza lleva el
    código real (no `'error desconocido'`) y **no** la contraseña.
    **Residual documentado en el propio comentario del código:** en un error que
    haga que Postgres adjunte la fila (`detail`: "La fila que falla contiene
    (…)") se logueraría el **hash** de esa fila. Comprobado en vivo que ocurre
    con un `CHECK` violado. Hoy es inalcanzable: la única restricción de `users`
    es el `UNIQUE` de `email`, y ese caso (`23505`) se responde `409` antes de
    llegar al log. Queda escrito para quien añada una restricción nueva.

### Justificación del test actualizado (obligatoria)

`tests/articles.test.js` tenía `it('DELETE 403 con cookie editor (solo admin)')`,
que afirmaba el comportamiento **anterior** de
`DELETE /api/admin/articles/:id`. El humano decidió explícitamente que el rol
`editor` sí debe poder eliminar publicaciones (`feature_list.json`, feature 8,
`decision_humano` (a)), así que ese test ya no describe el contrato: se
**actualizó** a `it('DELETE 204 con cookie editor (el editor sí borra
publicaciones, feature 8)')`, comprobando además que la fila desaparece de la
BD. No se borró ningún test. Para que el endpoint no quede **menos** cubierto
que antes, se añadieron dos alrededor: `401` sin cookie (el artículo sigue
existiendo) y `404` con cookie de editor si el artículo no existe. El archivo
pasa de 13 a 15 tests. `tests/users.test.js` refuerza lo mismo desde el otro
lado (criterios 10 y 11): el editor completa el CRUD del blog, y sigue
recibiendo `403` en usuarios y en la escritura de imágenes.

Ningún otro test del repo afirmaba `403` para el editor en esa ruta
(verificado por `grep -rn "403" tests/`: los otros están en `roles.test.js`
—`requireRole` puro— y en `images.test.js` —escritura de imágenes—, y ambos
siguen pasando sin cambios).

### Mapeo criterio → test

| # | Criterio (resumen) | Archivo | `it()` |
|---|---|---|---|
| 1 | Los 5 endpoints bajo `/api/admin/users`, solo admin, sin ruta pública | `tests/users.test.js` | `los 5 endpoints están montados y responden como admin` · `no hay ninguna ruta pública de usuarios: /api/users responde 404` (+ criterio 9 para el "solo admin") |
| 2 | C7: el router no escribe SQL; la capa de datos amplía `users.js` sin romper lo existente | `tests/users.test.js` | `src/usersRouter.js no escribe SQL` · `src/users.js no importa express ni toca req/res` · `src/users.js parametriza todo valor de usuario e interpola solo `schema` y las columnas (C4)` · `conserva createUser/findUserByEmail/verifyPassword y añade listUsers/getUserById/updateUser/deleteUser/countAdmins` · `las funciones nuevas funcionan también llamadas directamente (capa de datos usable sin HTTP)` |
| 3 | **I3**: `password_hash` nunca sale; cero `SELECT *` | `tests/users.test.js` | `no aparece en el listado, ni en el detalle, ni en el POST, ni en el PATCH (tampoco en el texto crudo)` · `PUBLIC_COLS no incluye password_hash y ninguna query del CRUD hace SELECT *` · `findUserByEmail sigue devolviendo password_hash a propósito (el login lo necesita)` |
| 4 | Listado con `id, email, name, role, created_at`; detalle o 404 | `tests/users.test.js` | `el listado devuelve id, email, name, role y created_at` · `el detalle devuelve un usuario` · `404 si el id no existe` · `404 (no 500) si el id no es numérico o desborda el rango de bigint` |
| 5 | `POST` 201 / 409 / 422 (email, password, role) | `tests/users.test.js` | `201 con email, password, name y role` · `sin role explícito cae al default `editor`` · `la contraseña se persiste hasheada con bcrypt (SALT_ROUNDS=12) y sirve para loguearse` · `normaliza el email a lowercase + trim` · `409 { error } si el email ya existe` · `422 { error, field } si falta email` · `422 { error, field } si falta password` · `422 { error, field } si el role no es uno de ROLES` |
| 6 | `PATCH` de email/name/role/password; 404 / 409 / 422 | `tests/users.test.js` | `cambia email, name y role` · `cambia la contraseña de otro usuario: la vieja deja de servir y la nueva funciona (re-hash bcrypt 12)` · `un PATCH sin password no toca el hash existente` · `404 si el usuario no existe` · `409 si el email nuevo choca con otro usuario` · `422 si el role es inválido` · `422 { error } si el body no trae ningún campo editable` |
| 7 | `DELETE` 204 + las dos guardas 409 + 404 | `tests/users.test.js` | `204 sin body y la fila desaparece de la BD (borrado físico)` · `404 si el usuario no existe` · `guarda (a): 409 si un admin intenta borrarse a sí mismo, y sigue existiendo` · `guarda (b): borrar un admin sí se permite mientras quede otro admin` · `guarda (b): no se puede borrar al último admin (last_admin) y la fila sobrevive` · `guarda (b) bajo concurrencia: dos admins borrándose a la vez no pueden dejar el sistema sin ningún admin` |
| 8 | **Crítico**: borrar al autor no borra el artículo (`author_id` → NULL) | `tests/users.test.js` | `el artículo sobrevive y su author_id queda en NULL (ON DELETE SET NULL)` |
| 9 | 401 sin cookie y 403 con `editor` en todas las rutas | `tests/users.test.js` | `401 sin cookie de sesión en las 5 rutas` · `403 con rol editor en las 5 rutas (gestionar usuarios es solo de admin)` |
| 10 | El `editor` elimina publicaciones; doc actualizada; test existente actualizado | `tests/articles.test.js` | `DELETE 204 con cookie editor (el editor sí borra publicaciones, feature 8)` · `DELETE sigue exigiendo sesión: 401 sin cookie` · `DELETE 404 con cookie editor si el artículo no existe` |
| 10 | (refuerzo desde la suite nueva) | `tests/users.test.js` | `204 al borrar un artículo con cookie de editor, y la fila desaparece` · `el editor completa el CRUD del blog: ver, crear, editar y eliminar` · `el guard del DELETE de artículos admite admin y editor en el código` · `docs/api-contract.md documenta ese DELETE como admin, editor` |
| 11 | El `editor` no gana permisos fuera del blog | `tests/users.test.js` | `sigue recibiendo 403 en las rutas de escritura de imágenes (feature 7)` · `sigue recibiendo 403 en el mantenedor de usuarios` · `leads: el editor solo lee (no existe ningún DELETE de leads que pueda ganar)` · `el rol editor sigue siendo el default de la columna `role`` |
| 12 | Cero cambios en el esquema | `tests/users.test.js` | `la tabla users conserva exactamente sus 6 columnas (ni `activo` ni nada nuevo)` · `src/db.js no añade DDL para esta feature (sin columna `activo`, sin tabla nueva)` · `ensureSchema sigue siendo idempotente con datos dentro` |
| 13 | Documentación (`api-contract`, `architecture`, `database`) | `tests/users.test.js` | `docs/api-contract.md documenta los 5 endpoints de usuarios` · `docs/architecture.md y docs/database.md explican el modelo de roles y la invariante I3` |
| 14 | `npm test` verde, sin borrar ni skipear tests | — | Es la corrida completa (ver "Verificación"); `grep -rn "\.skip\|\.todo\|xit(\|\.only" tests/` sin resultados |

**Extra (post-review, C8):**
`ante un error inesperado de Postgres loguea la traza real y la contraseña en
claro no aparece en ella` (`tests/users.test.js`, dentro del criterio 5).

**Extra fuera del acceptance pero exigido por `CHECKPOINT.md`:** invariante **I5**
(el rol se recarga de la DB en cada request) →
`invariante I5: el rol nuevo se aplica en la siguiente request del usuario`
(promueve a admin y degrada a editor con la **misma cookie**, sin re-login, y
comprueba el cambio en la request siguiente y en `GET /api/auth/me`).

## Bloqueos

Ninguno.

## Variables de entorno nuevas

> Solo **nombre y propósito**. Nunca valores.

Ninguna. Esta feature no introduce configuración nueva, y no se leyó ni se
escribió ningún valor de `.env` en toda la sesión.

## Verificación

```
pg_isready                → /var/run/postgresql:5432 - aceptando conexiones

npm test   (corrida final, tras el arreglo del hallazgo menor 2)
Test Files  12 passed (12)
     Tests  221 passed (221)

Reparto: contact 17 · email 9 · articles 15 · auth 17 · leads 14 · phone 8 ·
roles 13 · roles.schema 2 · app 7 · ratelimit 17 · images 49 · users 53

npm run test:no-db
Test Files  3 passed (3)
     Tests  30 passed (30)
```

- Baseline previo: 11 archivos / 166 tests → ahora **12 / 221** (+53 del archivo
  nuevo, +2 netos en `articles.test.js`). **Ningún test eliminado ni marcado
  `skip`**: `grep -rn "\.skip\|\.todo\|xit(\|\.only" tests/` no devuelve nada.
  El reviewer verificó 220 antes del arreglo del menor 2; el +1 es el test nuevo
  de la traza de error.
- 4 corridas completas seguidas en verde tras el ajuste de robustez (10 corridas
  en la sesión, 1 fallo intermitente antes del ajuste; ver decisión 13).
- `npm run test:no-db` sigue en 3 archivos / 30 tests: `users.test.js` necesita
  Postgres y no entra en el subconjunto en seco.
- Sin schemas de test huérfanos:
  `psql -d maia-landing -Atc "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'maia_test_%'"`
  → vacío.
- `git status` sin archivos temporales. **No se commiteó ni pusheó nada**: el
  humano autorizó commitear esta feature, pero lo hace el líder tras el cierre
  (hallazgo menor 7 del review, que por tanto ya no aplica como incumplimiento).
  Rama y commit sugeridos: `feat/8-crud-usuarios` ·
  `feat(users): CRUD de usuarios y roles del panel`.
- Sin `console.log` de debug nuevos en `src/` (los únicos son los `[startup]` y
  `[mail]` preexistentes).

## Review

**APPROVED sin bloqueantes** — `progress/review_8.md`. El reviewer reprodujo en
vivo la carrera del último admin con dos `DELETE` concurrentes reales y confirmó
que la transacción con `SELECT … ORDER BY id FOR UPDATE` la cierra, y auditó las
siete queries de `src/users.js` una a una para I3.

De sus 7 hallazgos menores se atendió **solo el 2** (traza de los `catch` del
`POST`/`PATCH`, ver decisión 14), por indicación del líder. Los demás quedan
anotados a propósito:

- **Menor 1 — hueco real de la especificación, no de la implementación:** el
  último admin puede auto-degradarse con `PATCH { role: 'editor' }` y dejar el
  sistema con cero admins, en un solo request y sin concurrencia. El
  `acceptance` de esta feature solo pedía las dos guardas del `DELETE`, y ni
  `docs/api-contract.md` ni `docs/architecture.md` prometen más que eso (sin
  discrepancia doc↔código). Meterlo aquí habría sido scope creep (C12). **El
  líder lo abre como feature de seguimiento**: guarda `last_admin` en
  `updateUser`, dentro de la misma transacción con `FOR UPDATE` que ya existe en
  `deleteUser`.
- **Menor 3:** `domainError('email_required')` de `updateUser` no está mapeado
  en el `catch` del `PATCH` (daría 500 en vez de 422). Inalcanzable por HTTP —
  el router rechaza el email vacío antes—; deuda latente para quien llame a la
  capa de datos desde otro sitio.
- **Menor 4:** `String(body.email)` convierte un objeto en `"[object Object]"`.
  Coherente con la decisión 8 (validar presencia, no formato) y con el
  `createUser` preexistente; no es una regresión.
- **Menor 5:** `updateUser` es read-then-merge sin transacción (lost update con
  dos `PATCH` concurrentes). Mismo trade-off ya aceptado en `updateImage`.
- **Menor 6:** tercera copia de `parseId`/`PG_BIGINT_MAX`. Extraerla habría sido
  un refactor oportunista (C12); junto con las tres de `positiveNumberFromEnv`,
  material para una feature de limpieza.
- **Menor 7 (C15):** ya no aplica — el humano autorizó commitear; el commit lo
  hace el líder al cerrar.

**Estado final:** feature 8 marcada `done` (`closed: 2026-07-30`) en
`feature_list.json` tras el APPROVED, y este resumen movido a
`progress/history.md`.
