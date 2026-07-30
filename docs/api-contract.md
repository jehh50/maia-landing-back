# Contrato de API — MaIA Landing Back

> **Fuente de verdad del acuerdo con el front.** Si cambias la forma de una
> respuesta o un código de estado, actualiza este archivo **en el mismo commit**
> y avisa en `progress/current.md`. `../maia-landing-front` depende de esto.

Base URL: `/api`. Todo entra y sale como JSON UTF-8. Body máximo: **32 kb**.
Errores: siempre `{ "error": "<mensaje en español>" }`, opcionalmente con
`"field": "<campo>"` en los 422/415/413/409.

**Dos excepciones al "todo es JSON"**, ambas de la feature 7 (imágenes):
`POST /api/admin/images` entra como `multipart/form-data` (con su propio límite
de tamaño, no el de 32 kb) y `GET /api/images/:id/raw` **sale como binario** con
el `Content-Type` de la imagen. Sus errores siguen siendo JSON.

---

## Públicos

### `GET /api/health`

```json
200 { "ok": true,  "db": true,  "mailer": true }
503 { "ok": false, "db": false, "mailer": true }
```
`db` es un `SELECT 1` real contra Postgres. `mailer` refleja si hay proveedor
de correo configurado, no si el último envío funcionó.

### `POST /api/contact`

Request:
```json
{
  "nombre":    "Ana Pérez",
  "empresa":   "Acme",
  "email":     "ana@acme.com",
  "telefono":  "+525512345678",
  "industria": "Tecnología / SaaS",
  "mensaje":   "Quiero un demo",
  "tipo":      "demo"
}
```

| Campo | Obligatorio | Reglas |
|---|---|---|
| `email` | **siempre** | `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`; si no → 422 |
| `tipo` | no | `demo` \| `email` \| `contacto`; cualquier otro valor cae a `demo` |
| `nombre` | sí, salvo `tipo === "email"` | truncado a 120 |
| `telefono` | sí, salvo `tipo === "email"` | E.164 `/^\+\d{7,15}$/` tras normalizar espacios/guiones/paréntesis |
| `empresa`, `industria` | no | truncados a 120 |
| `mensaje` | no | truncado a 2000 |

`pais` / `pais_iso` **no se envían**: los deriva el servidor del teléfono.

Respuestas:
```json
201 { "ok": true, "id": 42 }
422 { "error": "Email inválido o requerido", "field": "email" }
429 { "error": "Demasiadas solicitudes. Inténtalo de nuevo más tarde." }
500 { "error": "Error al guardar en base de datos" }
```

> **Invariante:** el estado del envío de correo **nunca** aparece en la
> respuesta. Si el mail falla el lead ya está guardado y el cliente recibe 201.
> El diagnóstico va a los logs con prefijo `[mail]`.

> **Rate limit** (feature 3): limitado por IP, ventana y máximo configurables
> por env (`CONTACT_RATE_LIMIT_WINDOW_MS` / `CONTACT_RATE_LIMIT_MAX`, default
> 20 requests / 1 min, ver `docs/architecture.md` §12). Al superarlo responde
> `429` con el mismo formato de error que el resto del contrato — **sin**
> cabeceras `RateLimit-*` ni `Retry-After`, para no filtrar cuántos intentos
> quedan ni facilitar el cronometrado de reintentos.

### `GET /api/articles?limit=&offset=`

Solo artículos `published`. `limit` 1–50 (default 20), `offset` ≥ 0.

```json
200 { "rows": [ { "id": 1, "slug": "…", "title": "…", "excerpt": "…",
                  "cover_url": "…", "status": "published",
                  "published_at": "…", "created_at": "…", "updated_at": "…" } ] }
```

### `GET /api/articles/:slug`

```json
200 { "article": { …, "body_md": "# Markdown crudo" } }
404 { "error": "Artículo no encontrado" }
```
Un artículo `draft` responde **404** en la ruta pública (no 403).
`body_md` se entrega **sin renderizar**: el Markdown lo procesa el front.

### `GET /api/images?seccion=`

Metadatos de las imágenes de las secciones de la landing. Público, sin cookie.
`seccion` es opcional; si se manda debe ser una sección válida
(`hero` | `cta_final`).

```json
200 { "rows": [ { "id": 1, "seccion": "hero", "filename": "hero-1.png",
                  "mime_type": "image/png", "size_bytes": 20481,
                  "alt": "Pantalla de MaIA", "orden": 1,
                  "created_at": "…", "updated_at": "…" } ] }
422 { "error": "seccion inválida. Valores válidos: hero, cta_final", "field": "seccion" }
```

Orden: **`orden` ASC**, `id` ASC como desempate.

> **Invariante (análoga a la de `password_hash`):** el campo **`bytes` nunca
> aparece en JSON**, en ninguna respuesta de ningún endpoint. El binario se
> obtiene **solo** por `GET /api/images/:id/raw`. `size_bytes` (el tamaño en
> bytes) sí viaja, y no debe confundirse con `bytes`.

### `GET /api/images/:id/raw`

Devuelve el **binario** de la imagen, no JSON. Público, sin cookie. Es la URL
que el front pone en `src`.

```
200  Content-Type: image/png | image/jpeg | image/webp   (el MIME real detectado)
     Content-Length: <size_bytes>
     X-Content-Type-Options: nosniff
     <binario>
404 { "error": "Imagen no encontrada" }
```

`404` tanto si el id no existe como si no es numérico (nunca un 500).

---

## Auth

Sesión = JWT HS256 en cookie `httpOnly` **`maia_session`**, 7 días.
En producción: `SameSite=None; Secure`. En desarrollo: `SameSite=Lax` sin `Secure`.
El front debe usar `credentials: 'include'` en todas las llamadas.

| Endpoint | Request | Respuesta |
|---|---|---|
| `POST /api/auth/login` | `{ email, password }` | `200 { ok, user }` + `Set-Cookie` · `400 { error: "Email y password requeridos" }` · `401 { error: "Credenciales inválidas" }` · `429 { error: "Demasiadas solicitudes. Inténtalo de nuevo más tarde." }` |
| `POST /api/auth/logout` | — | `200 { ok: true }` + cookie borrada |
| `GET /api/auth/me` | cookie | `200 { user }` · `401 { error: "No autenticado" }` |

`user` = `{ id, email, name, role }`. **Nunca** incluye `password_hash`.
El 401 de login es idéntico para usuario inexistente y password incorrecta
(no se filtra la existencia de cuentas).

> **Rate limit** (feature 3): solo `POST /api/auth/login` está limitado por
> IP (`logout`/`me` no); intentos fallidos y exitosos cuentan igual contra el
> cupo. Configurable por env (`AUTH_RATE_LIMIT_WINDOW_MS` /
> `AUTH_RATE_LIMIT_MAX`, default 10 intentos / 15 min, ver
> `docs/architecture.md` §12). Mismo criterio que `/api/contact`: sin
> cabeceras `RateLimit-*`/`Retry-After`.

> **Renovación de sesión** (feature 5): `GET /api/auth/me` y toda ruta
> `/api/admin/*` (vía `requireAuth`) pueden ahora incluir `Set-Cookie` con la
> cookie `maia_session` — algo que antes solo pasaba en `POST
> /api/auth/login`. Solo ocurre cuando al token le queda menos de
> `AUTH_REFRESH_WINDOW_MS` (default 1 día, ver `docs/architecture.md` §8/§12)
> para expirar; el resto de requests autenticadas no llevan `Set-Cookie`. La
> cookie renovada usa exactamente las mismas opciones que la original
> (`httpOnly`, `sameSite`, `secure`, `path`) y un `maxAge`/expiración de 7
> días nuevos. El front no necesita cambiar nada (`credentials: 'include'`
> ya reenvía cualquier cookie nueva), pero es un cambio observable en las
> cabeceras de esas dos rutas si algo inspecciona `Set-Cookie` explícitamente.

---

## Admin (requieren cookie válida)

Sin cookie → `401`. Con cookie pero rol insuficiente → `403`.

### Artículos

| Método | Ruta | Roles | Respuesta |
|---|---|---|---|
| `GET` | `/api/admin/articles` | admin, editor | `200 { rows }` (todos los estados, limit fijo 200) |
| `GET` | `/api/admin/articles/:id` | admin, editor | `200 { article }` · `404` |
| `POST` | `/api/admin/articles` | admin, editor | `201 { article }` · `422 { error, field }` · `409 { error: "Slug ya existe", field: "slug" }` |
| `PATCH` | `/api/admin/articles/:id` | admin, editor | `200 { article }` · `404` · `409` |
| `DELETE` | `/api/admin/articles/:id` | admin, editor | `204` sin body · `404` |

`POST` exige `title` y `body_md`. `slug` se autogenera del título si no se manda.
`status` distinto de `"published"` cae a `"draft"`. `author_id` se toma de la
sesión, **no** del body. `published_at` se sella en la primera transición
`draft → published` y no se reescribe después.

> **Cambio de permisos (feature 8, 2026-07-29):** el `DELETE` de artículos
> aceptaba **solo `admin`**; ahora acepta `admin, editor`. Es un cambio
> deliberado, aprobado explícitamente por el humano
> (`feature_list.json`, feature 8, `decision_humano` (a)): el rol `editor`
> existe para gestionar el blog y su descripción es "puede ver, crear, editar y
> **eliminar** una publicación". Los otros cuatro verbos ya lo admitían; el
> `DELETE` era la única excepción. **No amplía nada más**: el `editor` sigue
> recibiendo `403` en usuarios y en las rutas de escritura de imágenes. Un
> cliente que dependiera del `403` anterior para ocultar el botón de borrar en
> el panel del editor puede ahora mostrarlo.

`author_id` queda en `NULL` si el usuario autor se elimina (ver
`DELETE /api/admin/users/:id`): borrar una cuenta **no** borra sus artículos.

### Leads

| Método | Ruta | Roles | Respuesta |
|---|---|---|---|
| `GET` | `/api/admin/leads` | admin, editor | `200 { rows, total, limit, offset }` |
| `GET` | `/api/admin/leads/:id` | admin, editor | `200 { lead }` · `404` |

Query params del listado: `tipo`, `pais_iso` (se normaliza a mayúsculas),
`q` (ILIKE sobre `nombre`, `email`, `empresa`), `limit` (default 50, máx 200),
`offset`. Orden: `created_at DESC, id DESC`.

> Ojo con la asimetría, es intencional pero fácil de olvidar: el listado de
> leads devuelve `{ rows, total, limit, offset }` y el de artículos solo
> `{ rows }`.

### Usuarios (feature 8)

Mantenedor de cuentas del panel. **Los cinco endpoints son solo rol `admin`**:
sin cookie → `401`, con rol `editor` → `403`. **No existe ninguna ruta pública
de usuarios** (`/api/users` responde `404`).

| Método | Ruta | Roles | Respuesta |
|---|---|---|---|
| `GET` | `/api/admin/users` | **admin** | `200 { rows }` (orden `id ASC`) |
| `GET` | `/api/admin/users/:id` | **admin** | `200 { user }` · `404` |
| `POST` | `/api/admin/users` | **admin** | `201 { user }` · `422 { error, field }` · `409 { error, field: "email" }` |
| `PATCH` | `/api/admin/users/:id` | **admin** | `200 { user }` · `404` · `409 { error, field: "email" }` · `422 { error, field? }` |
| `DELETE` | `/api/admin/users/:id` | **admin** | `204` sin body · `404` · `409 { error }` |

`user` = `{ id, email, name, role, created_at }` — la **misma forma en los
cuatro endpoints que devuelven JSON**.

> **Invariante I3:** `password_hash` **nunca** aparece en ninguna respuesta, ni
> en el listado, ni en el detalle, ni en la del `POST`, ni en la del `PATCH`.
> `src/users.js` declara la lista fija `PUBLIC_COLS`
> (`id, email, name, role, created_at`) y ninguna query del CRUD hace
> `SELECT *`. La contraseña en claro tampoco se devuelve ni se loguea nunca.

`404` tanto si el id no existe como si no es numérico o desborda el rango de un
`bigint` — nunca un `500`.

#### `POST /api/admin/users`

| Campo | Obligatorio | Reglas |
|---|---|---|
| `email` | **sí** | se normaliza a lowercase + trim; único |
| `password` | **sí** | se hashea con bcrypt (12 rounds); nunca se guarda en claro |
| `name` | no | truncado a 120 |
| `role` | no | `admin` \| `editor`; si no se manda, `editor` |

```json
201 { "user": { "id": 3, "email": "nuevo@maiabuilder.ai", "name": "Nuevo",
                "role": "editor", "created_at": "…" } }
422 { "error": "email requerido", "field": "email" }
422 { "error": "password requerido", "field": "password" }
422 { "error": "role inválido. Valores válidos: admin, editor", "field": "role" }
409 { "error": "El email ya está en uso", "field": "email" }
```

#### `PATCH /api/admin/users/:id`

Campos editables: **`email`, `name`, `role` y `password`** — y solo esos. Los
ausentes conservan su valor. Si viene `password`, se **re-hashea** con el mismo
bcrypt de 12 rounds (decisión del humano: un admin sí puede cambiar la
contraseña de otro usuario).

```json
200 { "user": { … } }
404 { "error": "Usuario no encontrado" }
409 { "error": "El email ya está en uso", "field": "email" }
422 { "error": "role inválido. Valores válidos: admin, editor", "field": "role" }
422 { "error": "Nada que actualizar: se esperaba email, name, role o password" }
```

Un body que solo traiga campos no editables (`password_hash`, `id`,
`created_at`…) responde `422` y **no modifica nada**.

> El rol se recarga de la DB en cada request (invariante I5): cambiar el `role`
> de un usuario surte efecto en su **siguiente** request, sin re-login.

#### `DELETE /api/admin/users/:id`

Borrado **físico** de la fila (no hay borrado lógico ni campo `activo`).

```json
204 (sin body)
404 { "error": "Usuario no encontrado" }
409 { "error": "No puedes eliminar tu propio usuario" }
409 { "error": "No puedes eliminar al último usuario con rol admin" }
```

Dos guardas, ambas `409`:

1. **Nadie se borra a sí mismo** (se compara contra el id de la sesión).
2. **No se puede borrar al último `admin`**: dejaría el sistema sin acceso al
   panel. Se resuelve dentro de una transacción con `FOR UPDATE`, así que dos
   borrados concurrentes tampoco pueden dejar la tabla sin ningún admin (ver
   `docs/architecture.md` §8).

> **Borrar un usuario NO borra sus artículos.** `articles.author_id` es
> `ON DELETE SET NULL`: los artículos sobreviven con `author_id: null` y siguen
> publicados. Es un requisito explícito del humano, cubierto por test.

### Imágenes (feature 7)

| Método | Ruta | Roles | Respuesta |
|---|---|---|---|
| `POST` | `/api/admin/images` | **admin** | `201 { image }` · `422 { error, field }` · `415 { error, field: "file" }` · `413 { error, field: "file" }` |
| `PATCH` | `/api/admin/images/:id` | **admin** | `200 { image }` · `404` · `422 { error }` · `422 { error, field }` |
| `DELETE` | `/api/admin/images/:id` | **admin** | `204` sin body · `404` |

Los dos `GET` de imágenes son **públicos** (ver arriba); las tres rutas de
escritura son **solo `admin`**: sin cookie → `401`, con rol `editor` → `403`.

#### `POST /api/admin/images` — `multipart/form-data`

| Parte | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `file` | archivo | **sí** | `image/png`, `image/jpeg` o `image/webp`. Ver validación abajo |
| `seccion` | texto | **sí** | `hero` \| `cta_final` |
| `alt` | texto | no | truncado a 300 |
| `orden` | texto | no | entero ≥ 0, default `0` |

`filename`, `mime_type` y `size_bytes` **no se envían**: los deriva el servidor
del archivo (`mime_type` es el **detectado**, no el declarado).

```json
201 { "image": { "id": 7, "seccion": "hero", "filename": "hero-1.png",
                 "mime_type": "image/png", "size_bytes": 20481,
                 "alt": "…", "orden": 1, "created_at": "…", "updated_at": "…" } }
422 { "error": "Archivo requerido", "field": "file" }
422 { "error": "seccion requerida", "field": "seccion" }
422 { "error": "seccion inválida. Valores válidos: hero, cta_final", "field": "seccion" }
422 { "error": "orden debe ser un entero >= 0", "field": "orden" }
415 { "error": "Tipo de archivo no permitido. Formatos aceptados: image/png, image/jpeg, image/webp", "field": "file" }
413 { "error": "El archivo excede el tamaño máximo permitido (… bytes)", "field": "file" }
```

**Validación del archivo** (detalle en `docs/architecture.md` §7.1): se
comprueban el MIME declarado, la extensión del nombre **y los magic bytes del
contenido real**; cualquier discrepancia → `415`. **SVG está excluido a
propósito** (es XML ejecutable y `/raw` lo serviría en crudo → XSS almacenado).
El límite de tamaño es `IMAGES_MAX_FILE_SIZE_BYTES` (default 5 MB) y superarlo
responde `413` **en JSON**: el `MulterError` se atrapa explícitamente, nunca
sale un 500 ni el HTML por defecto de Express.

La respuesta `201` no lleva el binario. Para reemplazar la imagen de una
sección se hace un `POST` nuevo (y un `DELETE` de la vieja): el `PATCH` no toca
el binario.

#### `PATCH /api/admin/images/:id`

Body JSON. Campos editables: **`alt`, `orden`, `seccion`** — y solo esos.

```json
200 { "image": { … } }
404 { "error": "Imagen no encontrada" }
422 { "error": "Nada que actualizar: se esperaba alt, orden o seccion" }
422 { "error": "seccion inválida. Valores válidos: hero, cta_final", "field": "seccion" }
422 { "error": "orden debe ser un entero >= 0", "field": "orden" }
```

Un body que solo traiga campos no editables (`mime_type`, `filename`,
`size_bytes`, `bytes`…) responde `422` y **no modifica nada**.

---

## Rutas desconocidas

```json
404 { "error": "Not found" }
```

## Errores no controlados

Cualquier excepción no capturada responde siempre JSON, nunca el HTML por
defecto de Express:

```json
500 { "error": "Error interno del servidor" }
```

Cubre tanto un `throw` síncrono (Express 4 lo reenvía solo al middleware de
errores) como un rechazo de promesa dentro de un handler/middleware `async`
(requiere reenvío explícito — todo handler `async` de la app está envuelto
con `asyncHandler`, ver `docs/conventions.md` §7), y también errores de
middlewares previos a las rutas, como un body JSON malformado (`express.json()`
reenvía su `SyntaxError` con `next(err)`).

Nunca se expone el stack, el mensaje real de la excepción, ni SQL. El error
real se loggea en el servidor con prefijo `[app]`. Es el último middleware de
`src/app.js` (después del catch-all 404).

## Cambios que rompen el contrato

Requieren actualizar este archivo, avisar al front y anotarlo en
`progress/current.md`:

- renombrar o eliminar un campo de respuesta;
- cambiar un código de estado (p. ej. 422 → 400);
- volver obligatorio un campo hoy opcional;
- cambiar el nombre, el `SameSite` o el `path` de la cookie de sesión;
- cambiar la forma del objeto `user`.
