# Review — feature 7: CRUD de imagenes.

**Veredicto:** APPROVED
**Tests:** `npm test` → 11 archivos / 164 tests (verde). Ejecutado por el
reviewer, no reportado por el implementer. `pg_isready` OK.

---

## 1. Verificación de tests (C1)

Ejecutado por mí:

```
Test Files  11 passed (11)
     Tests  164 passed (164)
  Duration  9.64s
```

Coincide exactamente con lo que reporta `progress/current.md:250-251`.

**Ningún test borrado ni skipeado.** Verificado de dos formas:

- `grep -rn "\.skip\|\.todo\|xit(" tests/` → **sin resultados**.
- Recuento de `it()` por archivo, contrastado con el baseline de
  `docs/verification.md` §3 (10 archivos / 117):

| archivo | `it()` | ¿estaba en el baseline? |
|---|---|---|
| `tests/app.test.js` | 7 | sí |
| `tests/articles.test.js` | 13 | sí |
| `tests/auth.test.js` | 17 | sí |
| `tests/contact.test.js` | 17 | sí |
| `tests/email.test.js` | 9 | sí |
| `tests/leads.test.js` | 14 | sí |
| `tests/phone.test.js` | 8 | sí |
| `tests/ratelimit.test.js` | 17 | sí |
| `tests/roles.schema.test.js` | 2 | sí |
| `tests/roles.test.js` | 13 | sí |
| **`tests/images.test.js`** | **47** | **nuevo (feature 7)** |
| | **164** | 117 + 47 = 164 ✔ |

Los 10 archivos previos suman exactamente 117 — el baseline íntegro. El delta es
solo el archivo nuevo. Además, los mtimes confirman que **ningún test existente
se tocó** en esta sesión (todos con fecha ≤ 2026-07-28; `tests/images.test.js` es
el único de 2026-07-29 23:11).

---

## 2. Checkpoints

- **C1 — Tests verdes:** `[x]` 11/11 archivos, 164/164 tests, verificado por mí.
  Cero `skip`, cero borrados (tabla arriba). La cifra de `CHECKPOINT.md` C1
  ("7 suites, ≥ 86 tests") está obsoleta desde la feature 4; el baseline vigente
  es el de `docs/verification.md` §3 y se cumple con margen.
- **C2 — Cobertura del acceptance:** `[x]` Mapeo completo en §3, criterio por
  criterio, con archivo y nombre de `it()` verificados uno a uno en el archivo
  real (no copiados del informe).
- **C3 — Factories con DI intactas:** `[x]`
  `createImagesRouter({ pool, schema = 'public', requireAuth, maxFileSize })`
  (`src/imagesRouter.js:79`), valida `pool` y `requireAuth` al construir
  (`:80-81`). `process.env` se lee **dentro** de la factory
  (`src/imagesRouter.js:83`), nunca en tiempo de import — cero singletons. La app
  de test se construye igual que la real:
  `createApp({ pool, schema, mailer, authSecret })` (`tests/images.test.js:74`),
  y la segunda app del 413 solo añade `images: { maxFileSize }` (`:77-80`),
  demostrando que la inyección funciona sin env.
- **C4 — SQL seguro:** `[x]` Auditadas **todas** las queries de `src/images.js`
  una por una: `createImage` (`:97-110`, 7 placeholders), `getImageById`
  (`:116-119`), `getImageWithBytes` (`:128-131`), `listImages` (`:146-152`),
  `updateImage` (`:174-180`, 4 placeholders), `deleteImage` (`:185-188`). El
  único interpolado en las 6 es `"${schema}"` entre comillas dobles, más las
  constantes de columnas del propio módulo. **El `PATCH` no construye un `SET`
  dinámico**: `updateImage` (`:164-182`) lee la fila actual, hace merge en
  memoria y ejecuta un `UPDATE` con lista de columnas **fija** y `$1..$4` — el
  sitio clásico de la interpolación colada aquí no existe. El fragmento `where`
  de `listImages` (`:140-145`) se arma en el módulo con `$${params.length}` y el
  valor viaja en `params`; hay test estructural que lo verifica
  (`tests/images.test.js:573-595`).
- **C5 — Contrato de API:** `[x]` `docs/api-contract.md` actualizado en el mismo
  cambio: cabecera con las excepciones al "todo es JSON" (`:9-13`), los dos GET
  públicos (`:93-124`) y la sección "Imágenes (feature 7)" en Admin con la tabla
  de los tres endpoints de escritura y el detalle de `POST`/`PATCH`
  (`:202-262`). Los códigos 413/415 y la invariante de `bytes` están escritos.
- **C6 — Sin secretos:** `[x]` Comprobación programática: cargué las 9 variables
  de `.env` con valor de ≥ 6 caracteres y busqué cada valor en los 13 archivos
  tocados. **Cero coincidencias de variables sensibles** (`SMTP_PASS`,
  `AUTH_SECRET`, `MAIA_ADMIN_PASSWORD`, `SMTP_USER`, `MAIA_ADMIN_EMAIL`). Las
  coincidencias que salieron son de `DB_SCHEMA` (valor `public`, palabra
  genérica) y de `DATABASE_URL` (socket local `postgres:///…` sin credenciales,
  verificado: no contiene `usuario:password@`). Ningún valor se imprimió en esta
  sesión de review. `IMAGES_MAX_FILE_SIZE_BYTES` está en `.env.example:94` **por
  nombre**, con propósito y default documentados, y es opcional (no es secreto).
- **C7 — Separación de capas:** `[x]` `src/imagesRouter.js` no tiene `pool.query`
  ni SQL (verificado con grep, además del test `:559-565`); `src/images.js` no
  importa express ni toca `req`/`res` (test `:567-571`). `sniffMime`,
  `extensionOf`, `extensionMatchesMime`, `isValidSeccion` son puros y están en la
  capa de datos, precedente ya asentado por `slugify` en `articles.js` y anotado
  en `docs/conventions.md` §3.
- **C8 — Errores manejados:** `[x]` Los 5 handlers van con `asyncHandler` y
  `try/catch` alrededor del acceso a datos; se loggea con prefijo
  `[images]` (`:129, :152, :171, :223, :262, :275`) y al cliente va un mensaje
  genérico. Cero stack, cero SQL, cero estado interno al cliente (confirmado
  ejercitando un 500 real, ver §5 hallazgo menor 1).
- **C9 — DDL idempotente:** `[x]` `src/db.js:110-124`: `CREATE TABLE IF NOT
  EXISTS` + `CREATE INDEX IF NOT EXISTS` (`:125`). Cero `DROP`, cero `ALTER`,
  cero `UPDATE`/`DELETE` de datos. Verificado **por mí, aparte del test**: corrí
  `ensureSchema` **tres veces** sobre un schema con una fila insertada en medio →
  sin error y la fila conservada (`ensureSchema x3 OK, filas conservadas = 1`).
  `docs/database.md` actualizado (`:74`, `:78-105`, `:118-120`).
- **C10 — Escape de HTML en correo:** `n/a` — no se tocó ninguna plantilla.
- **C11 — Limpieza:** `[x]` Cero `console.log`, cero `TODO`/`FIXME` en los tres
  archivos nuevos (grep sin resultados). El único log es `console.error` con
  prefijo. `git status` sin temporales atribuibles a la sesión. Cero `SELECT *`
  en todo `src/`.
- **C12 — Alcance:** `[x]` Verificado por mtimes, no por el informe. Solo estos
  archivos se escribieron en la ventana 23:04-23:18 del 2026-07-29:
  `src/images.js`, `src/imagesRouter.js`, `tests/images.test.js`, `src/db.js`,
  `src/app.js`, `package.json`, `package-lock.json`, `.env.example`,
  `feature_list.json`, `docs/*`, `progress/current.md`.
  - **`src/articlesRouter.js` NO se tocó** (mtime 2026-07-27 23:03, sesión de la
    feature 2) y `src/articlesRouter.js:105` **sigue con
    `requireRole('admin')`** en el `DELETE` — la feature 8 no se ha adelantado.
    Sus cambios en `git diff` son el envoltorio `asyncHandler` de la feature 2,
    anteriores a esta sesión, y no se le imputan al implementer.
  - `src/auth.js` (mtime 07-27 23:35) y `src/leadsRouter.js` (07-27 23:03):
    idéntica situación, features 3/5.
  - `render.yaml` y `.node-version`: mtime **2026-06-04**, intactos.
  - `src/app.js`: el diff completo solo contiene material atribuible a las
    features 2 (errorHandler/asyncHandler), 3 (rate limiting/trust proxy) y 7
    (import + `app.use(createImagesRouter(...))` en `:121-126`). Cero refactors
    oportunistas.
- **C13 — Trazabilidad:** `[x]` `progress/current.md` refleja lo realmente hecho;
  contrastado contra el código, no se detectó ninguna afirmación falsa (ver §4).
  Único defecto: hallazgo menor 2.
- **C14 — Estado coherente:** `[x]` Feature 7 en `in_progress` en
  `feature_list.json:20`. **No** está marcada `done`. El reviewer tampoco la
  marca.
- **C15 — Git:** `[ ]` No hay rama propia (estamos en `main`) ni commits: el
  trabajo queda en el árbol local. Es la **instrucción explícita del humano**,
  la misma excepción ya aceptada al cerrar las features 1, 3, 4 y 5, y está
  declarada en `progress/current.md:220-224` junto al nombre de rama y el mensaje
  de commit convencional sugeridos. **No es bloqueante** (C15 no está en C1–C6),
  pero queda marcado como incumplido para no normalizarlo.

### Invariantes

- **I1** `[x]` `POST /api/contact` intacto (`tests/contact.test.js` 17/17 verdes).
- **I2** `[x]` Ruta pública de artículos intacta (`tests/articles.test.js` 13/13).
- **I3** `[x]` `publicUser` intacto; `tests/auth.test.js` 17/17.
- **I4** `[x]` Login intacto.
- **I5** `[x]` `loadSession` recarga el rol de DB; el 403 del `editor` en las
  rutas de imágenes lo ejercita de hecho.
- **I6** `[x]` `cookieOptions` no se tocó.
- **Análogo de I3 para `bytes`** `[x]` — auditoría dedicada en §6.

---

## 3. Mapeo criterio de `acceptance` → test (C2)

`feature_list.json` tiene **14** criterios (no 13). Todos los `it()` citados
fueron verificados abriendo `tests/images.test.js`, no copiados del informe.

| # | Criterio | `it()` que lo cubre (todos en `tests/images.test.js`) | ✔ |
|---|---|---|---|
| 1 | Tabla `images` en `ensureSchema`, `IF NOT EXISTS`, columnas, `docs/database.md` | `:97` `'crea la tabla images con todas las columnas esperadas y bytes en BYTEA'` (consulta `information_schema`, comprueba las 10 columnas + `bytea` + `alt` nullable) · `:113` `'es idempotente: correr ensureSchema de nuevo no falla ni borra datos existentes'` · `:615` `'docs/database.md documenta la tabla images'` | sí |
| 2 | Prefijo `/api/<recurso>` público, `/api/admin/<recurso>` escritura, 5 endpoints | `:132` `'la escritura vive en /api/admin/images: POST /api/images no existe (404)'` (afirma explícitamente que la ruta **antigua** no existe) · `:139` `'los 5 endpoints están montados en las rutas convenidas'` | sí |
| 3 | `POST /api/admin/images` → 201 con metadatos, sin `bytes` | `:157` `'201 con los metadatos de la imagen creada y SIN el campo bytes'` · `:174` `'persiste el binario íntegro (el /raw devuelve exactamente los bytes subidos)'` | sí |
| 4 | 422 falta archivo/`seccion`/`seccion` inválida · 415 MIME · 413 tamaño · todo JSON | `:187` `'422 { error, field } si no viene archivo'` · `:194` `'422 { error, field } si falta seccion'` · `:200` `'422 { error, field } si seccion no es un valor válido'` · `:206` `'422 si orden no es un entero >= 0'` · `:212` `'415 { error, field: "file" } si el MIME no está en la whitelist'` · `:218` `'413 { error, field: "file" } si el archivo excede el límite de tamaño (JSON, no crash ni 500)'` (asserta `content-type: application/json`) · `:226` `'el mismo archivo pasa con el límite por defecto…'` · `:233` `'todos los errores de subida responden JSON, nunca el HTML por defecto de Express'` | sí |
| 5 | Whitelist png/jpeg/webp; SVG excluido y el motivo en `docs/architecture.md` | `:249` `'la whitelist es exactamente image/png, image/jpeg e image/webp'` · `:254` `'acepta los tres formatos de la whitelist'` · `:268` `'415 al subir un SVG: está excluido a propósito (XSS al servirlo en crudo)'` · `:274` `'el motivo de excluir SVG está escrito en docs/architecture.md'` (lee el doc y exige que mencione XSS) · `:281` `'415 si el cliente miente en el mimetype: se validan los magic bytes reales'` · `:288` `'415 si la extensión no corresponde al MIME declarado'` · `:293` `'sniffMime reconoce png/jpeg/webp y devuelve null para lo demás (nunca lanza)'` · `:303` `'extensionOf / extensionMatchesMime / isValidSeccion son puros y coherentes'` | sí |
| 6 | `GET /api/images` público, `?seccion=`, orden ASC, `bytes` nunca en JSON | `:344` `'200 sin cookie: es público'` · `:351` `'devuelve la lista ordenada por orden ascendente'` (seeds insertados desordenados 3-1-2, espera `hero-1,hero-2,hero-3`) · `:359` `'filtra por ?seccion='` · `:367` `'422 si ?seccion= no es una sección válida'` · **`:373` `'el campo bytes NUNCA sale en el JSON (análogo de la invariante I3)'`** · `:394` `'src/images.js solo lee la columna bytes en la query del endpoint /raw'` | sí |
| 7 | `GET /api/images/:id/raw` con Content-Type real; 404 si no existe | `:409` `'sirve el binario con su Content-Type real, sin cookie'` (compara bytes con `Buffer.compare`, verifica `content-length` y `nosniff`) · `:421` `'404 si el id no existe'` · `:427` `'404 (no 500) si el id no es numérico'` | sí (ver menor 1) |
| 8 | `PATCH` cambia `alt`/`orden`/`seccion`; 404; 422 sin campo editable | `:437` `'cambia alt, orden y seccion'` (además verifica que `mime_type`/`size_bytes` no cambian) · `:454` `'acepta un solo campo editable (no exige los tres)'` · `:465` `'404 si no existe'` · `:470` `'422 { error } si el body no trae ningún campo editable'` (manda `mime_type`/`size_bytes`/`filename` y exige 422) · `:480` `'422 si seccion no es válida'` | sí |
| 9 | `DELETE` → 204 sin body; 404 si no existe | `:494` `'204 sin body y la fila desaparece de la BD'` (comprueba `res.text` vacío, la fila en DB y que `/raw` pasa a 404) · `:507` `'404 si no existe'` | sí |
| 10 | Escritura: 401 sin cookie, 403 con `editor`; los dos GET públicos | `:528` `'401 sin cookie de sesión en POST, PATCH y DELETE'` · `:537` `'403 con rol editor en POST, PATCH y DELETE (solo admin escribe)'` · `:546` `'los dos GET siguen siendo públicos (sin cookie)'` — **las 3 escrituras × 2 estados = 6 aserciones reales**, no solo el camino feliz | sí |
| 11 | C7: router sin SQL, `images.js` sin express ni `req`/`res` | `:559` `'src/imagesRouter.js no escribe SQL'` · `:567` `'src/images.js no importa express ni toca req/res'` · `:573` `'src/images.js parametriza todo valor de usuario e interpola solo `schema` (C4)'` | sí |
| 12 | `tests/images.test.js` con ≥1 `it()` por criterio, patrón de `articles.test.js` | El archivo entero: 47 tests, schema efímero propio (`:17`), `DROP SCHEMA … CASCADE` en `afterAll` (`:88`), `createApp` con pool inyectado y `fakeMailer` (`:74`) — mismo patrón que `tests/articles.test.js` | sí |
| 13 | `docs/api-contract.md` con los 5 endpoints; env var por NOMBRE en `.env.example` | `:602` `'docs/api-contract.md documenta los 5 endpoints'` · `:610` `'.env.example documenta por nombre la variable del límite de tamaño'` | sí |
| 14 | `npm test` verde sin borrar ni skipear nada | Verificado por el reviewer (§1) | sí |

**Los 14 criterios tienen cobertura real.** No encontré ningún criterio sin
test que lo ejercite.

---

## 4. Contraste del informe contra el código (desconfianza aplicada)

Verifiqué las afirmaciones de `progress/current.md` que se podían falsear:

| Afirmación del informe | Verificación | Resultado |
|---|---|---|
| "47 tests" | recuento de `it()` | ✔ exacto |
| "11 archivos / 164 tests" | `npm test` corrido por mí | ✔ exacto |
| "`package.json`: una sola línea añadida (`multer`)" | `git diff package.json` línea a línea | ✔ el diff solo añade `multer: ^2.2.0` a `dependencies`; el `test:no-db` que también aparece es de la **feature 4** (script ya existente antes de la sesión, mtime coherente). `test` intacto, devDependencies intactas |
| "`render.yaml` y `.node-version` no se tocaron" | mtimes = 2026-06-04 | ✔ |
| "`package-lock.json` regenerado, 10 paquetes" | `git diff package-lock.json` | ✔ exactamente 10 entradas nuevas y **todas** son multer o sus transitivas (`append-field`, `buffer-from`, `busboy`, `concat-stream`, `multer`, `readable-stream`, `streamsearch`, `string_decoder`, `typedarray`, `util-deprecate`). Cero dependencias coladas |
| "no relajé el `requireRole('admin')` del DELETE de artículos (feature 8)" | `grep requireRole src/articlesRouter.js` + mtime | ✔ `:105` sigue `requireRole('admin')`; el archivo no se tocó en esta sesión |
| "`bytes` fuera de `META_COLS`" | lectura de las 6 queries | ✔ ver §6 |
| "`docs/context.md` §1 actualizado" | lectura de `docs/context.md:13-14` | ✔ "…y CRUD de las imágenes de las secciones de la landing (feature 7)" |
| "el motivo de excluir SVG está en `docs/architecture.md`, no solo en un comentario" | lectura de `docs/architecture.md:385-401` | ✔ ver §7 |
| "cero schemas `maia_test_*` huérfanos" | no reverificado por mí | no verificado (irrelevante para el veredicto) |
| "`MulterError` atrapado, nunca HTML ni 500" | ejercitado en vivo por mí | ✔ ver §8 |
| "id no numérico → 404, no llega a Postgres" | ejercitado en vivo | ✔ para no-numérico; **incompleto** para numérico fuera de rango → menor 1 |

**No detecté ninguna afirmación del informe que el código no respalde**, con la
única salvedad del matiz del hallazgo menor 1.

---

## 5. Bloqueantes

**Ninguno.**

---

## 6. Auditoría dedicada: `bytes` nunca en JSON (análogo de I3)

Recorridas **una por una** las 6 queries de `src/images.js`:

| Función | Línea | Columnas leídas | ¿`bytes`? |
|---|---|---|---|
| `createImage` | `:98-100` | `INSERT … RETURNING ${META_COLS}` | **no** |
| `getImageById` | `:117` | `SELECT ${META_COLS}` | **no** |
| `getImageWithBytes` | `:129` | `SELECT ${RAW_COLS}` | **sí — única, y solo la llama `/raw`** |
| `listImages` | `:147` | `SELECT ${META_COLS}` | **no** |
| `updateImage` | `:175-178` | `UPDATE … RETURNING ${META_COLS}` | **no** |
| `deleteImage` | `:186` | `DELETE` (sin `RETURNING`) | **no** |

- `META_COLS` (`src/images.js:36`) = `id, seccion, filename, mime_type,
  size_bytes, alt, orden, created_at, updated_at` → **sin `bytes`**.
- `RAW_COLS` (`:40`) = `id, filename, mime_type, bytes, size_bytes`.
- **Cero `SELECT *` en todo `src/`** (grep `SELECT \*` → sin resultados). Ni en
  `images.js` ni en ningún otro módulo.
- `getImageWithBytes` se referencia **exactamente una vez** en el router:
  `src/imagesRouter.js:161`, dentro de `GET /api/images/:id/raw`. No la usa
  ningún otro handler.
- Fuera de `images.js`, `bytes` solo aparece en `src/imagesRouter.js:162, 164,
  169` (las tres, dentro del handler de `/raw`: guard de existencia,
  `Content-Length` y `res.end`) y en `:216` (el buffer de entrada del `POST`).
  No hay ninguna vía por la que llegue a un `res.json`.

**Test explícito que lo afirma:** `tests/images.test.js:373`
`it('el campo bytes NUNCA sale en el JSON (análogo de la invariante I3)')`. No
se limita a mirar las claves: recorre todas las filas del listado, comprueba
`Object.keys(row)` y `row.bytes === undefined`, y además asserta sobre el **texto
crudo** de la respuesta (`expect(lista.text).not.toMatch(/"bytes"/)`), repitiendo
el chequeo en la respuesta del `POST` y del `PATCH`. La distinción
`size_bytes` (sí sale) vs `"bytes"` (no sale) está manejada correctamente.
Complementado por el test estructural `:394`, que parsea `META_COLS`/`RAW_COLS`
del propio fuente. Escrito como invariante en `docs/database.md:101-105` y
`docs/architecture.md:380-384`.

**Veredicto de este punto: correcto, sin reservas.**

---

## 7. Auditoría dedicada: validación de MIME y exclusión de SVG

**Nivel realmente implementado: tres capas, no solo el `mimetype` declarado.**
Verificado en el código, no en el informe:

| Capa | Qué comprueba | Dónde | Falla → |
|---|---|---|---|
| 1 | MIME declarado ∈ whitelist | `src/imagesRouter.js:94` (`isAllowedMime`, en el `fileFilter`) | 415 |
| 2 | Extensión del `filename` coherente con ese MIME | `src/imagesRouter.js:94` (`extensionMatchesMime`) | 415 |
| 3 | **Magic bytes del buffer real**, y que coincidan con el declarado | `src/imagesRouter.js:196-199` (`sniffMime`, antes de persistir) | 415 |

La capa 3 es la que hace la validación no falsificable: `sniffMime`
(`src/images.js:74-94`) lee a mano la firma PNG de 8 bytes, `FF D8 FF` de JPEG y
`RIFF….WEBP` de WebP, sin dependencias nuevas, y devuelve `null` ante cualquier
otra cosa. Además, **lo que se persiste en `mime_type` es el MIME detectado**
(`src/imagesRouter.js:215`: `mime_type: sniffed`), no el que declaró el cliente:
la BD no guarda la mentira. Ejercitado en vivo por mí: un HTML con
`filename=trampa.png` + `Content-Type: image/png` → **415**, no 201.

**El informe lo documenta honestamente.** `progress/current.md:118-143` describe
las tres capas y, sobre todo, **declara explícitamente el límite**: no decodifica
la imagen, así que un archivo con cabecera válida y cuerpo basura se aceptaría y
el navegador simplemente no lo renderizaría. Es una limitación real, declarada
sin adornos, con el razonamiento de riesgo residual correcto (con `nosniff` +
whitelist sin SVG, el peor caso es una imagen rota, no ejecución de código).

**SVG excluido:** `MIME_WHITELIST` (`src/images.js:25-29`) contiene exactamente
`image/png`, `image/jpeg`, `image/webp`. `image/svg+xml` no está, y además
`sniffMime` nunca devolvería `image/svg+xml`, así que ni renombrando la extensión
pasa (verificado en vivo: SVG con `filename=a.png` y `Content-Type: image/png` →
415).

**El motivo está en `docs/architecture.md`, no solo en un comentario del código:**
`docs/architecture.md:385-401`, sección propia **"§7.1 Validación de imágenes
subidas — y por qué SVG está excluido"**. Explica que un SVG es XML ejecutable
(`<script>`, `onload`/`onerror`, `<foreignObject>`, `xlink:href="javascript:"`),
que `/raw` lo serviría en crudo con su propio `Content-Type` desde el origen de
la API → **XSS almacenado** con acceso al contexto de la cookie de sesión del
panel, y cierra el debate ("no es una omisión que haya que arreglar"; si algún
día hace falta un vectorial, se decide entonces con su propio sanitizador).
Reforzado en `docs/architecture.md:666` (tabla de decisiones de seguridad) y en
`docs/api-contract.md:239-240`. Hay test que exige que el doc lo explique y
mencione XSS (`tests/images.test.js:274`).

**Veredicto de este punto: correcto y honestamente documentado.**

---

## 8. Auditoría dedicada: los errores de subida responden JSON

**Ejercitados en vivo por mí**, con una app construida aparte de la suite
(`maxFileSize: 64` inyectado por factory, admin real logueado):

```
sin archivo                 -> 422 application/json {"error":"Archivo requerido","field":"file"}
mime no permitido (.txt)    -> 415 application/json {"error":"Tipo de archivo no permitido…","field":"file"}
archivo sobre el límite     -> 413 application/json {"error":"El archivo excede el tamaño máximo permitido (64 bytes)","field":"file"}
svg declarado como svg      -> 415 application/json {"error":"Tipo de archivo no permitido…","field":"file"}
svg disfrazado de png       -> 415 application/json {"error":"Tipo de archivo no permitido…","field":"file"}
campo de archivo inesperado -> 422 application/json {"error":"Archivo inválido","field":"file"}
```

Los tres códigos exigidos (422/415/413) salen con `Content-Type:
application/json`, con `{ error, field }`, sin 500 y sin el HTML por defecto de
Express. `uploadSingleImage` (`src/imagesRouter.js:114-135`) atrapa el
`MulterError` explícitamente: `LIMIT_FILE_SIZE` → 413, el resto de
`MulterError` → 422 (probado con `LIMIT_UNEXPECTED_FILE`, que loggea
`[images] upload error LIMIT_UNEXPECTED_FILE` y responde 422 JSON), y cualquier
error no-Multer → `next(err)` como red de seguridad del `errorHandler`. **No hay
`MulterError` sin atrapar.** El middleware está montado **solo** en
`POST /api/admin/images` (`:178`) y **después** del `adminGuard`, así que un
anónimo o un `editor` recibe 401/403 sin que el binario se parsee.

**Veredicto de este punto: correcto, sin reservas.**

---

## 9. Menores (no bloquean)

1. **`src/imagesRouter.js:39-43` — `parseId` filtra lo no numérico pero no el
   desbordamiento de `bigint`.** Un id de solo dígitos pero fuera de rango llega
   a Postgres y provoca el error `22003`, que acaba en **500 en vez de 404**.
   Reproducido en vivo por mí en las tres rutas que toman `:id`:
   ```
   GET  /api/images/99999999999999999999999/raw       -> 500 {"error":"Error al cargar imagen"}
   PATCH /api/admin/images/99999999999999999999999    -> 500 {"error":"Error al actualizar imagen"}
   DELETE /api/admin/images/99999999999999999999999   -> 500 {"error":"Error al borrar imagen"}
   ```
   Por qué **no** es bloqueante: la respuesta sigue siendo JSON, C8 se respeta
   (el error real va al log con prefijo `[images]`, al cliente va un mensaje
   genérico sin stack ni SQL), y `src/articlesRouter.js` tiene la misma debilidad
   desde antes (pasa `req.params.id` directo a la capa de datos), así que no es
   una regresión sino el precedente del repo — de hecho `images` es **más**
   defensivo que el precedente. Lo que sí conviene corregir: `docs/api-contract.md:124`
   promete "`404` tanto si el id no existe como si no es numérico (**nunca un
   500**)" y `progress/current.md:106-107` (decisión 10) sugiere lo mismo; el
   arreglo son dos caracteres en la regex (`/^\d{1,19}$/`) o un guard de
   `Number.MAX_SAFE_INTEGER`. Anotarlo o arreglarlo, pero no dejar el doc
   prometiendo más de lo que hace el código.

2. **`progress/current.md:265-269` — sección `## Verificación` duplicada.** Hay
   dos encabezados `## Verificación`: el real (`:238-263`, con los 164 tests) y
   un segundo, resto de la plantilla, que dice `npm test → (pendiente)` y
   contradice al primero. Cosmético, pero es exactamente el tipo de residuo que
   confunde a quien lea el histórico en seis meses. Borrar el segundo bloque.

3. **`src/images.js:164-182` — `updateImage` hace read-then-write sin
   transacción.** `getImageById` y luego el `UPDATE` con las tres columnas fijas:
   dos `PATCH` concurrentes sobre la misma imagen pueden perder el campo del
   primero (el segundo lee el estado previo al commit del primero y lo reescribe).
   Riesgo real ~0 (solo admin, tráfico de un panel, tres imágenes), y la
   alternativa —`SET` dinámico— es justo lo que evita la interpolación de SQL, así
   que el trade-off elegido es el correcto. Solo queda anotado: si algún día el
   panel se usa a cuatro manos, esto pide un `UPDATE … SET alt = COALESCE($1, alt)`
   o una transacción.

4. **`src/imagesRouter.js:28-31` — tercera copia de `positiveNumberFromEnv`.**
   Idéntica a `src/app.js:29-32` y a `src/auth.js:20-23`. **No es un hallazgo
   contra el implementer**: extraerla a un módulo compartido habría sido un
   refactor oportunista y una violación de C12, y hizo bien en no tocarla. Queda
   como candidata para una feature de limpieza futura.

5. **`feature_list.json:33` — el criterio 10 dice "las *cuatro* rutas de
   escritura" pero el criterio 2 (`:25`) define solo tres** (`POST`, `PATCH`,
   `DELETE`). El implementer lo detectó y lo declaró en
   `progress/current.md:183-186` en vez de inventarse una cuarta ruta o callarlo:
   es el comportamiento correcto ante una consigna contradictoria. **Confirmo que
   no hay una cuarta ruta de escritura que se le haya escapado**: `grep` sobre
   `src/imagesRouter.js` da exactamente 5 rutas (2 GET + 3 escrituras) y el test
   `:139` lo verifica. Es un defecto de la **especificación**, no del código —
   corregir la redacción de `feature_list.json` al cerrar.

6. **Recuento de criterios.** La consigna de review hablaba de "13 criterios";
   el array `acceptance` de `feature_list.json:23-38` tiene **14** entradas. El
   mapeo de §3 cubre las 14. Sin impacto, se anota para que el conteo no arrastre
   confusión en el cierre.

---

## 10. Conclusión

Trabajo sólido y de alcance limpio. Los tres puntos que más podían salir mal
—`bytes` filtrándose en un `SELECT *`, un `MulterError` devolviendo el HTML de
Express, y una interpolación colada en el `SET` del `PATCH`— están los tres bien
resueltos, y los dos primeros los verifiqué ejercitando la app, no leyendo el
informe. La validación de MIME va más allá de lo mínimo (magic bytes, sin
dependencias nuevas) y su límite está declarado con honestidad en lugar de
maquillado. `docs/` está al día en los cinco archivos que tocaba. C1–C6 todos en
`[x]`, verificados por mí.

**APPROVED.** Los seis hallazgos menores no bloquean; el 1 y el 2 merecen
atenderse antes de cerrar la feature (uno es un doc que promete más que el
código, el otro un residuo de plantilla). El implementer puede marcar la feature
7 como `done` en `feature_list.json` — **el reviewer no la marca**.
