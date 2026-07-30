# Arquitectura — MaIA Landing Back

Backend Node.js (Express + PostgreSQL) que da servicio a la landing de MaIA:
captura de leads del formulario de contacto/demo, envío de correos
transaccionales, y un panel admin (auth + CRUD de artículos + consulta de leads).

- **Paquete:** `maia-landing-server` v1.3.0
- **Runtime:** Node 22 (`.node-version`), ESM (`"type": "module"`)
- **Deploy:** Render (`render.yaml`, plan free, servicio `maia-api`)
- **Repos hermanos:** `../maia-landing-front` (SPA), `../maia-landing`

---

## 1. Vista general

```
┌─────────────────┐        HTTPS + cookie          ┌──────────────────────┐
│  SPA (Vercel)   │ ─────────────────────────────► │  Express app         │
│  maia-landing-  │ ◄───────────────────────────── │  (Render: maia-api)  │
│  front          │      JSON / Set-Cookie          └──────────┬───────────┘
└─────────────────┘                                            │
                                                    ┌──────────┴──────────┐
                                                    │                     │
                                             ┌──────▼──────┐      ┌───────▼────────┐
                                             │ PostgreSQL  │      │ Email provider │
                                             │ (pg Pool)   │      │ SMTP o Resend  │
                                             └─────────────┘      └────────────────┘
```

El servidor no renderiza vistas: es una API JSON pura. El único HTML que produce
son las plantillas de correo (`src/email.js`).

---

## 2. Estructura de archivos

```
maia-landing-back/
├── src/
│   ├── server.js          # Entry point: valida env, ensureSchema, listen
│   ├── app.js             # Factory createApp(): middlewares, /api/health, /api/contact
│   ├── db.js              # createPool, ensureSchema (migraciones idempotentes), insertLead
│   ├── asyncHandler.js    # asyncHandler(fn): reenvía a next(err) el rechazo de un handler/middleware async
│   ├── rateLimit.js       # createRateLimiter(): rate limit en memoria (ventana fija), reloj inyectable
│   ├── email.js           # createMailer(): SMTP (nodemailer) o Resend HTTP + plantillas HTML
│   ├── phone.js           # detectCountry(): E.164 → { iso, name }
│   ├── auth.js            # createAuthRouter(): login/logout/me + requireAuth (JWT en cookie)
│   ├── users.js           # Capa de datos `users` (SQL) + bcrypt: login (createUser,
│   │                      # findUserByEmail, verifyPassword) y CRUD (listUsers,
│   │                      # getUserById, updateUser, deleteUser, countAdmins)
│   ├── usersRouter.js     # Rutas admin del mantenedor de usuarios (solo rol admin)
│   ├── roles.js           # ROLES, hasRole, requireRole() middleware
│   ├── articles.js        # Capa de datos `articles` (SQL puro) + slugify
│   ├── articlesRouter.js  # Rutas públicas y admin de artículos
│   ├── leads.js           # Capa de datos `leads` lectura (listLeads, getLeadById)
│   ├── leadsRouter.js     # Rutas admin de leads
│   ├── images.js          # Capa de datos `images` (SQL) + whitelist/sniff de MIME
│   └── imagesRouter.js    # Rutas públicas (metadatos + /raw) y admin de imágenes
├── scripts/
│   ├── create-user.js     # CLI: crea un usuario
│   └── seed-users.js      # CLI: asegura el admin inicial (MAIA_ADMIN_EMAIL/PASSWORD)
├── tests/                 # vitest + supertest, 12 archivos (ver §11)
├── docs/                  # Documentación viva (este archivo, context, conventions,
│   │                      # verification, database, api-contract) + images/ (logos de correo)
│   └── images/            # logo-maia / isotipo-maia (.png y .svg) — adjuntos CID
├── progress/              # current.md (sesión en curso) + history.md (bitácora)
├── AGENTS.md              # Mapa de navegación para agentes
├── CLAUDE.md              # Rol y reglas de la sesión de Claude Code
├── CHECKPOINT.md          # Criterios objetivos de "estado final correcto"
├── feature_list.json      # Backlog con estado por feature
├── .claude/agents/        # Subagentes: leader, implementer, reviewer
├── .agents/skills/        # Skills externas (symlinkeadas desde .claude/skills/)
├── dev-fullstack.js       # Dev-only: sirve client/dist + API en el mismo puerto
├── render.yaml            # Blueprint de Render
├── .env.example           # Documentación de todas las variables
└── package.json
```

### Patrón dominante: **factory functions con inyección de dependencias**

Ningún módulo lee `process.env` en tiempo de import ni crea singletons globales.
Todo se construye vía factory que acepta overrides:

```js
createApp({ pool, schema, mailer, corsOrigin, authSecret, auth, rateLimit, trustProxy, images })
createAuthRouter({ pool, schema, secret, cookieSecure, rateLimiter })
createArticlesRouter({ pool, schema, requireAuth })
createLeadsRouter({ pool, schema, requireAuth })
createUsersRouter({ pool, schema, requireAuth })
createImagesRouter({ pool, schema, requireAuth, maxFileSize })
createMailer({ host, port, user, pass, from, to, transporter, resendClient })
createRateLimiter({ windowMs, max, now, keyGenerator })
```

Esto es lo que permite que los tests levanten la app completa contra un schema
Postgres efímero y un mailer falso, sin monkey-patching.

### Separación datos / HTTP

`articles.js`, `leads.js`, `images.js` y `users.js` contienen **solo SQL** (más
helpers puros: `slugify` en el primero, la whitelist de MIME y `sniffMime` en el
tercero, `isValidRole` y el hasheo bcrypt en el cuarto);
`articlesRouter.js`, `leadsRouter.js`, `imagesRouter.js` y `usersRouter.js`
contienen **solo HTTP** (validación, status codes, logging). `db.js` mantiene el
DDL y el insert de leads. Nota: la escritura de leads (`insertLead`) vive en
`db.js`, no en `leads.js` — `leads.js` es solo lectura.

---

## 3. Arranque (`src/server.js`)

1. Carga `dotenv/config`.
2. **Validación temprana**: si falta `DATABASE_URL` o `AUTH_SECRET` → log de error
   y `process.exit(1)`. Evita que Render arranque un proceso a medio configurar.
3. `createApp()` construye pool, mailer y todos los routers.
4. `ensureSchema(pool, { schema })` — migraciones idempotentes; si falla, log con
   el `code` de Postgres y `exit(1)`.
5. `app.listen(PORT || 3001)`.

`dev-fullstack.js` es una variante de desarrollo que monta la SPA construida
(`../client/dist`) más la API en un solo puerto, con fallback SPA a `index.html`
para cualquier GET que no empiece por `/api`.

---

## 4. Pipeline de middlewares (`src/app.js`)

Orden exacto, importa:

```
app.set('trust proxy', 1)
express.json({ limit: '32kb' })
express.urlencoded({ extended: false, limit: '32kb' })
cookieParser()
cors({ origin, credentials: true })
authRouter          → /api/auth/* (POST /api/auth/login con rate limit propio)
articlesRouter      → /api/articles*, /api/admin/articles*
leadsRouter         → /api/admin/leads*
usersRouter         → /api/admin/users*  (solo rol admin)
imagesRouter        → /api/images*, /api/admin/images* (multer por ruta, no global)
GET  /api/health
POST /api/contact   (con rate limit propio)
catch-all 404 JSON
errorHandler (err, req, res, next)
```

**Body parsers**: `express.json`/`express.urlencoded` van con `limit: '32kb'`
globales, pero **no** tocan `multipart/form-data`. El único endpoint que acepta
multipart es `POST /api/admin/images` y su parser (multer, `memoryStorage`) se
monta **solo en esa ruta**, nunca de forma global: así ninguna otra ruta puede
recibir un upload por accidente, y el límite de tamaño de las imágenes (§7.1) es
independiente del límite de 32 kb del JSON.

**CORS**: `CORS_ORIGIN=*` → `origin: true` (refleja el origen, necesario para que
`credentials: true` funcione). Con valor concreto se hace `split(',')` para
soportar múltiples orígenes.

**`trust proxy`**: Render (`render.yaml`, plan free) coloca exactamente un
reverse proxy delante del proceso. `app.set('trust proxy', 1)` hace que
Express confíe en un único hop de `X-Forwarded-For` — usa la IP que ese proxy
añadió (la real del cliente) e ignora cualquier IP que el propio cliente haya
intentado inyectar por delante en la cabecera. Sin esto, `req.ip` sería
siempre la IP del proxy de Render para todo el tráfico, y un rate limit por
IP bloquearía a todos los usuarios a la vez que a un único abusador (falso
positivo global). `trust proxy: true` (confiar en toda la cadena) sí sería
explotable: un cliente podría spoofear su IP con su propio
`X-Forwarded-For` antepuesto al que añade el proxy real. `1` es el valor
estándar recomendado por Express para apps detrás de exactamente un reverse
proxy (Render/Heroku/Railway/Vercel). Si en el futuro se añade otro proxy/CDN
delante (p. ej. Cloudflare), este valor tendría que subir a `2` — no hace
falta ningún cambio en `render.yaml` para el valor actual, Render ya añade
`X-Forwarded-For` de forma nativa.

**Rate limiting** (`src/rateLimit.js`, feature 3): `createRateLimiter({
windowMs, max, now, keyGenerator })` es un contador de ventana fija en
memoria (`Map<key, {count, resetAt}>`), sin dependencias externas (Render
free es un solo proceso, no hace falta Redis). `now` es inyectable (default
`Date.now`) para que los tests simulen el paso del tiempo sin `setTimeout`
reales. `keyGenerator` por defecto usa `req.ip` (que respeta `trust proxy`).
Se aplica solo a dos rutas — `POST /api/contact` (montado en `createApp`) y
`POST /api/auth/login` (inyectado en `createAuthRouter` vía la opción
`rateLimiter`) — nunca de forma global, así que `/api/health`,
`/api/auth/me`, `/api/articles*` y las rutas admin no se ven afectadas.
Al superar `max` responde `429 { "error": "<mensaje genérico>" }`, sin
cabeceras `RateLimit-*` ni `Retry-After` (filtrarían cuánto intentos quedan
o cuándo reintentar). Configurable por env
(`CONTACT_RATE_LIMIT_WINDOW_MS`/`MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`/`MAX`, ver
§12) o inyectable/desactivable por la factory:
`createApp({ rateLimit: { contact: {...} | false, auth: {...} | false } })`.

*Evicción del `Map`*: cada clave (IP) crea una entrada `{ count, resetAt }`
que nunca se borra en el instante en que expira — no hay `setTimeout` por
entrada (se evitó a propósito: un timer por IP sería una fuga de handles, y
un único `setInterval` global dejaría un timer vivo que complica el cierre
limpio del proceso, y de los tests). En su lugar, el barrido es perezoso y
gatillado por tamaño (`pruneExpired`/`maybeSweep`, `src/rateLimit.js`): en
cada request no bloqueada, si `hits.size >= SWEEP_THRESHOLD` (constante
interna, `5000`), se recorre el `Map` entero y se borran todas las entradas
con `resetAt <= t`. Por debajo de ese umbral las entradas expiradas quedan en
memoria hasta que la misma clave vuelva a usarse (se sobreescribe al
comprobar `entry.resetAt <= t`) o el `Map` crezca lo bastante como para
disparar el barrido. Trade-off elegido: memoria acotada en el peor caso
(como mucho `SWEEP_THRESHOLD` objetos pequeños — del orden de cientos de KB,
trivial para el plan free de Render) a cambio de no liberar memoria de forma
proactiva por debajo del umbral. Para un único servicio de landing con tráfico
bajo/medio esto es aceptable; si el tráfico único (IPs distintas por
ventana) creciera muy por encima de miles de forma sostenida, valdría la pena
bajar `SWEEP_THRESHOLD` o añadir un barrido periódico real. Testeado en
`tests/ratelimit.test.js` (describe `"createRateLimiter — poda del Map
(__internals)"`) llamando al middleware directamente (sin HTTP) para poder
forzar tanto `pruneExpired` de forma aislada como el cruce real de
`SWEEP_THRESHOLD` sin pagar el coste de miles de requests reales;
`createRateLimiter(...).__internals` expone `{ hits, pruneExpired,
SWEEP_THRESHOLD }` solo para eso — no forma parte de la API pública que usa
`createApp`.

**Manejo de errores**: `errorHandler` (`src/app.js`) es el último `app.use`,
después del catch-all 404. Responde siempre JSON —
`500 { "error": "Error interno del servidor" }` —, nunca el HTML por defecto
de Express, y nunca expone stack ni detalle real (eso va al log con prefijo
`[app]`). Si `res.headersSent`, delega en el handler por defecto de Express
vía `next(err)`. Cada handler sigue teniendo su propio `try/catch` para sus
casos de negocio conocidos (mensajes específicos, códigos 4xx); `errorHandler`
es la red de seguridad para lo que quede fuera de esos bloques.

Un `throw` síncrono en un handler llega solo a `errorHandler` (Express 4 lo
reenvía automáticamente), pero un rechazo de promesa dentro de un handler o
middleware `async` **no** — hay que reenviarlo explícitamente. Por eso **todo**
handler/middleware `async` registrado en un router está envuelto con
`asyncHandler` (`src/asyncHandler.js`, ver `docs/conventions.md` §7): 13
handlers de ruta más el middleware `requireAuth`, repartidos entre `app.js`,
`auth.js`, `articlesRouter.js` y `leadsRouter.js`.

---

## 5. Endpoints

### Públicos

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET`  | `/api/health` | `SELECT 1` contra la DB → `{ ok, db, mailer }`. 503 si la DB falla |
| `POST` | `/api/contact` | Crea un lead y dispara los dos correos |
| `GET`  | `/api/articles` | Lista artículos `published` (limit 1–50, default 20) |
| `GET`  | `/api/articles/:slug` | Artículo publicado por slug; 404 si es draft |
| `GET`  | `/api/images` | Metadatos de imágenes (sin `bytes`), filtro `?seccion=`, orden `orden ASC` |
| `GET`  | `/api/images/:id/raw` | El binario con su `Content-Type` real; 404 si no existe |

### Auth

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/auth/login` | `{ email, password }` → cookie `maia_session` + `{ ok, user }` |
| `POST` | `/api/auth/logout` | Borra la cookie |
| `GET`  | `/api/auth/me` | Usuario actual o 401 |

### Admin (requieren cookie válida)

| Método | Ruta | Roles |
|--------|------|-------|
| `GET`    | `/api/admin/articles` | admin, editor |
| `GET`    | `/api/admin/articles/:id` | admin, editor |
| `POST`   | `/api/admin/articles` | admin, editor |
| `PATCH`  | `/api/admin/articles/:id` | admin, editor |
| `DELETE` | `/api/admin/articles/:id` | admin, editor (desde la feature 8) |
| `GET`    | `/api/admin/leads` | admin, editor |
| `GET`    | `/api/admin/leads/:id` | admin, editor |
| `GET`    | `/api/admin/users` | **admin** únicamente |
| `GET`    | `/api/admin/users/:id` | **admin** únicamente |
| `POST`   | `/api/admin/users` | **admin** únicamente |
| `PATCH`  | `/api/admin/users/:id` | **admin** únicamente |
| `DELETE` | `/api/admin/users/:id` | **admin** únicamente |
| `POST`   | `/api/admin/images` | **admin** únicamente (multipart/form-data) |
| `PATCH`  | `/api/admin/images/:id` | **admin** únicamente |
| `DELETE` | `/api/admin/images/:id` | **admin** únicamente |

---

## 6. Flujo `POST /api/contact`

Es el camino crítico del negocio.

```
body → normalizePhone (quita espacios, guiones, paréntesis)
     → validación
     → detectCountry(telefono)         [libphonenumber-js + Intl.DisplayNames('es')]
     → insertLead()                     ── falla → 500, corta aquí
     → mailer.sendLead(lead, id)        ── falla → se captura, NO corta
     → log estructurado [mail] por destinatario
     → 201 { ok: true, id }
```

### Reglas de validación

- `email` siempre obligatorio (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`), si no → **422**.
- `tipo` ∈ `{demo, email, contacto}`; cualquier otro valor cae a `demo`.
- **Flujo email-only** (`tipo === 'email'`, usado por el CTA final y la calculadora
  ROI): no exige `nombre` ni `telefono`.
- Resto de flujos: `nombre` obligatorio y `telefono` en E.164 (`/^\+\d{7,15}$/`).
- Todos los campos se truncan antes de persistir (nombre/empresa/industria 120,
  telefono 40, pais 80, pais_iso 4, mensaje 2000).

### Política de errores

La persistencia es bloqueante; el correo es **best-effort**. Si el mail falla,
el lead ya está guardado y el cliente recibe `201`. El estado interno del envío
**no se expone** en la respuesta — solo va a los logs con prefijo `[mail]`,
una línea por destinatario (`sales` y `user`) con `status`, `messageId`/`code` y
`reason`.

---

## 7. Persistencia

`pg.Pool` (`max: 10`, `idleTimeoutMillis: 30000`). `PGSSL=true` activa
`ssl: { rejectUnauthorized: false }` — necesario en Render/Neon/Supabase.

`ensureSchema()` corre en cada arranque y es idempotente: `CREATE SCHEMA IF NOT
EXISTS`, `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`. No hay herramienta de migraciones externa; el DDL
vive todo en `db.js`. El `ALTER TABLE users ADD COLUMN role` está envuelto en
try/catch que traga el código `42P01` (undefined_table) para tolerar un orden de
features parcial.

### Esquema

**`leads`**
| columna | tipo |
|---|---|
| `id` | BIGSERIAL PK |
| `nombre`, `empresa`, `telefono`, `pais`, `pais_iso`, `industria`, `mensaje` | TEXT |
| `email` | TEXT NOT NULL |
| `tipo` | TEXT NOT NULL DEFAULT `'demo'` |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() |

Índices: `leads_email_idx (email)`, `leads_created_at_idx (created_at DESC)`.

**`users`**
| columna | tipo |
|---|---|
| `id` | BIGSERIAL PK |
| `email` | TEXT UNIQUE NOT NULL (siempre lowercase) |
| `password_hash` | TEXT NOT NULL (bcrypt, 12 rounds) |
| `name` | TEXT |
| `role` | TEXT NOT NULL DEFAULT `'editor'` |
| `created_at` | TIMESTAMPTZ |

Índice: `users_email_idx (email)`.

> **Invariante I3:** `password_hash` **nunca** sale por la API. `src/users.js`
> mantiene la lista fija `PUBLIC_COLS` (`id, email, name, role, created_at`) que
> usan todas las queries del CRUD de usuarios; la única que lee el hash es
> `findUserByEmail`, para el login. Ver §8.1.

**`articles`**
| columna | tipo |
|---|---|
| `id` | BIGSERIAL PK |
| `slug` | TEXT UNIQUE NOT NULL |
| `title` | TEXT NOT NULL |
| `excerpt`, `cover_url` | TEXT |
| `body_md` | TEXT NOT NULL (Markdown; se renderiza en el front) |
| `status` | TEXT NOT NULL DEFAULT `'draft'` (`draft` \| `published`) |
| `author_id` | BIGINT → `users(id)` ON DELETE SET NULL |
| `published_at`, `created_at`, `updated_at` | TIMESTAMPTZ |

Índices: `articles_status_idx (status, published_at DESC)`, `articles_slug_idx (slug)`.

`published_at` se setea automáticamente en la primera transición
`draft → published` y no se reescribe en publicaciones posteriores.
El orden de listado es `COALESCE(published_at, updated_at) DESC, id DESC`.

**`images`** (feature 7)
| columna | tipo |
|---|---|
| `id` | BIGSERIAL PK |
| `seccion` | TEXT NOT NULL (`hero` \| `cta_final`) |
| `filename` | TEXT NOT NULL (nombre original saneado) |
| `mime_type` | TEXT NOT NULL (el **detectado**, no el declarado) |
| `bytes` | BYTEA NOT NULL (el binario de la imagen) |
| `size_bytes` | INTEGER NOT NULL DEFAULT `0` |
| `alt` | TEXT |
| `orden` | INTEGER NOT NULL DEFAULT `0` |
| `created_at`, `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() |

Índice: `images_seccion_orden_idx (seccion, orden)`. Orden de listado:
`orden ASC, id ASC`.

El binario vive **en Postgres**, no en disco ni en un proveedor externo:
decisión explícita del humano (`feature_list.json`, feature 7,
`decision_humano`) porque el filesystem de Render es efímero — un archivo
escrito en disco se pierde en cada deploy — y S3/Cloudinary exigiría
credenciales nuevas que hoy no existen. Se acepta el peso en la BD.

> **Invariante, análoga a I3 (`password_hash`):** `bytes` **nunca** sale por la
> API en JSON. `src/images.js` mantiene dos listas de columnas — `META_COLS`
> (sin `bytes`) para todo listado/detalle y `RAW_COLS` (con `bytes`) usada solo
> por `getImageWithBytes()`, que a su vez solo la llama
> `GET /api/images/:id/raw`. Cualquier query nueva usa `META_COLS`.

### 7.1 Validación de imágenes subidas — y por qué SVG está excluido

Whitelist de MIME: **`image/png`, `image/jpeg`, `image/webp`**.

**SVG está excluido a propósito, y no es una omisión que haya que "arreglar".**
Un SVG no es un bitmap: es un documento XML que el navegador ejecuta. Puede
contener `<script>`, atributos `onload`/`onerror`, `<foreignObject>` con HTML, o
`xlink:href="javascript:…"`. `GET /api/images/:id/raw` sirve el binario **en
crudo, con su propio `Content-Type`, desde el origen de la API** — así que un
SVG subido y luego abierto en una pestaña ejecutaría su script en el origen del
backend: **XSS almacenado**, con acceso al contexto donde vive la cookie de
sesión del panel. Aceptar SVG obligaría a sanitizarlo (parsear XML y filtrar
elementos/atributos peligrosos, con las evasiones que eso arrastra) o a servirlo
siempre con `Content-Disposition: attachment` y `Content-Type:
application/octet-stream`, que es exactamente lo contrario de lo que necesita el
front. Ninguna de las dos cosas se paga para tres imágenes de landing. Si algún
día hace falta un logo vectorial, se decide **entonces**, con su propia feature
y su sanitizador.

La validación del MIME es de **tres capas**, porque el `mimetype` que entrega
multer es el `Content-Type` que declara el cliente en la parte multipart y es
trivialmente falsificable:

1. **MIME declarado** ∈ whitelist (`fileFilter` de multer) → si no, `415`.
2. **Extensión del `filename`** coherente con ese MIME (`.png` / `.jpg`|`.jpeg`
   / `.webp`, en el mismo `fileFilter`) → si no, `415`.
3. **Magic bytes del buffer real** (`sniffMime()` en `src/images.js`: firma PNG
   de 8 bytes, `FF D8 FF` de JPEG, `RIFF….WEBP` de WebP) y que coincidan con el
   MIME declarado → si no, `415`. Es la única capa que el cliente no puede
   falsear sin subir de verdad una imagen de ese formato. Lo que se persiste en
   `mime_type` es el MIME **detectado**, no el declarado.

Además, `filename` se sanea antes de persistir (solo el basename, sin
caracteres de control ni comillas) y `/raw` responde con
`X-Content-Type-Options: nosniff` para que el navegador no reinterprete el
cuerpo como HTML/JS.

**Límite de tamaño**: `limits.fileSize` de multer, default **5 MB** activo sin
configurar nada, override por `IMAGES_MAX_FILE_SIZE_BYTES` (§12) o por la
opción `images.maxFileSize` de `createApp` — mismo criterio que el rate
limiting (defaults activos + inyección por factory). El almacenamiento es
`memoryStorage`: el binario nunca toca el disco, va directo del buffer a la
columna BYTEA. Al superarse el límite multer emite un `MulterError`
(`LIMIT_FILE_SIZE`) que el router **atrapa explícitamente** y traduce a
`413 { error, field: 'file' }` JSON; sin ese wrapper el error acabaría como un
`500` genérico en `errorHandler`.

### Multi-tenancy por schema

`DB_SCHEMA` (default `public`) se interpola directamente en las queries como
`"${schema}".tabla`. **No es un parámetro** — proviene de env o del código, nunca
de input de usuario. Este mecanismo es el que usan los tests para aislarse
(`maia_test_<timestamp>_<random>`, `DROP SCHEMA ... CASCADE` al terminar).
Todos los valores de usuario sí van parametrizados (`$1, $2, ...`).

---

## 8. Autenticación y autorización

**Sesión:** JWT HS256 en cookie `httpOnly` llamada `maia_session`, 7 días.

```js
{ httpOnly: true,
  sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
  secure:   NODE_ENV === 'production',
  path: '/', maxAge: 7d }
```

`SameSite=none` + `Secure` es obligatorio para el escenario cross-origin real
(SPA en Vercel → API en Render). En desarrollo cae a `lax` sin `Secure` para que
funcione en `http://localhost`.

**Payload del token:** `{ sub: userId, email }`. El token no lleva el rol: en cada
request `requireAuth` recarga el usuario desde la DB, así un cambio de rol o un
borrado surten efecto inmediato sin esperar la expiración.

`resolveSecret()`: usa `AUTH_SECRET`; si falta, genera uno aleatorio por proceso y
avisa (las sesiones no sobreviven a un reinicio). En producción `server.js` ya
aborta antes si `AUTH_SECRET` no está.

**Renovación de sesión** (feature 5): el JWT de 7 días no se renueva solo con
el paso del tiempo — sin esto, al expirar el usuario del panel es expulsado
sin aviso a mitad de una sesión de trabajo activa. Cada request autenticada
(`requireAuth`, usado por todas las rutas `/api/admin/*`, y `GET
/api/auth/me`) decodifica el `exp` del token ya verificado y, si le queda
menos de `AUTH_REFRESH_WINDOW_MS` (default 1 día, ver §12) para expirar,
re-emite la cookie `maia_session` con un token nuevo (7 días completos de
nuevo) usando **exactamente las mismas opciones** que construye
`cookieOptions()` para el login (`httpOnly`, `sameSite`, `secure`, `path`) —
se reutiliza el mismo objeto `cookieOpts`, nunca se reconstruye, precisamente
para no arriesgar la invariante I6 (`SameSite=None; Secure` en producción).
Fuera de esa ventana no se toca la cookie: no hay `Set-Cookie` en cada
request, solo cuando el token está a punto de expirar. Un token ya expirado
nunca se renueva — `verifyToken`/`jwt.verify` ya lo rechaza antes de llegar a
la lógica de renovación, así que sigue respondiendo `401` tal cual.
`POST /api/auth/login` (ya emite una cookie fresca) y `POST /api/auth/logout`
(borra la cookie) no pasan por esta lógica. `createAuthRouter` acepta un
reloj inyectable (`now`, default `Date.now`) usado solo para decidir si el
token está dentro de la ventana — no afecta a la expiración real del token
nuevo, que se sigue firmando con `expiresIn: '7d'` real; existe para que los
tests controlen la decisión de forma determinista sin `setTimeout` ni
esperas reales (`tests/auth.test.js`, describe `"Renovación de sesión
(feature 5)"`).

**Roles** (`src/roles.js`): modelo plano `admin` | `editor`. `requireRole(...roles)`
es un middleware factory que responde 403 y asume que `requireAuth` ya pobló
`req.user`. Qué significa cada rol, en una línea:

| Rol | Alcance |
|---|---|
| `admin` | Todo: blog, leads, imágenes de secciones y el mantenedor de usuarios |
| `editor` | **Solo el blog**: ver, crear, editar y eliminar publicaciones (+ lectura de leads). `403` en usuarios y en la escritura de imágenes |

Desde la feature 8 el `editor` también puede **eliminar** publicaciones
(`DELETE /api/admin/articles/:id` pasó de `requireRole('admin')` a
`requireRole('admin', 'editor')`): era la única letra del CRUD del blog que le
faltaba y contradecía la definición del rol. Los endpoints restringidos a
`admin` son ahora los tres de escritura de imágenes y los **cinco** del
mantenedor de usuarios.

**Passwords:** bcryptjs, 12 salt rounds (`SALT_ROUNDS` vive una sola vez, en
`src/users.js`; el CRUD de usuarios lo reutiliza al re-hashear en el `PATCH`).
Emails normalizados a lowercase+trim en escritura y lectura. `verifyPassword`
devuelve `false` (nunca lanza) ante hash corrupto. Login responde
`401 "Credenciales inválidas"` tanto si el usuario no existe como si la
contraseña es incorrecta (no filtra existencia de cuentas).

### 8.1 Mantenedor de usuarios (feature 8)

`src/usersRouter.js` (HTTP, cero SQL) sobre `src/users.js` (SQL + bcrypt). Cinco
endpoints bajo `/api/admin/users`, **solo rol `admin`** — gestionar cuentas no es
parte del alcance del `editor` — y ninguna ruta pública. Detalle del contrato en
`docs/api-contract.md`.

Tres cosas que no son obvias leyendo el código:

1. **`password_hash` nunca sale por la API (invariante I3).** `users.js` declara
   la lista fija `PUBLIC_COLS = 'id, email, name, role, created_at'` y **todas**
   las queries del CRUD la usan (`SELECT`/`RETURNING`); cero `SELECT *`. La única
   query que lee `password_hash` es la de `findUserByEmail`, porque el login la
   necesita para `verifyPassword` — por eso esa función **no** se reutiliza en
   los endpoints del CRUD. Es el mismo patrón que `META_COLS`/`RAW_COLS` en
   `images.js` (§7).
2. **El borrado es físico y no arrastra los artículos.** No hay borrado lógico
   ni columna `activo` (decisión del humano): se borra la fila, y
   `articles.author_id` (`ON DELETE SET NULL`) deja los artículos publicados con
   `author_id: null`.
3. **Las dos guardas del `DELETE`** (ambas `409`): nadie se borra a sí mismo, y
   no se puede borrar al **último `admin`** (dejaría el sistema sin acceso al
   panel). La segunda **no** se resuelve con un `COUNT` previo y suelto: dos
   borrados concurrentes de dos admins distintos leerían ambos "quedan 2" y la
   tabla acabaría sin ningún admin. `deleteUser` abre una transacción y bloquea,
   en **una sola sentencia** con orden determinista
   (`SELECT … WHERE role = 'admin' OR id = $2 ORDER BY id FOR UPDATE`), las filas
   de todos los admins más la fila objetivo:
   - Una sola sentencia con `ORDER BY id` evita el deadlock que aparecería
     bloqueando primero el objetivo y después el resto de admins (A esperaría a
     B y B a A).
   - La segunda transacción espera al `COMMIT` de la primera y, al
     desbloquearse, `READ COMMITTED` reevalúa el `WHERE` sobre la versión nueva
     de las filas: ya no ve al admin borrado, cuenta 1 y responde `409`.
   Ejercitado con dos `DELETE` concurrentes reales en `tests/users.test.js`
   (exactamente un `204` y un `409`, y siempre queda ≥ 1 admin).

---

## 9. Correo (`src/email.js`)

`createMailer()` devuelve uno de **tres** objetos según la configuración, todos
con la misma interfaz `{ enabled, provider, to?, sendLead(lead, id) }`:

1. **Sin `SMTP_HOST`** → mailer no-op, `enabled: false`, `status: 'skipped'`.
   El lead se guarda igual. Es el modo por defecto en desarrollo.
2. **`SMTP_HOST === 'resend'`** → cliente **Resend HTTP API**. Existe porque Render
   y Railway bloquean puertos SMTP salientes en el plan free. La API key se toma
   de `SMTP_PASS` (o `SMTP_USER`).
3. **Cualquier otro host** → **nodemailer** SMTP con timeouts explícitos
   (`connection: 10s`, `greeting: 10s`, `socket: 15s`) para no colgar la request.

### Dos correos por lead

- **Ventas** → `MAIL_TO`, con `replyTo: lead.email`, asunto
  `[MaIA Lead] <nombre> – <empresa>`, tabla con todos los campos + botón "Responder".
- **Usuario** → `lead.email`, confirmación de demo con próximos pasos.
  Se omite si el lead no trae email.

Estado agregado: `'sent'` (ambos), `'partial'` (uno), `'failed'` (ninguno).
El retorno incluye `results.sales` y `results.user` por separado, que es lo que
`app.js` usa para el logging granular.

### Plantillas HTML

Construidas para compatibilidad con clientes de correo, siguiendo el
design-system §10: tablas de 600px centradas (sin flex/grid), `font-family` con
fallback `Arial, sans-serif`, sin `box-shadow`, hex completo. Paleta: naranja
`#E8440A`, texto `#1A1410`, bordes `#F0EBE8`, fondo `#FAFAF9`, muted `#A89E9A`.
**Todo string de usuario pasa por `escapeHtml()`** antes de interpolarse.
Los logos van como adjuntos CID inline (`logo-maia`, `isotipo-maia`) para que se
vean sin permitir imágenes remotas. Se leen una sola vez desde `docs/images/` al
importar el módulo y se cachean en memoria; el cargador prefiere `.png` sobre
`.svg` si ambos existen (ver §14.1). Si un asset falta, se emite un warning y el
correo sale igual con un wordmark de texto en vez de un `cid:` roto — nunca se
bloquea el envío por un logo. Cada proveedor recibe su propio formato de adjunto:
nodemailer usa `content`/`cid`/`contentType`; Resend usa `content` en base64 con
`contentId` (su campo `path` es una URL pública, no una ruta de filesystem).

Cada plantilla tiene versión `text` y `html`. `__internals` exporta los builders
para poder testearlos sin transporte.

---

## 10. Detección de país (`src/phone.js`)

`detectCountry(phone)` parsea el E.164 con `libphonenumber-js` y traduce el ISO a
nombre en español con `Intl.DisplayNames(['es'])` (instancia cacheada a nivel de
módulo). Devuelve siempre un objeto — `{ iso: '', name: '' }` ante cualquier fallo,
nunca lanza. Se usa para poblar `pais`/`pais_iso` del lead y alimentar el filtro
`pais_iso` del panel admin.

---

## 11. Testing

`vitest run` + `supertest`. 12 archivos: `contact`, `email`, `articles`,
`auth`, `leads`, `phone`, `roles`, `roles.schema`, `app`, `ratelimit`,
`images`, `users`.

**Estrategia**: tests de integración reales contra Postgres, no mocks de DB.
Cada suite crea un schema único (`maia_test_<ts>_<rand>`), corre `ensureSchema`,
monta la app con `createApp({ pool, schema, mailer: fakeMailer })` y hace
`DROP SCHEMA ... CASCADE` en `afterAll`. El mailer sí se falsea, acumulando los
envíos en un array inspeccionable.

`tests/users.test.js` añade un matiz a esa estrategia: los tests de la guarda
del **último admin** dependen de cuántos admins hay **en toda la tabla**, así
que cada uno corre en su propio schema efímero adicional
(`<schema>_g<N>`, helper `withFreshSchema`) con su propia app y su propio
secreto de cookie, y lo destruye al terminar. Compartir el schema principal los
volvería dependientes del orden de ejecución.

Conexión: `TEST_DATABASE_URL` → `DATABASE_URL` → `postgres:///maia-landing?host=/var/run/postgresql`.
**`npm test` (la verificación obligatoria) requiere un Postgres accesible.**

### 11.1 Subconjunto sin Postgres (`npm run test:no-db`, feature 4)

Tres archivos no importan `db.js` ni abren un `pool`, así que corren igual con
Postgres apagado: `tests/phone.test.js` (`detectCountry`, parseo E.164 puro),
`tests/email.test.js` (`createMailer` con un `transporter` fake inyectado) y
`tests/roles.test.js` (`ROLES`/`hasRole`/`requireRole` sobre mocks de Express
hechos a mano). `npm run test:no-db` corre exactamente esos tres (30 tests).

`tests/roles.test.js` se separó de `tests/roles.schema.test.js` en esta
feature: el primero es 100% puro, el segundo aísla la única parte de la suite
de roles que sí necesita DB real (la migración `ALTER TABLE users ADD COLUMN
role` sobre un schema efímero) — mismo contenido de antes, solo repartido en
dos archivos para poder trazar la frontera "necesita DB / no la necesita" por
nombre de archivo, sin depender de filtros de nombre de test.

Es un atajo para iterar rápido en esos tres módulos o para un paso de CI sin
Postgres disponible — **no reemplaza** `npm test`: no ejercita ninguna query
SQL real, ni `POST /api/contact`, auth con usuarios reales, rate limiting
montado sobre `createApp()`, el middleware de errores sobre una app real, ni
la migración `role`. Ver `docs/verification.md` §1.1 para el detalle completo
de qué cubre y qué no.

---

## 12. Configuración y despliegue

### Variables de entorno

| Variable | Requerida | Default | Notas |
|---|---|---|---|
| `PORT` | no | 3001 | Render lo inyecta |
| `DATABASE_URL` | **sí** | — | El proceso aborta si falta |
| `DB_SCHEMA` | no | `public` | |
| `PGSSL` | no | `false` | `"true"` en cualquier Postgres gestionado |
| `CORS_ORIGIN` | no | `*` | Coma-separado para varios orígenes |
| `AUTH_SECRET` | **sí** | — | `openssl rand -hex 48`. El proceso aborta si falta |
| `SMTP_HOST` | no | — | Vacío = sin correo. `resend` = API HTTP |
| `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | no | 587 / false | `SMTP_PASS` = API key si Resend |
| `MAIL_FROM` | no | `noreply@maiabuilder.ai` | Debe estar verificado en el proveedor |
| `MAIL_TO` | no | `maia@maiabuilder.ai` | Destino de ventas |
| `MAIA_ADMIN_EMAIL` / `MAIA_ADMIN_PASSWORD` | no | — | Solo para `seed-users.js` |
| `CONTACT_RATE_LIMIT_WINDOW_MS` | no | `60000` (1 min) | Ventana del rate limit de `POST /api/contact` |
| `CONTACT_RATE_LIMIT_MAX` | no | `20` | Máximo de requests por IP en esa ventana |
| `AUTH_RATE_LIMIT_WINDOW_MS` | no | `900000` (15 min) | Ventana del rate limit de `POST /api/auth/login` |
| `AUTH_RATE_LIMIT_MAX` | no | `10` | Máximo de intentos de login por IP en esa ventana |
| `AUTH_REFRESH_WINDOW_MS` | no | `86400000` (1 día) | Ventana de renovación de sesión (feature 5): si al token le queda menos que esto para expirar, una request autenticada re-emite la cookie con 7 días nuevos |
| `IMAGES_MAX_FILE_SIZE_BYTES` | no | `5242880` (5 MB) | Tamaño máximo por archivo en `POST /api/admin/images` (feature 7, ver §7.1). Superarlo → `413`. No es un secreto |

Si una variable de rate limit está vacía o no es un número válido > 0, se usa
el default. Ver §4 para el detalle de `trust proxy` y `createRateLimiter`.
Lo mismo aplica a `AUTH_REFRESH_WINDOW_MS` (ver §8 para el detalle de la
renovación de sesión) y a `IMAGES_MAX_FILE_SIZE_BYTES` (ver §7.1): valor vacío
o no numérico > 0 → default.

### Render (`render.yaml`)

Servicio web `maia-api`, plan free, `npm install` / `npm start`. Todas las
variables sensibles con `sync: false` (se cargan a mano en el dashboard).
`NODE_ENV=production`, `DB_SCHEMA=public`, `PGSSL=true` van fijas en el blueprint.

Consecuencias del plan free a tener presentes: el servicio se duerme por
inactividad (primer request lento, y `ensureSchema` vuelve a correr en cada
despertar) y los puertos SMTP salientes están bloqueados — de ahí el modo Resend.

### Bootstrap de un entorno nuevo

```bash
cp .env.example .env          # rellenar DATABASE_URL y AUTH_SECRET
npm install
npm run dev                   # http://localhost:3001
node scripts/create-user.js admin@maiabuilder.ai <password> "Admin"
# o bien:
MAIA_ADMIN_EMAIL=... MAIA_ADMIN_PASSWORD=... node scripts/seed-users.js
```

`seed-users.js` es idempotente: si el usuario existe le fuerza `role='admin'`,
si no lo crea como admin.

---

## 13. Decisiones de diseño

| Decisión | Razón |
|---|---|
| Factories con DI en todos los módulos | Testeabilidad sin mocks globales; la app real y la de test se construyen igual |
| Correo best-effort, DB bloqueante | Un lead perdido es peor que un correo perdido |
| Estado del envío fuera de la respuesta HTTP | No filtrar infraestructura al cliente; los logs `[mail]` son la fuente de verdad |
| Rol recargado desde DB en cada request | Revocación inmediata sin invalidar tokens |
| DDL idempotente en el código, sin migrador | Suficiente para el tamaño actual; corre en cada boot |
| Schema por test en vez de mocks de `pg` | El SQL real (índices, UNIQUE, FK, códigos de error) queda cubierto |
| Doble camino de correo (SMTP / Resend HTTP) | Los planes free de PaaS bloquean SMTP saliente |
| `body_md` en Markdown crudo | El render es responsabilidad del front |
| Rate limit en memoria, sin Redis | Render free es un solo proceso; Redis sería sobre-ingeniería y una dependencia nueva |
| `trust proxy: 1` (no `true`) | Render pone exactamente un reverse proxy delante; confiar en toda la cadena permitiría spoofear `X-Forwarded-For` |
| 429 sin cabeceras `RateLimit-*`/`Retry-After` | El acceptance de la feature 3 exige no filtrar cuántos intentos quedan |
| Binario de las imágenes en Postgres (BYTEA) | El filesystem de Render es efímero y un proveedor externo exigiría credenciales nuevas. Decisión del humano (feature 7) |
| SVG fuera de la whitelist de imágenes | Es XML ejecutable y `/raw` lo serviría en crudo desde el origen de la API → XSS almacenado (§7.1) |
| MIME validado por magic bytes, no por lo que declara el cliente | El `mimetype` de multer es el `Content-Type` del cliente y es falsificable (§7.1) |
| multer montado solo en `POST /api/admin/images`, no global | Ninguna otra ruta debe poder recibir un upload; el límite de imágenes queda separado del de 32 kb del JSON |
| Mantenedor de usuarios solo para `admin` | Crear cuentas y repartir roles es administración del sistema, no del blog; el `editor` no debe poder autopromoverse |
| El `editor` sí borra publicaciones | El rol se define como "ver, crear, editar y eliminar una publicación"; el `DELETE` era la única excepción. Decisión del humano (feature 8) |
| Borrado de usuario físico, sin columna `activo` | `articles.author_id` ya es `ON DELETE SET NULL`: los artículos sobreviven sin necesidad de borrado lógico, y el flujo de login no cambia. Decisión del humano (feature 8) |
| Guarda del último admin con transacción + `FOR UPDATE`, no con un `COUNT` previo | Un `COUNT` suelto es una condición de carrera: dos borrados concurrentes dejarían el sistema sin ningún admin (§8.1) |

---

## 14. Limitaciones conocidas

Cosas que existen hoy y conviene tener en el radar. El backlog de
`feature_list.json` está vacío a fecha de 2026-07-28 (todas las features
propuestas están `done` o `descartada`); lo que sigue abierto aquí no tiene
una feature `pending` asociada — es deuda aceptada o pendiente de un humano,
no de un agente.

1. **`.env` sigue expuesto en el historial de git — rotación de credenciales
   pendiente.** La feature 1 (cerrada 2026-07-28) sacó `.env` del **índice**
   (`git rm --cached`), pero el repo es público y `.env` estuvo trackeado
   desde antes de que existiera la regla de `.gitignore`: sus valores
   (`DATABASE_URL`, `SMTP_PASS`, `SMTP_USER`, `AUTH_SECRET`,
   `MAIA_ADMIN_PASSWORD`) siguen legibles en el historial de commits y **no
   se han rotado**. Sacar el archivo del índice no cierra la exposición, solo
   detiene que seguir committeando cambios futuros de `.env`. Pendiente,
   **solo lo puede hacer un humano**: rotar cada credencial en su proveedor y
   actualizar las variables en Render; opcionalmente purgar el historial
   (`git filter-repo`/BFG). Es lo más urgente de esta lista — ver el aviso
   persistente en `progress/current.md` y el detalle completo en
   `progress/history.md` ("2026-07-28 — feature 1").
2. **`ensureSchema` en cada arranque** — inofensivo hoy, pero acopla el boot a
   la disponibilidad de la DB y no escala a migraciones con datos. La feature
   6 ("Health check que no dependa del boot para el schema") se propuso para
   esto y el humano la **descartó explícitamente** el 2026-07-28: se prefiere
   el fail-fast actual (`exit(1)` si `ensureSchema` falla al arrancar, visible
   en los logs de Render) frente a un arranque tolerante que dejaría el
   servicio "arriba" respondiendo 503 con una configuración rota, enmascarando
   el fallo en vez de exponerlo. Queda **aceptada conscientemente**, no
   pendiente de implementación — no proponerla de nuevo sin un motivo nuevo
   (ver `feature_list.json`, entrada `descartada` id 6).

Resueltas:

- ~~**Sin refresh de sesión**~~ — el JWT de 7 días se renueva solo cuando le
  queda menos de `AUTH_REFRESH_WINDOW_MS` (default 1 día) para expirar: cada
  request autenticada (`requireAuth`, `GET /api/auth/me`) re-emite la cookie
  con un token de 7 días completos, reutilizando exactamente las mismas
  opciones de cookie que el login (invariante I6 intacta). Ver §8 para el
  detalle completo. Cierra la feature 5 del backlog, cerrada el 2026-07-27.
- ~~**Los tests requieren Postgres**~~ — sigue siendo cierto para `npm test`
  (la verificación obligatoria, y con razón: son tests de integración reales,
  ver §11), pero ahora hay un subconjunto (`npm run test:no-db`, §11.1) con
  `phone`, `email` y la parte pura de `roles` que corre igual con Postgres
  apagado — útil para iterar rápido o como paso de CI sin base de datos
  disponible, sin sustituir a `npm test` para cerrar una feature. Verificado
  apuntando `TEST_DATABASE_URL` a un puerto muerto (`127.0.0.1:1`): el
  comando pasa igual, mientras que cualquier suite con DB real falla con
  `ECONNREFUSED` bajo la misma variable — confirma que de verdad no intenta
  conectar. Cierra la feature 4 del backlog, cerrada el 2026-07-28.

- ~~**SVG en correo**~~ — `docs/images/logo-maia.png` e `isotipo-maia.png` ya
  están en el repo y el cargador prefiere `.png` sobre `.svg`, así que Gmail y
  Outlook renderizan el logo.
- ~~**`.gitignore` incluía `*.md`**~~ — dejaba fuera de git toda la documentación
  y el arnés. El patrón se acotó el 2026-07-27.
- ~~**Sin middleware de errores**~~ — `src/app.js` monta `errorHandler` (4
  argumentos) al final del pipeline, después del catch-all 404. Todo throw no
  capturado (síncrono o asíncrono, este último vía `asyncHandler` en los 14
  puntos de registro async de la app) responde JSON `500` genérico en vez del
  HTML por defecto de Express. Cierra la feature 2 del backlog, cerrada el
  2026-07-27.
- ~~**Sin rate limiting**~~ — `POST /api/contact` y `POST /api/auth/login`
  están limitados por IP (`src/rateLimit.js`, en memoria, sin dependencias
  nuevas) con `trust proxy: 1` para resolver la IP real detrás del reverse
  proxy de Render. Responden `429 { "error": "..." }` sin filtrar cuántos
  intentos quedan. Ventana y máximo configurables por env
  (`CONTACT_RATE_LIMIT_*` / `AUTH_RATE_LIMIT_*`, ver §12) e
  inyectables/desactivables vía `createApp({ rateLimit })`. Cierra la
  feature 3 del backlog, cerrada el 2026-07-27.
