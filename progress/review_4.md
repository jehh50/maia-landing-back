# Review — feature 4: Suite unitaria que corra sin Postgres

**Veredicto:** APPROVED
**Tests:** `npm test` → 10 suites / 117 tests (verde). `npm run test:no-db` → 3 suites / 30 tests (verde).

## Verificación realizada por el reviewer (no solo el reporte del implementer)

1. **`package.json`** — `git diff package.json` muestra un único hunk: se añade
   la línea `"test:no-db": "vitest run tests/phone.test.js tests/email.test.js
   tests/roles.test.js"` dentro de `"scripts"`. `"test": "vitest run"` queda
   idéntico, `"dependencies"`/`"devDependencies"` sin tocar. `package-lock.json`
   sin diff (`git diff HEAD -- package-lock.json` vacío, mtime del archivo
   sigue en `jun 5`, anterior a esta sesión). Coincide exactamente con la
   autorización del humano en `feature_list.json` (`notes` de la feature 4).

2. **Split de `tests/roles.test.js`.** `git diff tests/roles.test.js` muestra
   que el único contenido eliminado del archivo original es el describe
   `"ensureSchema añade columna \`role\` a users"` completo (líneas 114-172 del
   original), sin tocar una sola línea de los tres describes que quedan
   (`ROLES (constantes)`, `hasRole(user, ...roles)`,
   `requireRole(...roles) middleware`). Comparé `git show HEAD:tests/roles.test.js`
   contra la suma de `tests/roles.test.js` + `tests/roles.schema.test.js`
   actuales, `it()` por `it()`:
   - `ROLES (constantes)`: `expone admin y editor`, `es inmutable (Object.freeze)` — idénticos, en `roles.test.js`.
   - `hasRole(user, ...roles)`: los 7 `it()` (`admin coincide con admin → true`,
     `editor NO coincide con admin → false`, `editor coincide cuando la lista
     es [admin, editor] → true`, `user null → false`, `user undefined → false`,
     `user sin campo role → false`, `lista vacía de roles → false`) — idénticos,
     mismas aserciones, en `roles.test.js`.
   - `requireRole(...roles) middleware`: los 4 `it()` (`rol insuficiente → 403
     y NO llama a next()`, `rol coincide → llama a next() sin tocar res`,
     `lista con múltiples roles permite a cualquiera`, `sin req.user → 403`) —
     idénticos, en `roles.test.js`.
   - `ensureSchema añade columna \`role\` a users`: los 2 `it()` (`después de
     ensureSchema, users.role existe con default "editor"`, `ensureSchema NO
     rompe cuando la tabla users no existe`) — movidos byte a byte (mismo
     `beforeAll`/`afterAll`, mismas queries SQL, mismas aserciones) a
     `tests/roles.schema.test.js`.
   Total: 13 + 2 = 15, igual que el original (13 en `roles.test.js` + 2 en
   `roles.schema.test.js` confirmado también por la salida de `npm test`:
   `✓ tests/roles.test.js (13 tests)` / `✓ tests/roles.schema.test.js (2 tests)`).
   Ninguna aserción aguada, ninguna eliminada.

3. **`test:no-db` corre de verdad sin Postgres.** Ejecutado por el reviewer:
   ```
   TEST_DATABASE_URL="postgres://nouser:nopass@127.0.0.1:1/nodb" npm run test:no-db
   → Test Files 3 passed (3) / Tests 30 passed (30)
   ```
   Control (misma variable rota, suite con DB real):
   ```
   TEST_DATABASE_URL="postgres://nouser:nopass@127.0.0.1:1/nodb" npm test -- tests/contact.test.js
   → FAIL: Error: connect ECONNREFUSED 127.0.0.1:1 en ensureSchema (src/db.js:32) dentro del beforeAll de tests/contact.test.js
   ```
   Confirma que el aislamiento es real, no un artefacto de caché o de mocks.

4. **`npm test` completo**, ejecutado por el reviewer con Postgres arriba
   (`pg_isready` → accepting connections): `Test Files 10 passed (10)` /
   `Tests 117 passed (117)`. Coincide con el baseline documentado en
   `docs/verification.md` §3 y con el acceptance ("117 tests hoy").

5. **Honestidad de `docs/verification.md` §1.1.** La lista de "qué NO cubre"
   (sin queries SQL reales/índices/UNIQUE/FK/códigos de error; sin
   `POST /api/contact`, leads, articles, auth con JWT real, rate limiting
   montado sobre `createApp()`, ni el middleware de errores sobre app real —
   "todo eso vive en las otras 7 suites"; sin la migración `ALTER TABLE users
   ADD COLUMN role`; "no es señal de deploy seguro") es verificable y precisa:
   con 10 archivos totales y 3 en `test:no-db`, quedan exactamente 7
   (`contact`, `articles`, `auth`, `leads`, `app`, `ratelimit`,
   `roles.schema`), que es lo que dice el texto. No hay sobreventa del
   comando — al contrario, insiste varias veces en que no sustituye a
   `npm test`.

## Checkpoints

- C1 Tests verdes: [x] — 117/117 con `npm test`, ejecutado por el reviewer.
- C2 Cobertura del acceptance: [x]
  - "Existe un comando que corre solo phone/email/validación pura y pasa con
    Postgres apagado" → verificado con `TEST_DATABASE_URL` roto arriba (punto 3).
  - "`npm test` sigue corriendo la suite completa (117 tests)" → verificado (punto 4).
  - "docs/verification.md documenta ambos comandos" → `docs/verification.md`
    §1.1 y §2, revisado (punto 5).
- C3 Factories con DI intactas: [x] — no se tocó ningún módulo de `src/`.
- C4 SQL seguro: [x] — el SQL movido a `roles.schema.test.js` es idéntico al
  original (parametrizado donde corresponde, `schema` interpolado entre
  comillas dobles como siempre).
- C5 Contrato de API: [x] (no aplica — ningún endpoint tocado).
- C6 Sin secretos: [x] — sin valores de `.env` en el diff ni en `progress/current.md`.
- C7 Separación de capas: [x] (no aplica — solo tests y `package.json`).
- C8 Errores manejados: [x] (no aplica).
- C9 DDL idempotente: [x] (no aplica — sin cambios de esquema).
- C10 Escape HTML en correo: [x] (no aplica).
- C11 Limpieza: [x] — `git status` no muestra temporales nuevos de esta feature; sin `console.log` añadido.
- C12 Alcance: [x] — diff limitado a `package.json`, `tests/roles.test.js`,
  `tests/roles.schema.test.js` (nuevo) y documentación (`docs/verification.md`,
  `docs/architecture.md`, `docs/context.md`), todo en función del acceptance
  de esta feature. Nada de `src/` tocado.
- C13 Trazabilidad: [x] — `progress/current.md` lista exactamente los archivos
  que el diff real muestra tocados; no hay discrepancia.
- C14 Estado coherente: [x] — feature 4 sigue `in_progress` en
  `feature_list.json`, no se marcó `done` (correcto, eso lo hace el implementer
  tras este APPROVED).
- C15 Git: ignorado por instrucción explícita — nada commiteado.
- I1-I6: [x] — invariantes de negocio no tocadas por esta feature (solo tests/harness).

## Bloqueantes

Ninguno.

## Menores (no bloquean)

Ninguno.
