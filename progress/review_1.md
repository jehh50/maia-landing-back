# Review — feature 1: Sacar .env del control de versiones

**Veredicto:** APPROVED
**Tests:** `npm test` → 9 suites / 117 tests, verde (baseline vigente: 9/117, tras cierre de features 2, 3 y 5)

## Nota de proceso (autocrítica del reviewer, no imputable al implementer)

Al inspeccionar el índice ejecuté `git diff --cached` sin `--stat`/`--name-only`.
Como `.env` está en borrado (`D  .env`), ese comando imprimió el contenido
completo del diff, incluidas 2 líneas con valores reales (`MAIL_TO` y
`VITE_API_BASE`). Esto contraviene la instrucción de no leer `.env` por
ninguna vía. Ninguno de esos valores se ha vuelto a citar, ni se ha escrito
en ningún archivo (este incluido) ni se usó para ningún juicio de la review.
Se corrigió el resto de la verificación usando siempre `--name-only`/`--stat`.
No afecta al veredicto porque el hallazgo es un error mío de ejecución de
comando, no un secreto expuesto por el trabajo del implementer (que en
ningún momento leyó ni citó valores de `.env`, ver C6 más abajo).

## Verificación de los 4 `acceptance`

1. **`git ls-files .env` no devuelve nada** — verificado, salida vacía. ✅
2. **`.env` sigue en disco y el servidor arranca igual** — verificado:
   `test -f .env` → PRESENT. Arranqué `node src/server.js` en background,
   leyó `.env` desde disco (ya no trackeado), log `[startup] Schema "public"
   listo.` / `[startup] MaIA API escuchando...`, `GET /api/health` → `HTTP 200`
   `{"ok":true,"db":true,"mailer":true}`. Proceso detenido tras la prueba,
   sin procesos `server.js` residuales (`ps aux` limpio). ✅
3. **`.env.example` documenta todas las variables sin valores reales** —
   audité `process.env.` en `src/` y `scripts/` (incluyendo el patrón
   dinámico `process.env[name]` usado por `positiveNumberFromEnv` en
   `src/app.js:31-32` y `src/auth.js:18-19`, y `src/server.js:6`) contra las
   claves de `.env.example`. Lista completa usada por el código: `PORT,
   CORS_ORIGIN, DATABASE_URL, DB_SCHEMA, PGSSL, SMTP_HOST, SMTP_PORT,
   SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_TO, AUTH_SECRET,
   AUTH_REFRESH_WINDOW_MS, NODE_ENV, MAIA_ADMIN_EMAIL, MAIA_ADMIN_PASSWORD,
   CONTACT_RATE_LIMIT_WINDOW_MS/MAX, AUTH_RATE_LIMIT_WINDOW_MS/MAX`. Las 21
   están en `.env.example`, todas con placeholder o vacío, ninguna con valor
   real. El único gap real detectado por el implementer (`NODE_ENV`,
   `src/server.js` no la usa pero `src/auth.js` sí para `cookieSecure`) está
   documentado como comentario en `.env.example:1-4`. ✅
4. **`progress/current.md` documenta el inventario de rotación** — sección
   "Inventario de rotación de credenciales" presente, lista `DATABASE_URL,
   SMTP_PASS, SMTP_USER, AUTH_SECRET, MAIA_ADMIN_PASSWORD` con dónde se usan
   y cómo rotarlas, y explícitamente separa qué variables no son secretas.
   Todo por **nombre**, ningún valor. ✅

## Verificación de no filtración de secretos (punto 2 del encargo)

Revisé `progress/current.md`, `.env.example` y `feature_list.json` completos
buscando algo que pareciera un valor real (API key, connection string con
password, hash, token). No encontré ninguno: `.env.example` usa placeholders
(`cambiar-en-produccion`, vacíos, `postgres:///maia-landing?host=/var/run/postgresql`
que es la convención local de socket Unix sin credenciales, documentada así
desde antes de esta feature) y el inventario de `progress/current.md` habla
solo de nombres de variable y "dónde rotar", nunca de valores. `feature_list.json`
solo referencia nombres de variable en la nota de la feature. C6 cumplido por
el lado del implementer.

## Verificación de que no se commiteó/pusheó nada (punto 3)

- `git log --oneline -3` → `13f5ab5 update / 122bd37 fix: soporte Resend
  HTTP API y timeouts SMTP para Render / ef76a30 fix: validate env vars...`
  — sin cambios respecto al inicio. ✅
- `git branch -a` → solo `main` y `remotes/origin/main`, sin ramas nuevas. ✅
- `git status --short --branch` → `## main...origin/main`, sin indicar
  ahead/behind. ✅
- `git diff --cached --name-only` → únicamente `.env`. ✅ (único cambio en
  el índice es el borrado esperado)
- Sin rastro de `filter-repo`/`filter-branch` en `git reflog` ni artefactos
  (`*.bfg*`, `*filter-repo*`) en el árbol. ✅

## Checkpoints

- C1 Tests verdes: [x] — `npm test` → 9/9 suites, 117/117 tests, sin skips.
- C2 Cobertura del acceptance: [x] con salvedad — feature de saneamiento sin
  lógica de aplicación nueva (según el propio encargo). No hay ni corresponde
  un `it()` de vitest para "`.env` no está trackeado" o "el inventario de
  rotación existe en un `.md`". Cobertura verificada por mí con comandos de
  git y arranque real del servidor (detallado arriba), no por tests
  automatizados — es la vía correcta para este tipo de criterio.
- C3 Factories con DI: [x] — sin cambios de código; `createApp({ pool,
  schema, mailer })` sigue construyendo igual la app real y la de test
  (confirmado indirectamente: los 117 tests, que montan la app así, pasan).
- C4 SQL seguro: N/A — la feature no toca ninguna query ni capa de datos.
- C5 Contrato de API: N/A — no se tocó ningún endpoint ni forma de respuesta.
- C6 Sin secretos: [x] — ver sección dedicada arriba. Ningún valor de `.env`
  aparece en `.env.example`, `progress/current.md` ni `feature_list.json`;
  todo por nombre.
- C7 Separación de capas: N/A — sin cambios en routers ni capas de datos.
- C8 Errores manejados: N/A — sin cambios de código de aplicación.
- C9 DDL idempotente: N/A — sin cambios de esquema.
- C10 Escape de HTML en correo: N/A — sin cambios en `email.js` ni plantillas.
- C11 Limpieza: [x] — `git status --short` no muestra archivos temporales
  nuevos atribuibles a esta feature; sin `console.log` de debug (no hay
  código nuevo).
- C12 Alcance: [x] — el único cambio en el índice es `.env` (borrado), y el
  único archivo de trabajo modificado dentro del `scope` declarado
  (`["(git index)", ".env.example"]`) es exactamente `.env.example`, con un
  diff (`git diff -- .env.example`) que coincide línea por línea con lo
  descrito en `progress/current.md` (comentario `NODE_ENV` + ampliación del
  comentario de Resend HTTP API). El resto de archivos con cambios sin
  commitear (`.gitignore`, `README.md`, `src/app.js`,
  `src/articlesRouter.js`, `src/auth.js`, `src/leadsRouter.js`,
  `tests/auth.test.js`) corresponden a trabajo previo ya aprobado de las
  features 2/3/5, no a esta sesión — confirmado que no están mencionados
  como tocados en `progress/current.md` de esta feature, y por instrucción
  explícita del encargo se excluyen de esta revisión.
- C13 Trazabilidad: [x] — `progress/current.md` describe exactamente
  `git rm --cached .env` + las dos adiciones puntuales en `.env.example`;
  coincide con el diff real verificado (`git diff -- .env.example`,
  `git diff --cached --name-only`). Sin discrepancias.
- C14 Estado coherente: [x] — `feature_list.json` mantiene la feature 1 en
  `"status": "in_progress"`, no se marcó `done` (correcto, corresponde al
  implementer tras este APPROVED).
- C15 Git: N/A por instrucción explícita del encargo — el humano decidió
  dejarlo sin commitear para revisarlo él.

## Invariantes del sistema

- I1–I6: [x] — no tocados por esta feature; siguen verdes indirectamente vía
  `npm test` (117/117), que ejercita auth, contact, articles y leads sin
  regresiones.

## Bloqueantes

Ninguno.

## Menores (no bloquean)

1. Autocrítica de proceso del propio reviewer (ver nota arriba): usar
   siempre `git diff --cached --name-only` / `--stat` cuando haya un archivo
   tipo `.env` en el índice, nunca `git diff --cached` a secas, para no
   arriesgar mostrar contenido de un archivo con secretos aunque esté en
   borrado. No es un hallazgo sobre el trabajo del implementer.
2. La rotación de `DATABASE_URL`, `SMTP_PASS`/`SMTP_USER`, `AUTH_SECRET` y
   `MAIA_ADMIN_PASSWORD` sigue pendiente de ejecución humana (fuera del
   alcance de la feature, correctamente señalado como tal tanto en
   `feature_list.json` como en `progress/current.md`).
