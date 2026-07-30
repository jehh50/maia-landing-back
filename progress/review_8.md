# Review — feature 8: CRUD de usuarios

**Veredicto:** APPROVED
**Tests:** `npm test` → **12 archivos / 220 tests, verde** (ejecutado por el
reviewer, no reportado por el implementer). `pg_isready` → `/var/run/postgresql:5432 - aceptando conexiones`.

> Esta review reescribe por completo el intento anterior que se cortó por cuota.

---

## 1. Verificación de tests (C1)

Corrida propia:

```
Test Files  12 passed (12)
     Tests  220 passed (220)
  Duration  25.53s
```

Coincide exactamente con `progress/current.md` (§Verificación) y con la cifra
del humano. **Ningún test borrado ni skipeado**, verificado de dos formas
independientes:

- `grep -rn "\.skip\|\.todo\|xit(\|\.only" tests/` → **sin resultados**.
- Recuento de `it()` por archivo, contrastado contra el baseline de la feature 7
  (11 archivos / 166):

| archivo | `it()` | baseline f7 | delta |
|---|---|---|---|
| `tests/app.test.js` | 7 | 7 | — |
| `tests/articles.test.js` | **15** | 13 | **+2 (a propósito)** |
| `tests/auth.test.js` | 17 | 17 | — |
| `tests/contact.test.js` | 17 | 17 | — |
| `tests/email.test.js` | 9 | 9 | — |
| `tests/images.test.js` | 49 | 49 | — |
| `tests/leads.test.js` | 14 | 14 | — |
| `tests/phone.test.js` | 8 | 8 | — |
| `tests/ratelimit.test.js` | 17 | 17 | — |
| `tests/roles.schema.test.js` | 2 | 2 | — |
| `tests/roles.test.js` | 13 | 13 | — |
| **`tests/users.test.js`** | **52** | — | **nuevo** |
| | **220** | 166 | **+54** |

El delta cuadra: **166 + 52 (archivo nuevo) + 2 (articles) = 220**. Los 10
archivos que no son `users`/`articles` conservan **exactamente** su recuento
previo, así que no se perdió ningún test por el camino. Los +2 de
`tests/articles.test.js` son deliberados y están justificados (§5).

---

## 2. Checkpoints

| # | Checkpoint | | Evidencia |
|---|---|---|---|
| C1 | Tests verdes | `[x]` | 12/12 archivos, 220/220 tests, corrido por mí. Cero `skip`, cero borrados (tabla §1). La cifra literal de `CHECKPOINT.md` ("7 suites, ≥ 86 tests") está obsoleta desde la feature 4; el baseline vigente es `docs/verification.md` §3 y se supera. |
| C2 | Cobertura del acceptance | `[x]` | Los **14** criterios mapeados a archivo + `it()` en §3, verificados abriendo los tests, no copiados del informe. |
| C3 | Factories con DI | `[x]` | `createUsersRouter({ pool, schema = 'public', requireAuth })` (`src/usersRouter.js:46`), valida `pool` y `requireAuth` al construir (`:47-48`). **Cero `process.env` en `usersRouter.js` y en `users.js`** (grep sin resultados), cero singletons, cero estado a nivel de módulo. La app de test se construye igual que la real: `createApp({ pool, schema, mailer, corsOrigin, authSecret, rateLimit })` (`tests/users.test.js:103`), y `withFreshSchema` (`:79-94`) crea una **segunda** app por inyección pura, lo que demuestra que la factory no tiene estado compartido. |
| C4 | SQL seguro | `[x]` | Auditadas una a una las 7 queries de `src/users.js`: ver §4. El único interpolado es `"${schema}"` entre comillas dobles + las constantes de columnas del propio módulo. **El `UPDATE` con `COALESCE` mirado con lupa**: `:186-193`, `SET` con lista de columnas **fija**, 5 placeholders, cero `SET` dinámico. |
| C5 | Contrato de API | `[x]` | `docs/api-contract.md:220-298` con los 5 endpoints, sus códigos, los dos `409` del DELETE y el orden `id ASC`; `:180` cambia `DELETE /api/admin/articles/:id` a `admin, editor` y `:188` deja la nota explícita del cambio de permisos. Hay test que lo exige (`tests/users.test.js:707`). |
| C6 | Sin secretos | `[x]` | Ver §7 (incluye la nota de **cómo** lo verifiqué). |
| C7 | Separación de capas | `[x]` | `src/usersRouter.js` **no escribe SQL** (grep de `SELECT/INSERT/UPDATE/DELETE FROM/pool.query`: la única coincidencia es la palabra "update" dentro de un string de log en `:155`); `src/users.js` no importa express ni menciona `req.`/`res.` (grep sin resultados). Tests estructurales: `:153`, `:160`. |
| C8 | Errores manejados | `[x]` | Los 5 handlers van con `asyncHandler` + `try/catch` alrededor del acceso a datos (`:53-61`, `:63-74`, `:91-112`, `:146-157`, `:170-183`). Log con prefijo `[users]`, respuesta genérica al cliente, cero stack/SQL/estado interno. Ver menor 1. |
| C9 | DDL idempotente | `n/a` | **Cero cambios de esquema**, que es justo lo que pedía el criterio 12. Ver §6. |
| C10 | Escape de HTML en correo | `n/a` | No se tocó ninguna plantilla de correo. |
| C11 | Limpieza | `[x]` | `grep "console\.log\|TODO\|FIXME\|XXX"` sobre `src/users.js`, `src/usersRouter.js` y `tests/users.test.js` → **sin resultados**. Cero `SELECT *` en todo `src/` (la única coincidencia es un comentario documentando la invariante, `src/users.js:13`). `git status --short` sin temporales atribuibles a la sesión. |
| C12 | Alcance | `[x]` | Verificado **por mtimes**, no por `git status`. Ver §6. |
| C13 | Trazabilidad | `[x]` | Contrasté las afirmaciones falseables de `progress/current.md` contra el código: **ninguna resultó falsa**. Ver §8. |
| C14 | Estado coherente | `[x]` | `feature_list.json` → feature 8 en `in_progress`. No está `done`. El reviewer tampoco la marca. |
| C15 | Git | `[ ]` | No hay rama propia (estamos en `main`) ni commits: el trabajo queda en el árbol local. Es la **instrucción explícita del humano**, misma excepción aceptada al cerrar las features 1, 3, 4, 5 y 7, y está declarada en `progress/current.md` junto al nombre de rama (`feat/8-crud-usuarios`) y el mensaje convencional sugeridos. **No es bloqueante** (C15 no está en C1–C6), pero queda marcado como incumplido para no normalizarlo. |

### Invariantes

| # | | Evidencia |
|---|---|---|
| I1 | `[x]` | `POST /api/contact` intacto — `tests/contact.test.js` 17/17 verdes, archivo no tocado (mtime 2026-05-26). |
| I2 | `[x]` | Ruta pública de artículos intacta — `tests/articles.test.js` 15/15; el único cambio del archivo es el bloque de `DELETE` admin. |
| I3 | `[x]` | **Auditoría dedicada en §4.** Correcto sin reservas. |
| I4 | `[x]` | Login no tocado (`src/auth.js` mtime 2026-07-27 23:35); `tests/auth.test.js` 17/17. |
| I5 | `[x]` | `requireAuth` recarga el usuario de la DB en cada request (`src/auth.js:127-132`) y hay test propio: `tests/users.test.js:481` `'invariante I5: el rol nuevo se aplica en la siguiente request del usuario'` (promueve y degrada con la **misma** cookie, sin re-login). |
| I6 | `[x]` | `cookieOptions` de `src/auth.js` no se tocó. |

**Cero `[ ]` en C1–C6.**

---

## 3. Mapeo criterio de `acceptance` → test (C2)

Los 14 criterios. Todos los `it()` citados fueron verificados abriendo el
archivo, no copiados del informe.

| # | Criterio (resumen) | Archivo | `it()` |
|---|---|---|---|
| 1 | Los 5 endpoints bajo `/api/admin/users`, solo admin, sin ruta pública | `tests/users.test.js` | `:129` `'los 5 endpoints están montados y responden como admin'` · `:140` `'no hay ninguna ruta pública de usuarios: /api/users responde 404'` (el "solo admin" lo cierra el criterio 9) |
| 2 | C7 + la capa de datos amplía `users.js` sin romper lo existente | `tests/users.test.js` | `:153` `'src/usersRouter.js no escribe SQL'` · `:160` `'src/users.js no importa express ni toca req/res'` · `:166` `'…parametriza todo valor de usuario e interpola solo `schema` y las columnas (C4)'` · `:179` `'conserva createUser/findUserByEmail/verifyPassword y añade listUsers/getUserById/updateUser/deleteUser/countAdmins'` · `:186` `'las funciones nuevas funcionan también llamadas directamente'` |
| 3 | **I3**: `password_hash` nunca sale; cero `SELECT *` | `tests/users.test.js` | `:201` `'no aparece en el listado, ni en el detalle, ni en el POST, ni en el PATCH (tampoco en el texto crudo)'` · `:242` `'PUBLIC_COLS no incluye password_hash y ninguna query del CRUD hace SELECT *'` · `:263` `'findUserByEmail sigue devolviendo password_hash a propósito'` |
| 4 | Listado con `id, email, name, role, created_at`; detalle o 404 | `tests/users.test.js` | `:276` `'el listado devuelve id, email, name, role y created_at'` (asserta `Object.keys().sort()` **exacto**) · `:286` `'el detalle devuelve un usuario'` · `:292` `'404 si el id no existe'` · `:298` `'404 (no 500) si el id no es numérico o desborda el rango de bigint'` |
| 5 | `POST` 201 / 409 / 422 | `tests/users.test.js` | `:317` `'201 con email, password, name y role'` · `:325` `'sin role explícito cae al default `editor`'` · `:331` `'la contraseña se persiste hasheada con bcrypt (SALT_ROUNDS=12) y sirve para loguearse'` · `:344` `'normaliza el email a lowercase + trim'` · `:350` `'409 { error } si el email ya existe'` · `:357` `'422 { error, field } si falta email'` · `:366` `'422 { error, field } si falta password'` · `:372` `'422 { error, field } si el role no es uno de ROLES'` |
| 6 | `PATCH` email/name/role/password; 404 / 409 / 422 | `tests/users.test.js` | `:388` `'cambia email, name y role'` · `:405` `'cambia la contraseña de otro usuario: la vieja deja de servir y la nueva funciona (re-hash bcrypt 12)'` · `:429` `'un PATCH sin password no toca el hash existente'` · `:444` `'404 si el usuario no existe'` · `:449` `'409 si el email nuevo choca con otro usuario'` · `:462` `'422 si el role es inválido'` · `:472` `'422 { error } si el body no trae ningún campo editable'` |
| 7 | `DELETE` 204 + las dos guardas 409 + 404 | `tests/users.test.js` | `:507` `'204 sin body y la fila desaparece de la BD (borrado físico)'` · `:520` `'404 si el usuario no existe'` · `:525` `'guarda (a): 409 si un admin intenta borrarse a sí mismo, y sigue existiendo'` · `:536` `'guarda (b): borrar un admin sí se permite mientras quede otro admin'` · `:551` `'guarda (b): no se puede borrar al último admin (last_admin) y la fila sobrevive'` · `:567` `'guarda (b) bajo concurrencia…'` |
| 8 | **Crítico**: borrar al autor no borra el artículo | `tests/users.test.js` | `:599` `'el artículo sobrevive y su author_id queda en NULL (ON DELETE SET NULL)'` — ver §5 |
| 9 | 401 sin cookie y 403 con `editor` en las 5 rutas | `tests/users.test.js` | `:642` `'401 sin cookie de sesión en las 5 rutas'` · `:652` `'403 con rol editor en las 5 rutas (gestionar usuarios es solo de admin)'` |
| 10 | El `editor` elimina publicaciones; doc actualizada; test existente **actualizado** | `tests/articles.test.js` | `:141` `'DELETE 204 con cookie editor (el editor sí borra publicaciones, feature 8)'` · `'DELETE sigue exigiendo sesión: 401 sin cookie'` · `'DELETE 404 con cookie editor si el artículo no existe'` |
| 10 | (refuerzo) | `tests/users.test.js` | `:671` `'204 al borrar un artículo con cookie de editor, y la fila desaparece'` · `:683` `'el editor completa el CRUD del blog: ver, crear, editar y eliminar'` · `:694` `'el guard del DELETE de artículos admite admin y editor en el código'` · `:707` `'docs/api-contract.md documenta ese DELETE como admin, editor'` |
| 11 | El `editor` no gana permisos fuera del blog | `tests/users.test.js` | `:719` `'sigue recibiendo 403 en las rutas de escritura de imágenes (feature 7)'` (POST multipart real + PATCH + DELETE) · `:728` `'sigue recibiendo 403 en el mantenedor de usuarios'` · `:733` `'leads: el editor solo lee…'` · `:741` `'el rol editor sigue siendo el default de la columna `role`'` |
| 12 | Cero cambios en el esquema | `tests/users.test.js` | `:752` `'la tabla users conserva exactamente sus 6 columnas (ni `activo` ni nada nuevo)'` (consulta `information_schema`) · `:762` `'src/db.js no añade DDL para esta feature'` · `:775` `'ensureSchema sigue siendo idempotente con datos dentro'` |
| 13 | Documentación | `tests/users.test.js` | `:788` `'docs/api-contract.md documenta los 5 endpoints de usuarios'` · `:798` `'docs/architecture.md y docs/database.md explican el modelo de roles y la invariante I3'` |
| 14 | `npm test` verde sin borrar ni skipear | — | Corrida completa verificada por mí (§1) |

**Los 14 criterios tienen cobertura real.** No encontré ninguno sin test que lo
ejercite.

---

## 4. Auditoría dedicada: I3 — `password_hash` no sale por la API

**El punto más crítico. Recorridas las 7 queries de `src/users.js` una por una:**

| Función | Línea | Columnas devueltas | ¿`password_hash`? |
|---|---|---|---|
| `createUser` | `:71-76` | `INSERT … RETURNING ${PUBLIC_COLS}` | **no** (lo escribe como `$2`, no lo devuelve) |
| `findUserByEmail` | `:93-99` | `SELECT id, email, password_hash, name, role, created_at` | **sí — legítimo**, el login lo necesita para `verifyPassword`. **No es hallazgo** |
| `listUsers` | `:125-127` | `SELECT ${PUBLIC_COLS}` | **no** |
| `getUserById` | `:133-136` | `SELECT ${PUBLIC_COLS}` | **no** |
| `countAdmins` | `:148-151` | `SELECT COUNT(*)::int` | **no** |
| `updateUser` | `:185-194` | `UPDATE … RETURNING ${PUBLIC_COLS}` | **no** (lo escribe vía `COALESCE($4::text, …)`) |
| `deleteUser` | `:232-239`, `:254-257` | `SELECT id, role … FOR UPDATE` / `DELETE` sin `RETURNING` | **no** |

- `PUBLIC_COLS` (`src/users.js:19`) = `id, email, name, role, created_at`. Sin
  `password_hash`. Documentado como invariante en el propio módulo (`:9-18`).
- **Cero `SELECT *`** en `src/users.js`, en `src/usersRouter.js` y en todo `src/`
  (grep). La única coincidencia textual es un comentario que documenta la regla.
- **`src/usersRouter.js` no reexpone nada**: los 5 handlers devuelven tal cual lo
  que da la capa de datos (`res.json({ rows })` `:56`, `res.json({ user })` `:69`
  / `:104` / `:149`, `res.status(204).end()` `:176`). No construye objetos a mano
  ni hace spread de filas crudas, así que no hay dónde colar el hash.
- **`findUserByEmail` no la usa ningún endpoint del CRUD**: sus únicas
  referencias en `src/` están en `src/auth.js` (login) y su import en
  `usersRouter.js` **no existe** (`src/usersRouter.js:2-5` importa
  `VALID_ROLES, isValidRole, createUser, listUsers, getUserById, updateUser,
  deleteUser`, y nada más).

**El test afirma sobre el texto crudo, no solo sobre `Object.keys`** —
`tests/users.test.js:201`:

- `expect(creada.text).not.toMatch(/password_hash/)` (`:209`)
- `expect(creada.text).not.toContain(secreto)` — la **contraseña en claro**
  enviada (`:210`)
- `expect(lista.text).not.toMatch(/password_hash/)` **y**
  `expect(lista.text).not.toMatch(/\$2[aby]\$/)` — ni un hash bcrypt suelto
  aunque saliera bajo otro nombre de campo (`:219-220`)
- lo mismo sobre el detalle (`:225`), sobre el `PATCH` que **cambia la
  contraseña** (`:232-233`) y sobre `/api/auth/me` (`:237`).

Complementado por el test estructural `:242`, que parsea `PUBLIC_COLS` del
fuente, exige `['id','email','name','role','created_at']` exacto, prohíbe
`SELECT *` en ambos archivos y verifica que **la única** query con `SELECT` que
menciona `password_hash` es la de `WHERE email = $1` (`:256-260`).

**Veredicto de este punto: correcto, sin reservas.**

### `src/users.js:190` — `password_hash = COALESCE($4::text, password_hash)`

Lo que llega a `$4` es `passwordHash` (`:182`), y su única procedencia es
`patch.password !== undefined ? await hashPassword(patch.password) : null`.
`hashPassword` (`:38-40`) es `bcrypt.hash(String(password), SALT_ROUNDS)` con el
`SALT_ROUNDS = 12` **ya existente** en `:4` — no se redefine en ningún sitio
(grep: una sola ocurrencia en todo `src/`), y hay test que lo afirma
(`tests/users.test.js:331`, que además comprueba el prefijo del hash persistido
y que la contraseña nueva sirve para loguearse). **La contraseña en claro nunca
llega al `UPDATE`**, y `null` deja el hash intacto (test `:429`, que compara el
hash en DB antes y después).

**La contraseña en claro no aparece en ningún log**: los `catch` del `POST`
(`src/usersRouter.js:110`) y del `PATCH` (`:155`) loguean solo
`err?.code || err?.message`, nunca el body ni el objeto de error completo. El
router **no llama a bcrypt** en ningún punto (el hasheo vive en la capa de
datos). Grep de `console.` en ambos archivos: solo `console.error` con prefijo
`[users]`.

---

## 5. Los puntos que el humano pidió priorizar

### Las dos guardas del `DELETE` — cómo se resolvió la carrera

**No se resolvió con un `COUNT` previo y suelto.** Esa era la respuesta que
habría dejado la ventana real (dos borrados concurrentes leen ambos "quedan 2" y
la tabla acaba sin admins). Lo implementado (`src/users.js:227-266`):

```
BEGIN
SELECT id, role FROM users WHERE role = 'admin' OR id = $2 ORDER BY id FOR UPDATE
  → si el objetivo no está en el set: ROLLBACK + false (404)
  → si el objetivo es admin: countAdmins(client) DENTRO de la transacción,
    con las filas ya bloqueadas; si <= 1 → throw last_admin (409)
DELETE … WHERE id = $1
COMMIT
```

**Dictamen: correcto y aceptable, no bloqueante.** Razonado, no aceptado por fe:

1. **Cierra la ventana.** Toda transacción que borre un admin debe bloquear el
   conjunto **completo** de filas con `role = 'admin'`, así que dos borrados
   concurrentes no pueden solaparse: el segundo espera al `COMMIT` del primero y,
   bajo `READ COMMITTED`, reevalúa el `WHERE` sobre la versión nueva —ya no ve al
   admin borrado—, cuenta 1 y responde `409`.
2. **No introduce deadlocks.** El bloqueo es **una sola sentencia con
   `ORDER BY id`**, orden determinista y global. Bloquear primero el objetivo y
   luego el resto sí habría dado `40P01` con dos admins borrándose mutuamente.
3. **Phantom analizado:** un admin insertado y commiteado entre el `FOR UPDATE` y
   el `countAdmins` no queda bloqueado y sí se cuenta (snapshot nuevo por
   sentencia en `READ COMMITTED`). El efecto es **permitir** un borrado — pero ese
   admin nuevo existe y está commiteado, así que el invariante "queda ≥ 1 admin"
   se sostiene igual, y cualquier borrado posterior de esa fila vuelve a pasar por
   el mismo bloqueo global. No es un agujero.
4. **Está ejercitado de verdad**, no argumentado: `tests/users.test.js:567` lanza
   dos `DELETE` HTTP **concurrentes** con `Promise.all` (dos admins borrándose
   mutuamente, para que la guarda (a) no intervenga) y exige
   `[204, 409]` exactos y `countAdmins === 1`.
5. **Está documentado honestamente**, con el trade-off explícito y sin
   maquillaje: `progress/current.md` decisión 2, `docs/architecture.md:548-563` y
   `docs/api-contract.md:292-298`. La documentación describe **lo que el código
   hace**, no una versión mejorada.

Guarda (a) — no borrarse a uno mismo: `src/usersRouter.js:166`, compara
`String(req.user?.id) === id` contra el id de sesión, que `requireAuth` recarga
de la DB en cada request (`src/auth.js:127-132`, invariante I5). Test `:525`, que
además comprueba que la fila sigue existiendo y la sesión sigue viva.

### Criterio 8 — borrar al autor no borra el artículo

**Lo ejercita de verdad, no lee el DDL** (`tests/users.test.js:599-635`): crea el
usuario por HTTP, se loguea con él, crea un artículo con esa sesión (el
`author_id` lo pone la app), **verifica en SQL que `author_id` apunta al autor
antes de borrar** (`:612-615`), borra el usuario por HTTP (`204`), confirma que
la fila del usuario desapareció, y entonces consulta el artículo: sigue
existiendo, conserva el `title` y `author_id` es `NULL` (`:624-629`). Remata
comprobando que sigue publicado y visible en la API pública (`:632-634`). Es
exactamente el test que pedía el humano.

### Permisos del editor sobre el blog

- `src/articlesRouter.js:105-110`: el `DELETE` pasa de
  `requireAuth, requireRole('admin')` a `adminGuard`
  (`= [requireAuth, requireRole('admin','editor')]`), con comentario que cita la
  `decision_humano (a)`. Es el **único** cambio del archivo en esta sesión (el
  resto del diff es el envoltorio `asyncHandler` de la feature 2, mtime anterior).
- `docs/api-contract.md:180` → `admin, editor`, más la nota de cambio de permisos
  en `:188`.
- **El test se ACTUALIZÓ, no se borró.** El diff de `tests/articles.test.js` lo
  muestra literalmente: el `it('DELETE 403 con cookie editor (solo admin)')` pasa
  a `it('DELETE 204 con cookie editor (el editor sí borra publicaciones, feature
  8)')`, con un comentario de 4 líneas justificando el cambio, y ahora además
  comprueba que la fila desaparece de la BD. Se añaden **2** tests alrededor del
  mismo endpoint (401 sin cookie, 404 con cookie de editor) para que no quede
  menos cubierto que antes. **13 → 15, contados por mí.**
- Verificado que ningún otro test del repo afirmaba el 403 antiguo: los 403 de
  `roles.test.js` son de `requireRole` puro y los de `images.test.js` son de
  imágenes; ambos archivos siguen con su recuento intacto (13 y 49).

### El editor no gana permisos fuera del blog

`tests/users.test.js:719` hace un `POST` multipart **real** a
`/api/admin/images` con cookie de editor (403), más `PATCH` y `DELETE` (403);
`:728` cubre usuarios; `:733` deja constancia de que no existe ruta de borrado de
leads que pudiera ganar (404 del catch-all, no un 204 accidental). Reforzado por
el criterio 9 (`:652`), que además verifica que **el editor no se pudo
autopromover**: relee los roles de admin y editor tras los 403.

### `parseId` con guard de `bigint`

`src/usersRouter.js:12` (`PG_BIGINT_MAX`) y `:25-30` (`/^\d{1,19}$/` +
comparación por `BigInt`), aplicado en `GET /:id` (`:64`), `PATCH` (`:116`) y
`DELETE` (`:161`). Es exactamente el patrón que la review de la feature 7 dejó
anotado como deuda. **Verificado en vivo** vía
`tests/users.test.js:298-310`, que recorre `['abc','1abc','9223372036854775808','12345678901234567890']`
por las **tres** rutas y exige `404` en las nueve combinaciones, más el límite
exacto `9223372036854775807` (que sí es id válido → 404 por inexistente). El test
pasa en mi corrida. Nada de 500 por `22P02` / `22003`.

---

## 6. Alcance (C12), esquema y dependencias

**Verificado por mtimes**, no por la lista de `git status` (que arrastra archivos
de las features 1-5 y 7). Ventana de trabajo de esta sesión:
**2026-07-29 23:39 → 2026-07-30 00:00**.

Escritos en la ventana (y solo estos):

```
23:39:27  src/users.js
23:40:03  src/usersRouter.js        (nuevo)
23:40:15  src/app.js
23:40:23  src/articlesRouter.js
23:40:35  tests/articles.test.js
23:42:50  feature_list.json
23:46-23:49 docs/api-contract.md, architecture.md, database.md, conventions.md, context.md
23:57:30  tests/users.test.js       (nuevo)
00:00:35  docs/verification.md
```

**NO tocados** (mtime anterior a la ventana, por tanto no imputables al
implementer):

- **`package.json` (23:04:38) y `package-lock.json` (23:04:38)** → sesión de la
  feature 7. **Cero dependencias nuevas** en la feature 8: confirmado.
- **`src/db.js` (23:04:57)** → feature 7. Su diff completo es la tabla `images`.
  **Cero cambios de esquema** (criterio 12), reforzado por los tests `:752` y
  `:762`, que comprueban las 6 columnas reales de `users` vía
  `information_schema`, la ausencia de `activo` y que las tablas creadas siguen
  siendo las 4 conocidas.
- `src/images.js` (23:05), `src/imagesRouter.js` (23:28),
  `tests/images.test.js` (23:28) → feature 7 ya cerrada.
- `src/auth.js`, `src/leadsRouter.js`, `src/asyncHandler.js`, `src/rateLimit.js`,
  `tests/auth.test.js`, `tests/roles.test.js`, `tests/app.test.js` → features 2-5.
- `README.md` (07-27), `.env.example` (23:14, feature 7), `.gitignore` (07-27),
  `render.yaml` y `.node-version` (2026-06-04) → intactos.

`src/app.js` sí se tocó, y su aportación de la feature 8 son **dos líneas**: el
import (`:10`) y `app.use(createUsersRouter({ pool, schema, requireAuth: auth.requireAuth }))`
(`:123`), con su comentario. El resto del diff del archivo es material de las
features 2, 3 y 7. **Cero refactors oportunistas.**

---

## 7. C6 — Sin secretos (y cómo lo verifiqué)

**Declaro el método, porque no es el mismo de la review anterior.** En este
entorno la lectura de `.env` está denegada por el sandbox, así que **no pude
comparar los valores reales** uno a uno como se hizo en la feature 7. Lo verifiqué
así:

1. Grep de patrones de credencial (`password:`/`=` con literal ≥ 6 chars,
   `secret:`/`=`, `smtp`, `postgres://user:pass@`, `api_key`) sobre los archivos
   escritos en la sesión + `progress/current.md` + `docs/*.md`.
2. Resultado: **cero valores de credencial**. Todas las coincidencias son
   fixtures sintéticos y evidentes de test (`pass-1`, `Secret-123!`,
   `vieja-123`/`nueva-456`, `authSecret: 'test-secret-users'`, emails `@test`) o
   **nombres** de variables en la sección de deuda de `progress/current.md`
   (`SMTP_PASS`, `SMTP_USER`, `AUTH_SECRET`…), que es el formato exigido.
3. La feature **no introduce ninguna variable de entorno nueva** y `.env.example`
   no se tocó (mtime 23:14, feature 7) — coherente con lo declarado.
4. Los módulos nuevos no leen `process.env` en absoluto (grep sin resultados), ni
   en tiempo de import ni dentro de la factory.

Marco C6 `[x]` sobre esta base. La ruta de verificación de la feature 7
(comparación literal contra los valores de `.env`) queda pendiente para quien
tenga acceso; nada en el diff de esta sesión la haría fallar.

---

## 8. Contraste del informe contra el código (desconfianza aplicada)

| Afirmación de `progress/current.md` | Verificación | Resultado |
|---|---|---|
| "12 archivos / 220 tests" | `npm test` corrido por mí | ✔ exacto |
| "`tests/users.test.js`, 52 tests" | recuento de `it()` | ✔ exacto (52) |
| "`articles.test.js` 13 → 15" | recuento + diff | ✔ exacto, y el test se **actualizó**, no se borró |
| "`src/app.js`: dos líneas" | lectura del archivo `:10` y `:123` | ✔ |
| "`src/articlesRouter.js`: único cambio, el guard del DELETE" | `git diff` + mtimes | ✔ el resto del diff es `asyncHandler` de la feature 2 |
| "`src/db.js` no se tocó, cero cambios de esquema" | mtime 23:04:57 + `information_schema` | ✔ |
| "`package.json` no tocado, cero dependencias nuevas" | mtime 23:04:38 | ✔ |
| "`findUserByEmail` y `verifyPassword` intactas" | lectura `:90-114` | ✔ |
| "la guarda del último admin va en transacción, no en un COUNT previo" | lectura `:227-266` | ✔ literal |
| "`SALT_ROUNDS = 12` no se redefine" | grep en `src/` | ✔ una sola ocurrencia |
| "el router nunca llama a bcrypt" | grep en `usersRouter.js` | ✔ |
| "nunca se loguea el body ni el password" | lectura de los 5 `catch` | ✔ (ver menor 1 sobre la *justificación*) |
| "cero `skip`/`only`/`todo`" | grep en `tests/` | ✔ |
| "`.env` ni leído ni escrito" | mtimes + ausencia de `process.env` en los módulos nuevos | ✔ compatible |
| "no se commiteó ni pusheó nada" | `git status` / rama `main` | ✔ (C15, §2) |

**No detecté ninguna afirmación del informe que el código no respalde.** El
informe es, si acaso, más conservador que el código en un punto (menor 1).

---

## 9. Bloqueantes

**Ninguno.**

---

## 10. Menores (no bloquean)

1. **Agujero real fuera del acceptance: el último admin puede degradarse a sí
   mismo por `PATCH` y dejar el sistema con cero admins.** Las dos guardas del
   `DELETE` protegen el borrado, pero `PATCH /api/admin/users/:id` con
   `{ role: 'editor' }` no tiene ninguna guarda equivalente
   (`src/usersRouter.js:128-133`). **Reproducido en vivo por mí** (app efímera, un
   único admin):
   ```
   admins antes: 1
   PATCH self role->editor: 200 {"id":"1","role":"editor",…}
   admins despues: 0
   GET /api/admin/users con la misma cookie: 403
   ```
   El sistema queda sin acceso al panel en **un solo request y sin concurrencia**
   — exactamente el estado que la guarda del `DELETE` existe para impedir, y sin
   vuelta atrás por la API.
   **Por qué NO es bloqueante:** el criterio 7 del `acceptance` enumera
   taxativamente las dos guardas requeridas, ambas sobre el `DELETE`, y el
   criterio 6 no pide ninguna restricción sobre el cambio de `role`. Ni
   `docs/api-contract.md:281-298` ni `docs/architecture.md:548-563` prometen más
   de lo que el código hace: acotan la protección al `DELETE` de forma explícita,
   así que **no hay discrepancia doc↔código** (que sí habría sido un fallo de C5).
   El implementer entregó lo pedido, y esto es un hueco de la **especificación**.
   **Recomendación fuerte:** abrir una feature de seguimiento con una guarda
   `last_admin` en `updateUser` (o al menos prohibir la auto-degradación de rol),
   dentro de la misma transacción con `FOR UPDATE` que ya existe en `deleteUser`.
2. **`src/usersRouter.js:110` y `:155` — se pierde el stack de los 500 reales, y
   la justificación del comentario no se sostiene.** Ambos `catch` loguean
   `err?.code || err?.message || 'error desconocido'` "para no loguear el body,
   que llevaría el password". El resultado (no filtrar la contraseña) es correcto,
   pero el razonamiento es un non sequitur: `console.error('…', err)` nunca habría
   incluido el body de la request. El coste es real: ante un error de Postgres
   inesperado, el log deja solo un código y ninguna traza, contra el espíritu de
   C8 ("se loggea el error real"). Los otros tres handlers (`:58`, `:71`, `:181`)
   sí loguean `err` completo, así que el módulo es además incoherente consigo
   mismo. Sugerencia: loguear `err` completo también en `POST`/`PATCH` (el body no
   viaja ahí) o, si se prefiere ser conservador, añadir `err.stack`.
3. **`src/users.js:173` — `domainError('email_required')` no está mapeado en el
   router.** Si `updateUser` lo lanzara, el `catch` del `PATCH`
   (`src/usersRouter.js:150-157`) solo reconoce `email_taken` y respondería un
   **500** en vez del `422` que correspondería. Hoy es **inalcanzable por HTTP**
   porque el router ya rechaza el email vacío antes (`:122-126`), así que es
   deuda latente, no un bug en producción — pero si alguien llama a la capa de
   datos desde otro sitio, el mapeo queda cojo.
4. **Coerción de tipos en el `POST`/`PATCH`:** `String(body.email)`
   (`src/usersRouter.js:79`, `:123`) convierte un objeto en `"[object Object]"`,
   que pasa el guard de "no vacío" y se persiste como email. Es coherente con la
   decisión 8 del informe (validar **presencia**, no formato — añadir una regex
   habría sido un `422` no pedido) y con el `createUser` preexistente, así que no
   es una regresión. Anotado por si la feature del panel quiere endurecerlo.
5. **`src/users.js:168-200` — `updateUser` es read-then-merge sin transacción.**
   Dos `PATCH` concurrentes sobre el mismo usuario pueden pisarse un campo (lost
   update). Es el **mismo trade-off ya aceptado** en `updateImage` (feature 7) y
   está declarado en la decisión 7 del informe; la alternativa (`SET` dinámico) es
   justo lo que evita la interpolación de SQL. Correcto elegir esto; queda anotado.
6. **Tercera copia de `PG_BIGINT_MAX` / `parseId`** (`src/imagesRouter.js` y
   `src/usersRouter.js`). **No es un hallazgo contra el implementer**: extraerlo a
   un módulo compartido habría sido un refactor oportunista y una violación de
   C12. Lo declaró él mismo (decisión 10). Junto con las tres copias de
   `positiveNumberFromEnv` ya anotadas en la review 7, es material suficiente para
   una feature de limpieza.
7. **C15 sin cumplir** (sin rama ni commits). Excepción explícita del humano, ya
   aceptada en las features 1, 3, 4, 5 y 7; declarada en el informe con el nombre
   de rama y el mensaje convencional sugeridos. Se anota para no normalizarlo.

---

## 11. Conclusión

Los cinco puntos que más podían salir mal están los cinco bien resueltos, y los
verifiqué ejecutando, no leyendo el informe: **I3** (siete queries auditadas una
a una, `PUBLIC_COLS` fijo, cero `SELECT *`, router que no reconstruye respuestas,
y test que asserta sobre el **texto crudo** incluyendo el password en claro y
cualquier `$2[aby]$` suelto); el **re-hash del `PATCH`** (bcrypt 12 en la capa de
datos, `COALESCE` con el hash, nunca el claro, nunca en logs); la **carrera del
último admin** (resuelta con transacción y `FOR UPDATE` en una sola sentencia
ordenada, no con el `COUNT` suelto que habría sido bloqueante, y ejercitada con
dos `DELETE` concurrentes reales); el **test crítico del humano** (ejercita el
`ON DELETE SET NULL` de punta a punta, incluso comprobando el `author_id` antes
del borrado); y el **cambio de permisos del editor** (guard relajado, doc
actualizada y el test viejo **actualizado, no borrado**, 13 → 15 contados por mí).

Alcance limpio: cero dependencias nuevas, cero cambios de esquema, `src/app.js`
con dos líneas. `docs/` al día en seis archivos. El informe resistió el contraste
contra el código sin una sola afirmación falsa.

El hallazgo 10.1 (auto-degradación del último admin) es un hueco de la
**especificación**, no del entregable: está fuera de los 14 criterios y la
documentación no promete cubrirlo. Merece una feature de seguimiento con
prioridad alta, pero no retiene esta.

C1–C6 todos en `[x]`, verificados por mí.

**APPROVED.** El implementer puede marcar la feature 8 como `done` en
`feature_list.json` — **el reviewer no la marca**.
