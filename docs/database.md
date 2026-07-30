# Base de datos — MaIA Landing Back

> Léelo **antes** de tocar el esquema o escribir queries nuevas.
> El detalle completo de columnas está en `architecture.md` §7; aquí van las
> reglas de trabajo.

## 1. Cómo funcionan las "migraciones" aquí

**No hay herramienta de migraciones.** Todo el DDL vive en `src/db.js`, dentro de
`ensureSchema()`, que corre en **cada arranque** del servidor y en el `beforeAll`
de cada suite de tests.

Consecuencia directa: **todo el DDL debe ser idempotente**.

```sql
CREATE SCHEMA IF NOT EXISTS …
CREATE TABLE  IF NOT EXISTS …
ALTER TABLE … ADD COLUMN IF NOT EXISTS …
CREATE INDEX IF NOT EXISTS …
```

Nunca un `DROP`, un `ALTER … TYPE` destructivo ni un `UPDATE` de datos dentro de
`ensureSchema()`: se ejecutaría en cada despertar del servicio en Render.

## 2. Cómo añadir una columna

1. Añade el `ALTER TABLE … ADD COLUMN IF NOT EXISTS` en `ensureSchema()`, junto
   a los de su tabla.
2. Añade la columna a la constante de columnas del módulo de datos
   correspondiente (`COLS` en `leads.js`/`articles.js`, `META_COLS` en
   `images.js`, `PUBLIC_COLS` en `users.js`) si debe salir por la API.
3. Actualiza la tabla de columnas en `architecture.md` §7.
4. Si la columna cambia la forma de una respuesta → `docs/api-contract.md`.
5. Añade el test: inserta, lee, verifica que viaja hasta el endpoint.

Columnas nuevas: **siempre nullable o con `DEFAULT`**. Un `NOT NULL` sin default
sobre una tabla con datos revienta el arranque en producción.

## 3. Cambios que NO puedes hacer solo

Escala a un humano (ver `AGENTS.md` §6) si el cambio implica:

- borrar o renombrar una columna existente,
- cambiar el tipo de una columna con datos,
- un backfill / migración de datos,
- añadir un `UNIQUE` sobre datos que ya existen (puede fallar en producción y
  pasar en test, donde la tabla está vacía).

Estos requieren un plan de dos pasos y una ventana de despliegue, no un
`ensureSchema()`.

## 4. Multi-tenancy por schema

`DB_SCHEMA` (default `public`) se **interpola** en las queries:

```js
`SELECT ${COLS} FROM "${schema}".leads WHERE id = $1`
```

- `schema` viene de env o del código de test. **Nunca** de input de usuario.
  Si algún día llega de una request, es una inyección SQL.
- Siempre entre comillas dobles.
- Todo lo demás va parametrizado (`$1, $2, …`).

Este mecanismo es exactamente el que aísla los tests: cada suite usa
`maia_test_<timestamp>_<random>` y lo destruye al terminar.

## 5. Tablas

| Tabla | PK | Notas |
|---|---|---|
| `leads` | `id` BIGSERIAL | `email` NOT NULL; `tipo` default `'demo'`; índices en `email` y `created_at DESC` |
| `users` | `id` BIGSERIAL | `email` UNIQUE, siempre lowercase; `password_hash` bcrypt 12 rounds; `role` default `'editor'` (ver abajo) |
| `articles` | `id` BIGSERIAL | `slug` UNIQUE; `status` `draft`\|`published`; `author_id` → `users(id)` ON DELETE SET NULL |
| `images` | `id` BIGSERIAL | **El binario vive aquí**: `bytes` BYTEA NOT NULL. `seccion` (`hero`\|`cta_final`); índice `(seccion, orden)` |

Detalle columna por columna: `architecture.md` §7.

### `users` — modelo de roles y el hash fuera de la API (feature 8)

La tabla no cambió con el CRUD de usuarios (feature 8): **cero columnas nuevas,
cero tablas nuevas, `ensureSchema` intacto**. Lo que sí conviene tener escrito es
cómo se usa:

| columna | notas |
|---|---|
| `email` | UNIQUE; se normaliza a **lowercase + trim** en escritura y lectura. El `23505` se traduce a `409` |
| `password_hash` | bcrypt, 12 rounds (`SALT_ROUNDS` de `src/users.js`, un único sitio). Se re-hashea con el mismo valor al cambiar la contraseña por `PATCH` |
| `role` | `admin` \| `editor`. El enum vive en `ROLES` (`src/roles.js`), **no** en un `CHECK` de la BD: añadir un rol es una línea de código, no una migración. El `DEFAULT 'editor'` de la columna es el que aplica cuando el `POST` no manda `role` |

> **Invariante I3 — `password_hash` nunca sale por la API.** `src/users.js`
> declara la lista fija `PUBLIC_COLS = 'id, email, name, role, created_at'` y
> todas las queries del CRUD (`listUsers`, `getUserById`, `createUser`,
> `updateUser`) la usan en su `SELECT`/`RETURNING`. **Cero `SELECT *`.** La única
> query que lee `password_hash` es la de `findUserByEmail`, porque el login la
> necesita para `verifyPassword` — no la reutilices en un endpoint del CRUD. Es
> el mismo patrón que `META_COLS`/`RAW_COLS` en `images.js`.

**Borrar un usuario no borra sus artículos.** `articles.author_id` es
`BIGINT REFERENCES users(id) ON DELETE SET NULL`, así que el `DELETE` de la fila
(borrado **físico**: no hay borrado lógico ni columna `activo`) deja los
artículos intactos con `author_id = NULL`. Está ejercitado con un test, no
asumido leyendo este DDL.

**No te quedes sin admins.** `deleteUser` rechaza borrar al último usuario con
rol `admin`, y lo hace dentro de una transacción que bloquea las filas de todos
los admins (`SELECT … WHERE role = 'admin' OR id = $2 ORDER BY id FOR UPDATE`)
en vez de con un `COUNT` previo, que sería una condición de carrera. Detalle en
`architecture.md` §8.1.

### `images` — el binario en la BD (feature 7)

Decisión del humano (`feature_list.json`, feature 7, `decision_humano`): la
imagen se guarda **completa en la columna `bytes` (BYTEA)**, no como
metadatos+URL ni en S3/Cloudinary. Motivo: el filesystem de Render es efímero
(un archivo escrito en disco se pierde en cada deploy) y un proveedor externo
exigiría credenciales nuevas que hoy no existen. Se acepta el peso en la BD.

| columna | tipo | notas |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `seccion` | TEXT NOT NULL | `hero` \| `cta_final`; la whitelist vive en `SECCIONES` de `src/images.js`, no en un CHECK |
| `filename` | TEXT NOT NULL | nombre original saneado (sin rutas ni caracteres de control), máx. 255 |
| `mime_type` | TEXT NOT NULL | el **detectado** por magic bytes, no el declarado por el cliente |
| `bytes` | BYTEA NOT NULL | el binario |
| `size_bytes` | INTEGER NOT NULL DEFAULT 0 | `bytes.length` en el momento de subir |
| `alt` | TEXT | texto alternativo, máx. 300 |
| `orden` | INTEGER NOT NULL DEFAULT 0 | orden de aparición dentro de la sección (carrusel del hero) |
| `created_at`, `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

Índice: `images_seccion_orden_idx (seccion, orden)` — sirve al listado
`?seccion=` ordenado por `orden ASC`.

> **Invariante (análoga a I3 con `password_hash`):** `bytes` **nunca** sale por
> la API en JSON. `src/images.js` tiene dos listas de columnas: `META_COLS`
> (sin `bytes`) para todo listado/detalle, y `RAW_COLS` (con `bytes`) usada
> **solo** por `getImageWithBytes`, que a su vez solo llama
> `GET /api/images/:id/raw`. Si añades una query, usa `META_COLS`.

Cambiar el binario de una imagen es un `POST` nuevo, no un `PATCH`: el `PATCH`
solo toca `alt`, `orden` y `seccion` (ver `docs/api-contract.md`).

### Invariantes que los tests protegen

- `users.email` se normaliza a **lowercase + trim** en escritura y en lectura.
- `password_hash` **nunca** sale por la API: `publicUser()` lo filtra en las
  respuestas de auth y `PUBLIC_COLS` hace que las queries del CRUD de usuarios
  ni lo lean.
- Borrar un usuario **no** borra sus artículos (`author_id` → `NULL`), y no se
  puede borrar al último `admin`.
- `articles.published_at` se sella en la primera transición `draft → published`
  y no se reescribe en publicaciones posteriores.
- Orden de listado de artículos: `COALESCE(published_at, updated_at) DESC, id DESC`.
- `leads` no tiene FK a `users`: un lead es anónimo por definición.
- `images.bytes` **nunca** sale por la API en JSON (solo por
  `GET /api/images/:id/raw`, con su `Content-Type` real).
- `images.mime_type` guarda el MIME **verificado por magic bytes**, no el que
  declaró el cliente.
- Orden de listado de imágenes: `orden ASC, id ASC`.

### Detalle frágil conocido

El `ALTER TABLE users ADD COLUMN role` está envuelto en un `try/catch` que traga
el código `42P01` (undefined_table), para tolerar un orden de features parcial.
No lo quites sin verificar el arranque en una base vacía.

## 6. Códigos de error de Postgres que el código maneja

| Código | Significado | Dónde |
|---|---|---|
| `23505` | unique_violation | slug duplicado → 409; email de usuario duplicado |
| `42P01` | undefined_table | tragado en el `ALTER` de `users.role` |

Si manejas uno nuevo, hazlo por `err.code`, nunca parseando el mensaje.

## 7. Entornos

| Entorno | Conexión | Schema |
|---|---|---|
| Local | `DATABASE_URL` o `postgres:///maia-landing?host=/var/run/postgresql` | `public` |
| Tests | `TEST_DATABASE_URL` → `DATABASE_URL` → default local | `maia_test_*` efímero |
| Producción (Render) | `DATABASE_URL` con `PGSSL=true` | `public` |

`PGSSL=true` activa `ssl: { rejectUnauthorized: false }`, necesario en
Render/Neon/Supabase. Pool: `max: 10`, `idleTimeoutMillis: 30000`.

## 8. Limpieza de schemas de test huérfanos

Si una suite se corta a mitad puede dejar basura:

```bash
psql -Atc "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'maia_test_%'"
```
