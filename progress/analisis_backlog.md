# Análisis del backlog — maia-landing-back (2026-07-28)

> Análisis puro, sin implementación. Backlog de `feature_list.json` cerrado con
> 0 `pending` tras cerrar las features 0-5 (0-5 `done`, 6 `descartada`).
> Verificación de entorno: `pg_isready` → aceptando conexiones; `npm test` →
> 10 archivos / 117 tests, verde (coincide con el baseline de
> `docs/verification.md` §3).

---

## 1. Estado real del backlog

En general, lo cerrado está bien cerrado: crucé cada nota de `feature_list.json`
contra su `progress/review_N.md` y contra el código (`src/app.js`, `src/auth.js`,
`src/rateLimit.js`, `src/server.js`, `package.json`) y no encontré ninguna
feature que prometa en la nota algo que el código no tenga. Los cinco reviews
son inusualmente rigurosos (recuentos línea por línea, controles negativos con
`TEST_DATABASE_URL` roto, greps propios en vez de fiarse del reporte del
implementer), y mi propia verificación puntual coincide:

- `package.json` tiene `"test:no-db": "vitest run tests/phone.test.js
  tests/email.test.js tests/roles.test.js"` (línea 11), exactamente como dice
  la nota de la feature 4.
- `src/app.js:68-72` (`errorHandler`) responde siempre `500` — confirmado
  también en vivo (`npm test`, suite `app.test.js`, el test de JSON malformado
  espera y obtiene `500`). Coincide con lo documentado.
- `src/app.js:104-107` (`cors({ origin: corsOrigin === '*' ? true : ... ,
  credentials: true })`) coincide con lo que describe `docs/architecture.md`
  §4 sobre CORS.
- El rate limiting (`src/rateLimit.js`, 99 líneas) y la renovación de sesión
  (`src/auth.js`) existen tal cual se describen.

**Hay una salvedad grande que ninguna nota de cierre subraya con la fuerza que
merece: nada de esto ha salido de este entorno de trabajo.**

```
git status --short --branch → ## main...origin/main   (sin ahead/behind)
git log origin/main -1        → 13f5ab5 "update" (2026-07-27, antes de toda la sesión de agentes)
```

`main` y `origin/main` están exactamente igualados: **cero commits locales**
desde que arrancó el arnés de agentes. Las seis sesiones (features 0 a 6)
existen únicamente como cambios sin commitear en el árbol de trabajo de esta
máquina — `git status --short` mezcla en un solo estado sucio los diffs de
`src/app.js`, `src/auth.js`, `src/articlesRouter.js`, `src/leadsRouter.js`,
`.env` (borrado del índice), `.env.example`, `.gitignore`, `README.md` y
`package.json` de al menos cuatro features distintas, sin forma de aislarlas
por separado ya que nunca se separaron en commits/ramas.

Consecuencia concreta para la feature 1 ("Sacar `.env` del control de
versiones", `done`): el `git rm --cached .env` solo existe en el índice local.
El repo público en GitHub (`github.com/jehh50/maia-landing-back`, confirmado
por `git remote -v`) **sigue teniendo `.env` trackeado en `origin/main` ahora
mismo**, con el mismo historial expuesto que describía la propia nota de
cierre. La feature no está "hecha y pendiente de rotación humana" únicamente
— está **sin publicar**, punto que ninguna nota menciona (todas dicen "no se
commiteó ni se pusheó nada, decisión explícita del humano", pero no advierten
que eso significa que el problema que la feature dice resolver sigue
100% presente en el repo real). Lo trato como riesgo abierto en el punto 4,
no como algo que invalide el `done` (la nota es honesta sobre el alcance:
"saneo local"), pero si el objetivo real era dejar de exponer `.env`, ese
objetivo no se ha cumplido todavía en ningún sitio que no sea este disco.

Fuera de eso, no encontré ninguna feature "a medias". Los dos hallazgos
menores de la feature 3 (poda del `Map` sin test, ver `progress/review_3.md`
línea 56-59) se atendieron explícitamente antes de cerrar, según la propia
nota de `feature_list.json` id 3 y confirmado por `grep -n "__internals"
src/rateLimit.js` (existe). Los de la feature 5 (tabla de archivos tocados
incompleta, guard defensivo sin test directo) también se resolvieron o se
aceptaron conscientemente como no bloqueantes, correctamente.

---

## 2. Inventario de deuda no capturada

Deuda real, documentada en alguna fuente, que **no** tiene una entrada en
`feature_list.json` (ni `pending`, ni `done`, ni `descartada`):

1. **`POST /api/contact` con JSON malformado responde `500` genérico en vez
   de `400`.** `body-parser` marca el `SyntaxError` con `status: 400` /
   `expose: true`, pero `errorHandler` (`src/app.js:68-71`) ignora eso y
   siempre hace `res.status(500)`. Confirmado en vivo: el test
   `tests/app.test.js:120-129` espera y obtiene `500`. Documentado dos veces
   como deuda menor, nunca convertido en feature:
   `progress/review_2.md` líneas 216-220 ("Menores", punto 2) y
   `progress/history.md` líneas 77-82 (nota de cierre de la feature 2: "es
   candidata a feature nueva del backlog").
2. **El supuesto de que Render añade su propio hop a `X-Forwarded-For`
   nunca se ha verificado contra el servicio desplegado.** Toda la defensa de
   `trust proxy: 1` contra IP-spoofing depende de ello. Documentado como
   deuda en `progress/review_3.md` líneas 204-208 y repetido en
   `progress/history.md` líneas 145-156 y en `docs/architecture.md` (implícito
   en §4, sin una entrada explícita en §14). No es una feature de código —
   requiere un request real contra el servicio en producción — lo trato como
   riesgo en el punto 4, no como candidata.
3. **Rotación de credenciales pendiente** (`DATABASE_URL`, `SMTP_PASS`,
   `SMTP_USER`, `AUTH_SECRET`, `MAIA_ADMIN_PASSWORD`). Documentado de forma
   extremadamente visible: `progress/current.md` líneas 43-71 (sección
   persistente que "no se borra al vaciar la plantilla"), `docs/architecture.md`
   §14 punto 1 (líneas 582-594), `progress/history.md` líneas 255-281. Acción
   puramente humana, no una feature — punto 4.
4. **`feature_list.json` nunca ha tenido un campo `acceptance`/`scope`
   persistente en sus entradas `done`.** Las notas de cierre citan criterios
   de `acceptance` que existían mientras la feature estaba `pending`/
   `in_progress` (confirmado indirectamente: los cinco reviews citan listas de
   "acceptance" concretas, p. ej. `progress/review_5.md` líneas 25-47), pero
   esa estructura desaparece al archivar en `done` — solo queda `note` en
   prosa. No es deuda de producto, es deuda del propio arnés; la trato en el
   punto 5.
5. **`remainingMs <= 0` en `renewCookieIfNeeded`** (`src/auth.js`) es un guard
   defensivo hoy inalcanzable, sin test directo. Documentado en
   `progress/review_5.md` líneas 155-160 y en la nota de cierre de la feature
   5. Deliberadamente no lo elevo a candidata (ver punto 3, "descartadas").

No encontré deuda adicional relevante rastreando `docs/database.md` (línea
86-90, el `try/catch` del `42P01` en la migración de `role`) ni
`docs/email.js`/`docs/architecture.md` §9 — esas están correctamente descritas
como comportamiento aceptado, no como pendientes.

---

## 3. Candidatas a feature nueva

Evalué el tamaño del proyecto antes de proponer nada: landing con un
formulario de captación y un panel admin pequeño, un solo servicio Node en el
plan free de Render. Con eso como filtro, propongo **dos** candidatas — ambas
de esfuerzo bajo y acotado a un archivo o dos — y descarto explícitamente
varias ideas "que suenan bien" pero no compensan a este tamaño.

### Candidata A (prioridad ALTA) — Fallar rápido si `CORS_ORIGIN` queda en `*` en producción

**Por qué esta es la única que considero urgente:** `src/app.js:75,104-107`
hace `corsOrigin === '*' ? true : ...` y monta `cors({ origin: true,
credentials: true })`. `origin: true` con `cors` **refleja dinámicamente**
cualquier `Origin` que llegue en la request — es el patrón exacto que OWASP
señala como mala configuración de CORS cuando se combina con
`credentials: true`. `render.yaml` marca `CORS_ORIGIN` como `sync: false`
(línea 21-22: se configura a mano en el dashboard de Render, nunca por
blueprint) y `src/server.js` **no la valida al arrancar** — solo aborta si
faltan `DATABASE_URL` o `AUTH_SECRET` (`src/server.js:6`). Si alguien
despliega el servicio y olvida configurar `CORS_ORIGIN` en el dashboard (fácil
de olvidar: no rompe el arranque, no aparece en ningún log), el valor por
defecto (`'*'` → `origin: true`) queda activo en producción con
`SameSite=None; Secure` en la cookie de sesión (`docs/architecture.md` §8):
**cualquier sitio web puede hacer una request autenticada cross-origin usando
la cookie de un admin ya logueado** contra `/api/admin/*` (leer leads, crear/
editar/borrar artículos), porque el navegador ve un CORS válido para
cualquier origen.

Esto encaja exactamente con el patrón ya existente (`server.js` ya aborta el
arranque por variables críticas mal configuradas) y es un cambio de un
archivo. No es una propuesta desproporcionada: no introduce tokens CSRF ni
ninguna dependencia nueva, solo extiende la validación de arranque que ya
existe.

**Criterios de aceptación (estilo `feature_list.json`):**
1. Si `process.env.NODE_ENV === 'production'` y `CORS_ORIGIN` no está seteada,
   está vacía, o es exactamente `'*'`, el proceso registra un log
   `[startup]` explicando el motivo y aborta con `exit(1)` — mismo patrón que
   el chequeo existente de `DATABASE_URL`/`AUTH_SECRET` en `src/server.js`.
2. Fuera de producción (`NODE_ENV !== 'production'`, incluidos test y dev),
   `CORS_ORIGIN='*'` sigue funcionando exactamente igual que hoy — los 117
   tests actuales no cambian (ninguno pasa `NODE_ENV=production` a
   `createApp()`/`server.js`) y `npm run dev` no requiere configurar nada
   nuevo.
3. Un test nuevo (en `tests/app.test.js` o un archivo dedicado) simula
   `NODE_ENV=production` sin `CORS_ORIGIN` o con `CORS_ORIGIN='*'` y verifica
   que el arranque se rechaza (si la validación vive en `server.js`, cubrir
   con un test que invoque la misma función extraída/expuesta para test, sin
   arrancar un proceso real — coherente con el patrón de factories con DI del
   proyecto, no acoplar el test a `process.exit`).
4. `docs/architecture.md` §4 y §12 documentan la nueva validación y el
   mensaje de error; `docs/verification.md` si aplica al checklist de
   despliegue.
5. No se toca `render.yaml`: `CORS_ORIGIN` sigue siendo responsabilidad
   humana configurarla en el dashboard; esta feature solo hace explícito el
   fallo si no se hizo, no la configura por el agente.

### Candidata B (prioridad MEDIA) — JSON malformado en `POST /api/contact` responde `400`, no `500`

Ver punto 2, ítem 1, para el detalle técnico. Esfuerzo bajo, ya señalado dos
veces en review, no tiene urgencia de seguridad (el único cliente real, la
SPA, siempre genera JSON válido; el caso solo se dispara con un cliente roto
o un ataque trivial de fuzzing) pero sí es una inconsistencia de contrato HTTP
que vale la pena cerrar porque ya está identificada y acotada.

**Criterios de aceptación:**
1. Un `POST` con `Content-Type: application/json` y un body no parseable
   responde `400 { "error": "<mensaje genérico>" }` en vez de `500`.
2. Un `throw`/rechazo que **no** venga marcado por `body-parser`
   (`err.status`/`err.expose` ausentes) sigue respondiendo `500` genérico
   exactamente igual que hoy — no se relaja el catch-all para errores reales
   del servidor.
3. `tests/app.test.js` actualiza el test existente ("un JSON malformado en el
   body responde JSON 500 genérico...", línea 120) a la nueva expectativa
   (`400`) y añade un test que confirme que un error interno genuino (p. ej.
   el mismo mecanismo ya usado en la feature 2, `authSecret: {}` para forzar
   un throw real) sigue devolviendo `500`.
4. `docs/api-contract.md` ("Errores no controlados", líneas 169-187)
   documenta la distinción 400 (input malformado del cliente) vs 500 (bug del
   servidor).

### Evaluadas y descartadas explícitamente (no proponerlas)

Para no inflar el backlog, evalué y descarto estas por desproporcionadas para
el tamaño del proyecto:

- **CSRF token completo / doble-submit cookie.** Si la Candidata A se
  implementa, el vector real (CORS mal configurado) queda cerrado sin
  necesidad de un mecanismo de tokens nuevo. Añadir CSRF tokens además sería
  complejidad redundante para un panel admin de un solo tipo de cliente (la
  SPA propia).
- **Rate limiting distribuido / Redis.** Ya es una decisión consciente
  documentada en `docs/architecture.md` §13 ("Redis sería sobre-ingeniería y
  una dependencia nueva" para Render free de un solo proceso). No hay
  información nueva que la reabra.
- **Migrador de esquema formal (Knex/Prisma/node-pg-migrate).** `docs/context.md`
  línea 35 y `docs/database.md` documentan la decisión consciente de DDL
  idempotente en código "suficiente para el tamaño actual". Nada en el
  repo indica que esto haya dejado de ser cierto.
- **Test directo del guard `remainingMs <= 0`** (ítem 5 del inventario de
  deuda). El propio reviewer de la feature 5 ya lo evaluó y lo aceptó como
  "cinturón y tirantes" no bloqueante — forzar un test de una rama
  defensivamente inalcanzable en un proyecto de este tamaño no aporta, es
  sobre-testeo.
- **Observabilidad/APM, logging estructurado a un servicio externo.**
  Desproporcionado para un servicio en el plan free de Render con logs de
  consola `[startup]`/`[mail]`/`[auth]` ya suficientes para su volumen actual.
- **Linter/CI formal.** `docs/conventions.md` línea 11-12 es explícito: "no
  introduzcas ninguno sin que sea una feature explícita" — no hay ninguna
  señal de que el proyecto lo necesite hoy; introducirlo sería una decisión
  de proceso, no una necesidad detectada.

Si el humano decide no priorizar ni siquiera las dos candidatas de arriba,
esa es una respuesta razonable: ninguna de las dos es bloqueante para que la
landing y el panel admin sigan funcionando como hoy.

---

## 4. Riesgos abiertos que no son features

Separado explícitamente de las candidatas — nada de esto lo puede cerrar un
agente escribiendo código:

1. **Nada se ha commiteado ni pusheado en las seis sesiones de agentes
   (2026-07-27 a 2026-07-28).** `main` y `origin/main` están igualados; todo
   el trabajo de las features 0-6 vive solo como cambios sin commitear en este
   disco. El repo público en GitHub sigue exactamente como estaba antes de
   empezar el arnés — incluido `.env` todavía trackeado en `origin/main` (la
   feature 1 solo tocó el índice local). Si este entorno se pierde o se
   resetea sin que un humano revise y commitee, **se pierde el trabajo de
   cinco features aprobadas**. Acción requerida: que el humano revise el
   diff acumulado (mezclado, sin separar por feature) y decida cómo
   commitearlo — probablemente requiere reconstruir manualmente los commits
   por feature si quiere mantener la trazabilidad de `docs/conventions.md`
   §12, porque ya no hay forma de separarlos automáticamente.
2. **Rotación de credenciales pendiente**, con más urgencia ahora que se
   confirma que el repo público sigue exponiendo `.env` en su historial (y en
   su índice actual de `origin/main`, ver punto 1): `DATABASE_URL`,
   `SMTP_PASS`, `SMTP_USER`, `AUTH_SECRET`, `MAIA_ADMIN_PASSWORD`. Detalle en
   `progress/current.md` (sección persistente) y `docs/architecture.md` §14.1.
3. **Supuesto de infraestructura sin verificar**: que el proxy de Render
   añade su propio hop a `X-Forwarded-For` en vez de reenviar la conexión sin
   tocarla (base de toda la defensa de `trust proxy: 1` contra spoofing de
   IP para el rate limiting). Requiere un request real contra el servicio
   desplegado. Ver `progress/review_3.md` líneas 204-208.
4. **Supuesto de infraestructura sin verificar (nuevo, detectado en este
   análisis)**: si `CORS_ORIGIN` está realmente configurada en el dashboard
   de Render hoy, o si el servicio corre en producción con el default `'*'`.
   No es verificable desde este repo — solo inspeccionando el dashboard de
   Render o probando contra el servicio desplegado con un `Origin` arbitrario.
   Si la Candidata A del punto 3 se implementa, esto deja de depender de que
   alguien lo recuerde y pasa a fallar-rápido de forma visible.
5. **Política de backups de la base de datos** (Postgres gestionado, proveedor
   no confirmado en el repo — Neon/Supabase/Render Postgres según las notas
   de la feature 1). Ninguna fuente del repo documenta si hay backups
   automáticos ni su retención. No lo elevo a feature (depende del plan del
   proveedor, no de código en este repo) pero es una pregunta abierta que
   vale la pena que el humano confirme directamente con el proveedor.
6. **Decisión pendiente sobre purgar el historial de git** (`git filter-repo`/
   BFG) para el caso de `.env` — explícitamente fuera del alcance de cualquier
   agente, decisión y ejecución 100% humanas (`docs/architecture.md` §14.1).

---

## 5. Incoherencias del propio arnés

1. **`docs/architecture.md` se contradice consigo mismo en el recuento de
   tests.** §2 (línea 57, árbol de archivos) todavía dice `# vitest +
   supertest, 7 suites (86 tests)`, mientras que §11 (líneas 464-466) dice
   correctamente "10 archivos ... (117 tests)". Ambas secciones se tocaron en
   sesiones distintas y §2 quedó desactualizada desde antes de la feature 4
   (que sí actualizó §11 pero no revisó el árbol de §2).
2. **`CHECKPOINT.md` C1 tiene un baseline desactualizado.** Línea 9: "`npm
   test` pasa: 7 suites, ≥ 86 tests." Técnicamente el criterio `≥ 86` sigue
   cumpliéndose con 117, así que no bloquea nada por accidente, pero el
   número "7 suites" ya no es cierto (son 10) y puede confundir a un reviewer
   que compare el conteo exacto de archivos en vez del umbral de tests. Vale
   la pena actualizarlo a "10 suites, ≥ 117 tests" para que dosifique
   correctamente contra el baseline real documentado en `docs/verification.md`
   §3.
3. **`docs/context.md` §5 (línea 55-58) describe un backlog que ya no
   existe.** Dice: "el trabajo pendiente ... reflejadas como features
   `pending` en `feature_list.json` (rate limiting, middleware de errores,
   `.env` versionado, etc.)" — las tres features citadas como ejemplo de
   "pendientes" (rate limiting, middleware de errores, `.env`) son
   precisamente tres de las cinco que se cerraron `done` en esta sesión. Esta
   línea quedó obsoleta y, leída hoy, sugiere que el backlog sigue teniendo
   trabajo pendiente cuando `feature_list.json` está vacío.
4. **`feature_list.json` no conserva `acceptance`/`scope` en las entradas
   `done`.** Los reviews citan listas de criterios de aceptación concretos
   que existieron mientras cada feature estaba `pending`/`in_progress`
   (p. ej. los 4 criterios de la feature 5, `progress/review_5.md` líneas
   25-47; los 5 de la feature 3, `progress/review_3.md` líneas 129-146), pero
   una vez archivada la feature en `done` solo queda la `note` en prosa —
   la estructura verificable (`acceptance` como lista) se pierde. Para
   trazabilidad futura (p. ej. si alguien quisiera re-auditar qué exactamente
   se prometió vs. qué se entregó sin tener que releer todo `progress/history.md`)
   sería más robusto que las entradas `done` conservaran también el
   `acceptance` original, no solo la `note` de cierre.

Ninguna de estas cuatro es bloqueante ni riesgosa — son inconsistencias de
documentación de bajo impacto, no de código ni de seguridad. Las señalo
porque el encargo pedía explícitamente detectarlas.

---

## Resumen ejecutivo

- El backlog cerrado (features 0-5, descarte 6) está genuinamente cerrado;
  no encontré ninguna nota que prometa más de lo que hay en el código.
- La deuda menor ya identificada por los propios reviews (JSON malformado
  400 vs 500, verificación de `trust proxy` en producción, rotación de
  credenciales) nunca se convirtió en entradas de `feature_list.json` —
  ahora está capturada en las secciones 2 y 4 de este documento.
- Propongo **dos** candidatas nuevas, no más: A (CORS_ORIGIN fail-fast en
  producción, prioridad alta, riesgo de seguridad real y barato de cerrar) y
  B (400 vs 500 en JSON malformado, prioridad media, corrección de contrato
  ya acotada). Evalué y descarté explícitamente seis ideas más por
  desproporcionadas para el tamaño del proyecto.
- El hallazgo más importante de todo este análisis no es una feature: **nada
  de lo trabajado en seis sesiones se ha commiteado ni pusheado**, `main` y
  `origin/main` siguen idénticos, y el repo público en GitHub sigue teniendo
  `.env` trackeado tal cual estaba antes de empezar. Recomiendo que esto se
  resuelva (revisar y commitear) antes de abrir cualquier feature nueva,
  independientemente de qué se decida sobre las candidatas A y B.
