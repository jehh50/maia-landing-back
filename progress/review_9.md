# Review — feature 9: CRUD de precios (SOLO PLANES)

**Veredicto:** APPROVED
**Tests:** `npm test` → **13 archivos / 291 tests, verde** (ejecutado por el
reviewer, no reportado por el implementer). `pg_isready` →
`/var/run/postgresql:5432 - aceptando conexiones`. `npm run test:no-db` → 3/30.

> Además de correr la suite, ejercité la API **en vivo** con un script propio
> (schema efímero `rev9_*`, `createApp` con pool inyectado, borrado al final):
> aritmética, tipos del JSON real, caso Custom, `parseId`, viñetas, permisos,
> idempotencia del DDL e inyección SQL. Todas las evidencias marcadas
> "(en vivo)" salen de esa corrida, no de leer `tests/precios.test.js`.

---

## 1. Verificación de tests (C1)

```
Test Files  13 passed (13)
     Tests  291 passed (291)
  Duration  52.79s
```

Coincide con `progress/current.md` §Verificación y con la cifra del humano.
Delta contra el baseline de la feature 8 (12 archivos / 221 tests):

| archivo | `it()` | baseline f8 | delta |
|---|---|---|---|
| `app` | 7 | 7 | — |
| `articles` | 15 | 15 | — |
| `auth` | 17 | 17 | — |
| `contact` | 17 | 17 | — |
| `email` | 9 | 9 | — |
| `images` | 49 | 49 | — |
| `leads` | 14 | 14 | — |
| `phone` | 8 | 8 | — |
| `ratelimit` | 17 | 17 | — |
| `roles.schema` | 2 | 2 | — |
| `roles` | 13 | 13 | — |
| `users` | 53 | 53 | — |
| **`precios`** | **68 `it()` + 1 `it.each` de 3 casos = 70** | — | **nuevo** |
| | **291** | 221 | **+70** |

`221 + 70 = 291`. **Los 12 archivos del baseline conservan exactamente su
recuento**: ningún test borrado. `grep -rnE "\.(skip|todo|only)\b" tests/` →
sin resultados. El único cambio en un test existente es `tests/users.test.js:816`
(un `toEqual` ampliado con `'planes'`), confirmado en el `git diff`: 6 líneas,
mismo recuento de 53, con comentario explicativo. **Es legítimo** — ese test
inventaría el DDL de `src/db.js` y esta feature sí añade tabla; lo que protegía
de verdad (las 6 columnas de `users`, el único `ADD COLUMN`) sigue intacto
(`tests/users.test.js:806-812`). No es scope creep.

---

## 2. Checkpoints

| # | Checkpoint | | Evidencia |
|---|---|---|---|
| C1 | Tests verdes | `[x]` | 13/13 archivos, 291/291 tests, corridos por mí. Cero skip, cero borrados (§1). La cifra literal de `CHECKPOINT.md` ("7 suites / 86 tests") está obsoleta desde la feature 4; el baseline vigente es `docs/verification.md` §3. |
| C2 | Cobertura del acceptance | `[x]` | Los 15 criterios mapeados a `it()` con línea en §3, abiertos y leídos uno a uno. |
| C3 | Factories con DI | `[x]` | `createPreciosRouter({ pool, schema = 'public', requireAuth })` (`src/preciosRouter.js:157`), valida `pool` y `requireAuth` al construir (`:158-159`). `grep process.env src/precios.js src/preciosRouter.js` → **sin resultados**. Cero singletons, cero estado de módulo. Montado igual que el resto: `src/app.js:139`. |
| C4 | SQL seguro | `[x]` | Auditadas las 6 queries de `src/precios.js` (`:139`, `:165`, `:175`, `:191`, `:214`, `:245`): todo valor va en `$n`; lo único interpolado es `"${schema}"` entre comillas dobles y `${COLS}`, constante del propio módulo (`:12-25`). **El `UPDATE` del PATCH mirado con lupa** (`:214-240`): `SET` con lista de columnas **fija**, 10 placeholders, cero `SET` dinámico. El JSONB entra como `JSON.stringify(...)` en `$4::jsonb`/`$5::jsonb` — nunca concatenado. En vivo: `POST` con `nombre: "'); DROP TABLE planes; --"` → 201, el valor se guarda literal y la tabla sigue viva; `PATCH` con `"a'||(SELECT password_hash FROM users)||'"` → 200 con el string sin evaluar. |
| C5 | Contrato de API | `[x]` | `docs/api-contract.md:129-186` (GET público, tabla de tipos, los 4 avisos: derivados, "no es el total del año", números-no-strings y caso Custom) y `:424-491` (las 4 rutas admin, códigos, campos editables, `404` por id desbordado). Contrastado contra la respuesta HTTP real: la forma documentada **es** la que devuelve la API (incluido `id` como string). |
| C6 | Sin secretos | `[x]` | `grep -niE "postgres://|sk_|re_…|password\s*[:=]|AUTH_SECRET|SMTP_PASS"` sobre `src/precios.js`, `src/preciosRouter.js`, `tests/precios.test.js` y `progress/current.md` → solo el fallback de socket local `postgres:///maia-landing?host=/var/run/postgresql` (`tests/precios.test.js:24`, idéntico a `images`/`users`), la contraseña de fixture `'pass-1'` (`:97-98`) y el **nombre** `SMTP_PASS` en la sección de deuda de `current.md:214`. Cero valores reales. Cero variables de entorno nuevas. |
| C7 | Separación de capas | `[x]` | `src/preciosRouter.js` no tiene `pool.query` ni SQL (verificado con grep); `src/precios.js` solo importa… nada (`:1`, cero imports), no menciona `req`/`res`. Tests estructurales en `tests/precios.test.js:797` y `:804`. |
| C8 | Errores manejados | `[x]` | Los 5 handlers van con `asyncHandler` **y** `try/catch` propio (`src/preciosRouter.js:166-174, 178-189, 191-202, 204-227, 229-240`). Se loguea el error real con prefijo `[precios]` y se responde un mensaje genérico; ni stack ni SQL salen al cliente. |
| C9 | DDL idempotente | `[x]` | `src/db.js:143` `CREATE TABLE IF NOT EXISTS` + `:158` `CREATE INDEX IF NOT EXISTS`. Cero `DROP`, cero `ALTER`, todas las columnas con `DEFAULT` o nullable. **En vivo**: `ensureSchema` corrido **3 veces seguidas con 4 filas dentro** → sin error y 4 filas después. `docs/database.md:76` y `:144-188` actualizados. |
| C10 | Escape de HTML en correo | `[x]` | N/A: la feature no toca plantillas ni mailer (`grep mailer src/precios*.js` sin resultados). |
| C11 | Limpieza | `[x]` | Cero `console.log`, `TODO`, `FIXME` o `SELECT *` en los tres archivos nuevos (las dos coincidencias de "SELECT \*" son comentarios que documentan la invariante). `git status --short` sin temporales; mis dos scripts de verificación se ejecutaron y borraron. |
| C12 | Alcance | `[x]` | El diff toca **solo** la feature 9: `src/db.js` (bloque nuevo al final de `ensureSchema`, cero líneas de otras tablas modificadas), `src/app.js` (+6: un import y un `app.use`), 3 archivos nuevos, 6 docs y `tests/users.test.js` (1 aserción, §1). **Sin desbordes al alcance de la feature 10**: en vivo, `information_schema.tables` del schema efímero devuelve exactamente `articles, images, leads, planes, users` — ni `complementos` ni `paquetes`; tampoco existen `src/complementos.js` / `src/paquetes.js`. Cero refactors oportunistas. |
| C13 | Trazabilidad | `[x]` | La tabla "Archivos tocados" de `current.md:29-43` coincide **exactamente** con `git status --short`. Contrasté las afirmaciones falseables contra el código y ninguna resultó falsa (§6). Una imprecisión menor sobre `feature_list.json` en Menores 4. |
| C14 | Estado coherente | `[x]` | `feature_list.json` → feature 9 en `in_progress`. No está `done`. El reviewer tampoco la marca. |
| C15 | Git | `[ ]` | Seguimos en `main`, sin commits: el trabajo queda en el árbol local. Misma excepción explícita del humano aceptada al cerrar las features 1, 3, 4, 5, 7 y 8. **No es bloqueante** (C15 no está en C1–C6), pero queda marcado como incumplido para no normalizarlo. Nota: a diferencia de la feature 8, `current.md` esta vez **no** deja escritos el nombre de rama ni el mensaje de commit convencional sugeridos (Menores 5). |
| I1 | `POST /api/contact` 201 aunque falle el correo | `[x]` | `tests/contact.test.js` (17) y `tests/email.test.js` (9) verdes, sin tocar. |
| I2 | Draft → 404 en la ruta pública | `[x]` | `tests/articles.test.js` (15) verde, sin tocar. |
| I3 | `password_hash` nunca sale por la API | `[x]` | La feature no toca `users`; `tests/users.test.js` (53) verde. `COLS` de `precios.js:12-25` no incluye nada de usuarios. |
| I4 | Mismo 401 para usuario y password | `[x]` | `tests/auth.test.js` (17) verde, sin tocar. |
| I5 | Rol recargado desde la DB en cada request | `[x]` | El router usa `requireRole('admin')` del módulo compartido (`src/preciosRouter.js:162`), no lee el rol del token. `tests/roles.test.js` (13) verde. En vivo, el editor recibe 403 en las 4 rutas admin. |
| I6 | Cookie `SameSite=None; Secure` en producción | `[x]` | No se tocó `src/auth.js`; `tests/auth.test.js` verde. |

**Cero `[ ]` en C1–C6.**

---

## 3. Cobertura del acceptance (C2) — criterio → test

Todos en `tests/precios.test.js` salvo donde se indique. Verificados abriendo el
archivo, no copiados del informe.

| # | Criterio | `it()` (línea) |
|---|---|---|
| 1 | Tabla en `ensureSchema`, idempotente, `database.md` | "la tabla planes existe en el schema efímero tras ensureSchema()" (`:118`), "el DDL de src/db.js usa CREATE TABLE IF NOT EXISTS y no tiene ningún DROP" (`:127`), "es idempotente: correr ensureSchema de nuevo no falla ni borra datos existentes" (`:138`), "docs/database.md documenta la tabla planes" (`:152`) |
| 2 | Columnas y tipos, dinero en `NUMERIC` | "tiene exactamente las columnas esperadas" (`:163`), "precio_mensual y descuento_pct son NUMERIC con la precisión pedida, nunca float/double" (`:176`), "los tipos y NOT NULL/DEFAULT del resto de columnas son los pedidos" (`:199`), "los defaults funcionan…" (`:235`) |
| 3 | Trampa del `NUMERIC` como string | "el driver `pg` SÍ devuelve NUMERIC como string: la trampa existe de verdad" (`:256`), "typeof precio_mensual === \"number\" en las respuestas del POST, del GET público, del detalle y del PATCH" (`:269`), "el JSON crudo no lleva los precios entre comillas" (`:295`), "toNumber convierte el string del driver y nunca devuelve NaN" (`:304`) |
| 4 | Derivados, no almacenados | "no existen como columnas en la tabla" (`:318`), "vienen en las respuestas de la API…" (`:328`), "se recalculan al cambiar el precio o el descuento…" (`:348`), "no se pueden enviar: un PATCH que solo trae precio_anual/ahorro_anual responde 422 y no cambia nada" (`:367`), "un POST con precio_anual en el body lo ignora…" (`:383`) |
| 5 | 19/10→17,24 · 199/10→179,240 · 599/9.85→540,708 | `it.each` de los tres casos sobre los helpers puros (`:397`), "los tres casos, extremo a extremo por HTTP, reproducen la web exactamente" (`:408`), "el ahorro es la diferencia MENSUAL por 12… (defensa del factor 12)" (`:419`), "un 10% plano NO reproduce Growth…" (`:428`) |
| 6 | Caso Custom | "devuelve precio_anual y ahorro_anual en null, nunca \"ahorras $0/año\"" (`:441`), "un plan Custom con precio_mensual > 0 tampoco publica derivados" (`:460`), "quitar es_custom por PATCH devuelve los derivados y ponerlo los vuelve a anular" (`:468`), "toPlan aplica la regla también fuera de HTTP" (`:482`), "la decisión del caso Custom está documentada en progress/current.md" (`:490`) |
| 7 | Prefijo de rutas y orden `orden ASC` | "las cinco rutas están montadas y responden como admin" (`:501`), "GET /api/precios devuelve { rows } ordenado por `orden` ascendente" (`:512`), "no existe una ruta pública de escritura: POST /api/precios responde 404" (`:529`), "los 4 planes reales de la web se pueden dar de alta y salen en orden…" (`:534`) |
| 8 | Validación 422 `{ error, field }` y 404 | 13 `it()` (`:561`, `:570`, `:576`, `:584`, `:590`, `:598`, `:608`, `:619`, `:636`, `:645`, `:658`, `:668`, `:682`) + "un precio que desbordaría NUMERIC(10,2) responde 422, nunca 500" (`:695`) |
| 9 | `parseId` con guard de `bigint` | "GET /api/admin/precios/:id responde 404 para cualquier id inválido" (`:717`), "PATCH y DELETE responden 404 para cualquier id inválido" (`:725`), "el límite exacto de bigint (9223372036854775807) sí llega a la BD y responde 404 de \"no existe\"" (`:735`), "el guard de rango está en el código, con el mismo PG_BIGINT_MAX de las features 7 y 8" (`:741`) |
| 10 | 401/403 en escritura, GET público | "401 sin cookie en las tres rutas de escritura" (`:762`), "403 con cookie de rol editor…" (`:768`), "el GET de detalle del panel también es solo admin (401 / 403)" (`:774`), "ni el anónimo ni el editor modifican nada…" (`:779`), "GET /api/precios sigue siendo público: 200 sin cookie" (`:784`) |
| 11 | C7 + C4 | "src/preciosRouter.js no escribe SQL" (`:797`), "src/precios.js no importa express ni toca req/res" (`:804`), "todo valor de usuario va parametrizado: el único interpolado es `schema` entre comillas dobles" (`:811`), "la capa de datos usa una lista de columnas fija y el UPDATE no construye un SET dinámico" (`:824`) |
| 12 | Cero dependencias nuevas | "package.json conserva exactamente las mismas dependencias" (`:837`), "los dos módulos nuevos solo importan lo que ya existía en el repo" (`:847`), "el alcance es SOLO PLANES: no hay tabla ni router de complementos/paquetes" (`:853`) |
| 13 | Patrón de la suite | "usa un schema efímero propio y lo limpia (no toca `public`)" (`:868`), "hay un describe por cada uno de los 15 criterios del acceptance" (`:875`) |
| 14 | Documentación | "docs/api-contract.md documenta los endpoints y que los derivados no son editables" (`:887`), "docs/architecture.md documenta la tabla `planes` y el cálculo derivado" (`:899`), "docs/database.md explica la trampa del NUMERIC como string y el invariante de los derivados" (`:907`) |
| 15 | Suite completa, sin borrar tests | "los 12 archivos de test del baseline siguen existiendo, más este" (`:919`), "ningún test del repo está marcado skip/todo/only" (`:932`), "CAMPOS_EDITABLES no incluye ningún campo derivado ni de auditoría" (`:941`) + la corrida completa (§1) |

Ningún criterio se queda sin `it()`.

---

## 4. Las tres trampas de esta feature — verificadas en vivo

### 4.1 Aritmética de precios (criterios 4 y 5) — CORRECTA

Ejercitada por HTTP sobre la API real, no leyendo los tests:

```
POST 19  / 10    → precio_anual 17   ahorro_anual 24    (esperado 17 / 24)   OK
POST 199 / 10    → precio_anual 179  ahorro_anual 240   (esperado 179 / 240) OK
POST 599 / 9.85  → precio_anual 540  ahorro_anual 708   (esperado 540 / 708) OK
```

Reproduce **exactamente** los tres casos hardcodeados en la web. El error del
**factor 12 no está presente**: `precio_anual` es el precio *mensual*
facturando anualmente (17 < 19), y el ahorro es la diferencia mensual × 12
(`(19−17)×12 = 24`), no `19×12 − 17 = 211`. Fórmula implementada en
`src/precios.js:64-71`, literalmente la del criterio 4.

Redondeo con decimales, también en vivo: `precio_mensual = 19.99`,
`descuento_pct = 12.5` → exacto `17.49125` → `Math.round` → **17**, y
`ahorro = Math.round(2.99 × 12) = 36`. Correcto. El `%` es **por plan**: con un
10 % plano Growth daría 539/720 (test `:428`), por eso 9.85 % es la fuente de
verdad y el DDL guarda el `%`, no el precio derivado.

### 4.2 `NUMERIC` devuelto como string (criterio 3) — RESUELTO

Sobre la respuesta HTTP real (`GET /api/precios`, sin cookie):

```
typeof precio_mensual = "number"   typeof descuento_pct = "number"
typeof precio_anual   = "number"   typeof ahorro_anual  = "number"
texto crudo: {"rows":[{"id":"1","nombre":"X19","precio_mensual":19,"descuento_pct":10,
              "precio_anual":17,"ahorro_anual":24, …
```

El texto crudo **no** trae `"19.00"` entrecomillado (`/"precio_mensual":"/` no
casa). Y la trampa existe de verdad: leyendo la misma fila con `pool.query`
directo, el driver devuelve `typeof precio_mensual === 'string'` con valor
`"19.00"`. La conversión vive en `toNumber()`/`toPlan()` (`src/precios.js:48`,
`:91`), único punto de salida de las filas — sin parser global de `pg`, que
habría sido un efecto global contrario a C3.

Tipos en la BD, leídos de `information_schema.columns` del schema efímero:

```
precio_mensual  numeric  precision 10  scale 2  NOT NULL  default 0
descuento_pct   numeric  precision  5  scale 2  NOT NULL  default 0
```

**`NUMERIC(10,2)` y `NUMERIC(5,2)`, cero `float`/`double`/`real`** en toda la
tabla. El resto de columnas también coincide con el criterio 2 (`vinetas` y
`vinetas_tachadas` JSONB NOT NULL DEFAULT `'[]'::jsonb`, `destacado`/`es_custom`
BOOLEAN NOT NULL DEFAULT false, `trial_texto` TEXT nullable, `orden` INTEGER NOT
NULL DEFAULT 0, timestamps TIMESTAMPTZ NOT NULL DEFAULT now()).

### 4.3 Caso Custom (criterio 6) — CORRECTO Y COHERENTE CON EL INFORME

```
es_custom:true, precio 0   → precio_anual null, ahorro_anual null, precio_mensual 0
es_custom:true, precio 900 → precio_anual null, ahorro_anual null
PATCH es_custom:false      → precio_anual 720,  ahorro_anual 2160   (vuelven)
es_custom:false, pct 0     → precio_anual 50,   ahorro_anual 0      (0, no null)
```

Es **exactamente** lo que `progress/current.md:74-85` dice haber decidido: `null`
y nunca `0`, `precio_mensual`/`descuento_pct` conservados para el panel, y un
ahorro real de `0` sigue siendo distinguible de "no aplica". Un plan Custom no
puede acabar mostrando "ahorras $0/año". Implementación en `src/precios.js:97-98`,
documentado en `docs/api-contract.md:181-185` y `docs/database.md:185-188`.

---

## 5. Resto de auditorías pedidas

- **`parseId` con guard de `bigint`** (`src/preciosRouter.js:12`, `:34-39`). En
  vivo con `99999999999999999999999`: `GET` → 404, `PATCH` → 404, `DELETE` → 404.
  **Ningún 500.** También 404 para `abc`, `1e3`, `-1`, `1.5`, `%20`, `0` y
  `9223372036854775808` (max+1). Mismo `PG_BIGINT_MAX` que las features 7 y 8.
- **Validación de `vinetas` / `vinetas_tachadas`** (`:110-116` sobre
  `isStringArray`, `src/precios.js:74`). En vivo: `{a:1}` → 422, `42` → 422,
  `"txt"` → 422, `[1,2]` → 422, `[{}]` → 422, `[null]` → 422, `null` → 422; y
  `["ok"]` → 201. Todos con `{ error, field: "vinetas" }` / `"vinetas_tachadas"`.
- **Resto de validaciones**, en vivo: sin nombre → 422 `field:"nombre"`; nombre
  `""` → 422; `precio_mensual` `-1` → 422, `"abc"` → 422, `null`/`true`/`[]`/`""`/`" "`/`{}` → 422,
  `1e9` (desborda `NUMERIC(10,2)`) → **422, no 500**; `descuento_pct` `101` y
  `-0.1` → 422, extremos `0` y `100` → 201; `destacado:"si"` → 422;
  `orden:-1` → 422; `PATCH {}` → 422; `PATCH` con solo `precio_anual`/
  `ahorro_anual`/`id`/`created_at` → 422 **y la fila no cambia**; `POST` con
  `precio_anual:999` en el body → el derivado manda (90). `404` en `GET`
  detalle/`PATCH`/`DELETE` de un id inexistente; `DELETE` repetido → 404.
- **Autorización**, en vivo sobre las 4 rutas admin: sin cookie → **401** (POST,
  PATCH, DELETE y GET detalle); con cookie de rol `editor` → **403** en las
  cuatro. `GET /api/precios` → 200 sin cookie y también con cookie de editor.
- **Orden del listado público**: con `orden` 3/1/2/1 devuelve `a(1), d(1), b(2),
  c(3)` — `orden ASC, id ASC` (`src/precios.js:168`).
- **Cero dependencias nuevas**: `git diff --stat package.json package-lock.json
  render.yaml .node-version` → **vacío**. Las 11 dependencias y las 2
  devDependencies son las mismas.
- **`DELETE`** responde `204` sin body (`{}`), como el contrato.
- **`PATCH` parcial** conserva el resto de campos y actualiza `updated_at`;
  `trial_texto: null` sí lo borra y `vinetas: []` sí lo vacía (el merge distingue
  `undefined` de `null`, `src/precios.js:198-211`).

---

## 6. Contraste informe ↔ código (C13)

| Afirmación de `current.md` | Verificado con | Resultado |
|---|---|---|
| "13 / 291, +70 del archivo nuevo, ningún test borrado" | `npm test` propio + recuento por archivo | ✔ |
| "`npm run test:no-db` sigue en 3 archivos / 30 tests" | corrida propia | ✔ |
| "no se creó ninguna tabla `complementos` ni `paquetes`" | `information_schema.tables` en vivo | ✔ (`articles, images, leads, planes, users`) |
| "el `%` es la fuente de verdad; los derivados no se persisten" | `information_schema.columns` | ✔ (no existen como columnas) |
| "`toPlan()` es el único punto por el que salen las filas" | `src/precios.js:157, 170, 179, 241` | ✔ (las 4 lecturas/escrituras pasan por él) |
| "Custom devuelve `null`, nunca `0`" | API en vivo | ✔ |
| "cero dependencias nuevas; `package.json` sin tocar" | `git diff --stat` | ✔ |
| "hay un test que recorre los 13 archivos de `tests/` buscando skip/only" | `tests/precios.test.js:932-939` | ✔ |
| "5 tests para el caso Custom" | `:441, :460, :468, :482, :490` | ✔ |
| "`updatePlan` es read-then-merge con lista de columnas fija" | `src/precios.js:190-241` | ✔ |
| "en `feature_list.json` solo se cambió la feature 9 a `in_progress`" | `git diff feature_list.json` | ⚠ parcial (Menores 4) |

Ninguna afirmación falsable resultó falsa.

---

## Bloqueantes

Ninguno.

---

## Menores (no bloquean)

1. **`src/preciosRouter.js:57-61` — `orden` sin techo: un entero grande acaba en
   500.** `parseOrden` acepta cualquier entero ≥ 0, pero la columna es `INTEGER`.
   En vivo, `POST /api/admin/precios { nombre:'ov', orden: 3000000000 }` → **500**
   (Postgres `22003`, `pg_strtoint32_safe`), igual con `1e15`. Es un 500 causado
   por entrada del usuario, la misma clase de bug que cerró la feature 7 y que el
   propio implementer dice haber querido evitar (`current.md:91-95`, donde sí
   puso `PRECIO_MAX` para `precio_mensual`). **No bloquea**: el `acceptance` no lo
   pide y `src/imagesRouter.js:209-214` tiene exactamente el mismo hueco desde la
   feature 7, así que es deuda del repo, no una regresión. Sugerencia para la
   feature 10 o una de higiene: `orden > 2147483647 → 422`.
2. **`src/precios.js:64-71` — el ahorro puede salir negativo por el redondeo.**
   En vivo, `precio_mensual = 10.50` con `descuento_pct = 0` → `precio_anual =
   Math.round(10.5) = 11` y `ahorro_anual = Math.round((10.5 − 11) × 12) = −6`;
   el front renderizaría "Ahorras $-6/año". **No es una desviación**: la fórmula
   es literalmente la que exige el criterio 4 y ningún dato real de la web cae en
   ese caso (los 4 planes tienen precios enteros). Merece una nota en
   `docs/database.md` o un clamp a `≥ 0` en una feature futura, decisión del
   humano.
3. **`src/preciosRouter.js:82-86` y `:126-130` — `nombre` y `trial_texto`
   coercionan en vez de validar el tipo.** En vivo, `nombre: {a:1}` → 201 con
   `nombre: "[object Object]"`, y `trial_texto: 99` → `"99"`. Paridad exacta con
   el `alt` de `src/imagesRouter.js:217`, así que es la convención vigente del
   repo; lo señalo solo porque los booleanos y las viñetas **sí** validan tipo en
   este mismo router y el criterio queda desparejo.
4. **`progress/current.md:43` es incompleto sobre `feature_list.json`.** Dice
   "Feature 9 a `in_progress` (no a `done`)", pero el `git diff` del archivo son
   46 líneas: además del `status` aparecen las **features 10 y 11 nuevas**. Es
   trabajo del `leader` (CLAUDE.md le permite editar `feature_list.json` salvo
   marcar `done`) y el implementer no marcó nada `done` —C14 intacto—, pero la
   fila de la tabla de archivos tocados atribuye al implementer un diff que no es
   suyo entero.
5. **C15: sin rama ni commits**, y esta vez `current.md` tampoco deja escritos el
   nombre de rama (`feat/9-crud-precios`) ni el mensaje convencional sugeridos,
   como sí hizo la feature 8. Excepción del humano ya aceptada en 6 features; se
   deja anotado para no normalizarlo.
6. **`docs/verification.md` §3 quedó con un párrafo partido**: el texto nuevo se
   insertó en mitad de la frase del baseline anterior y se lee
   "…El baseline anterior era 12 archivos / 221 tests. `users.test.js` (53 /
   tests) entró con la feature 8…". Cosmético, no cambia la información.
7. **Fuera de esta feature, observado de paso**: un body JSON malformado
   (`"hola"`) responde **500** en vez de 400 porque `errorHandler`
   (`src/app.js:71-75`) aplasta el `statusCode: 400` de `body-parser`. Afecta a
   **toda** la API desde antes de esta feature, no lo introduce el implementer.
   Candidato a feature de higiene propia.

---

## Veredicto

**APPROVED.** Las tres trampas de la feature están resueltas y verificadas en
vivo, no solo por los tests del implementer: la aritmética reproduce los tres
casos reales de la web sin el error del factor 12, los `NUMERIC` salen como
números en el JSON crudo con las columnas en `NUMERIC(10,2)`/`(5,2)`, y el plan
Custom devuelve `null` en los dos derivados. El alcance es estrictamente "solo
planes", `parseId` no reintroduce el bug de la feature 7, las viñetas rechazan
todo lo que no sea un array de strings, el SQL está íntegramente parametrizado,
el DDL sobrevive a tres pasadas de `ensureSchema` con datos dentro, no hay
dependencias nuevas y la suite pasa de 221 a 291 tests sin perder ninguno.
Cero `[ ]` en C1–C6.

El implementer puede marcar la feature 9 como `done` en `feature_list.json`.
