# CHECKPOINT — criterios objetivos de "estado final correcto"

> El `reviewer` recorre esta lista y marca `[x]` / `[ ]` en `progress/review.md`.
> No son gustos: cada punto es verificable con un comando o leyendo un archivo.
> Un `[ ]` en C1–C6 es **CHANGES_REQUESTED** automático.

## Bloqueantes

- **C1 — Tests verdes.** `npm test` pasa: 7 suites, ≥ 86 tests. Ningún test
  eliminado o marcado `skip` sin justificación escrita en `progress/current.md`.
- **C2 — Cobertura del acceptance.** Cada criterio de `acceptance` de la feature
  tiene al menos un test que lo ejercita. Se puede señalar el archivo y el `it()`.
- **C3 — Factories con DI intactas.** Ningún módulo lee `process.env` en tiempo
  de import ni crea singletons globales. La app de test se sigue construyendo
  igual que la real (`createApp({ pool, schema, mailer })`).
- **C4 — SQL seguro.** Todo valor de usuario parametrizado (`$1, $2, …`). El
  único elemento interpolado es `schema`, entre comillas dobles, y no proviene
  de ninguna request.
- **C5 — Contrato de API.** Si cambió la forma de una respuesta o un código de
  estado, `docs/api-contract.md` está actualizado en el mismo commit.
- **C6 — Sin secretos.** Ningún valor de `.env` aparece en código, tests, logs,
  commits ni en `progress/`. Variables nuevas documentadas por **nombre** en
  `.env.example`, nunca con su valor.

## Calidad

- **C7 — Separación de capas.** Los `*Router.js` no escriben SQL; `articles.js`
  y `leads.js` no importan express ni tocan `req`/`res`.
- **C8 — Errores manejados.** Todo handler async tiene `try/catch`. Se loggea el
  error real con prefijo de módulo y se responde un mensaje genérico; nunca
  stack, SQL ni estado del mailer al cliente.
- **C9 — DDL idempotente.** Cualquier cambio en `ensureSchema()` usa
  `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`. Cero `DROP` y cero mutación de
  datos. Columnas nuevas nullable o con `DEFAULT`. `docs/database.md` actualizado.
- **C10 — Escape de HTML en correo.** Todo string de usuario interpolado en una
  plantilla pasa por `escapeHtml()`. Cada plantilla conserva versión `text` y `html`.
- **C11 — Limpieza.** Sin `console.log` de debug, sin código muerto, sin TODOs
  sin contexto, sin archivos temporales en `git status`.
- **C12 — Alcance.** El diff toca **una sola** feature. Nada de refactors
  oportunistas mezclados con la implementación.

## Proceso

- **C13 — Trazabilidad.** `progress/current.md` refleja lo que realmente se hizo
  (feature, plan, archivos tocados, decisiones) y se escribió durante el trabajo.
- **C14 — Estado coherente.** La feature está `in_progress` en
  `feature_list.json` durante el trabajo; solo pasa a `done` tras APPROVED.
- **C15 — Git.** Rama propia (no `main`), commits en formato convencional en
  español (ver `docs/conventions.md` §12).

## Invariantes del sistema (no romper nunca)

- **I1** — `POST /api/contact` responde `201` aunque el correo falle. El estado
  del envío no aparece en la respuesta HTTP.
- **I2** — Un artículo `draft` responde `404` en la ruta pública, no `403`.
- **I3** — `password_hash` nunca sale por la API.
- **I4** — El login responde el mismo `401` para usuario inexistente y para
  password incorrecta.
- **I5** — El rol se recarga desde la DB en cada request (el token no lo lleva).
- **I6** — En producción la cookie de sesión es `SameSite=None; Secure`, o el
  panel deja de funcionar cross-origin.
