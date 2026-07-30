# Verificación — cómo comprobar que tu trabajo funciona

> Léelo **antes** de declarar cualquier tarea `done`. Sin esto verde, no hay `done`.

## 1. Requisito previo: Postgres

**La mayoría de los tests no corren en seco.** Son de integración real contra
Postgres. Hay un subconjunto pequeño que sí corre sin DB — ver §1.1. Antes de
`npm test` comprueba primero:

```bash
pg_isready
```

Conexión que usan las suites, en este orden de precedencia:

1. `TEST_DATABASE_URL`
2. `DATABASE_URL`
3. `postgres:///maia-landing?host=/var/run/postgresql` (default local)

Cada suite crea su propio schema `maia_test_<timestamp>_<random>`, corre
`ensureSchema()` y hace `DROP SCHEMA … CASCADE` en `afterAll`. No tocan `public`.

Si `pg_isready` falla: **para**. Es un problema de entorno, no de tu feature.
Anótalo en `progress/current.md` y repórtalo — no lo "arregles" dentro de la tarea.

### 1.1 `npm run test:no-db` — el subconjunto que sí corre en seco

Tres archivos de `tests/` no abren ninguna conexión a Postgres: no importan
`db.js`, no crean un `pool` ni corren `ensureSchema`. Se pueden correr con
Postgres apagado (o inexistente, p. ej. en un runner de CI sin base de datos):

```bash
npm run test:no-db
```

Ejecuta exactamente `vitest run tests/phone.test.js tests/email.test.js
tests/roles.test.js` (30 tests hoy):

- `tests/phone.test.js` — `detectCountry()`, parseo E.164 puro.
- `tests/email.test.js` — `createMailer()` con un `transporter` fake inyectado
  (nunca abre un socket SMTP real).
- `tests/roles.test.js` — `ROLES`, `hasRole()`, `requireRole()` sobre mocks de
  Express hechos a mano (`vi.fn()`), sin `req`/`res` reales.

**Cuándo usarlo**: como comprobación rápida de humo mientras iteras en uno de
esos tres módulos, o en un paso de CI que no tiene Postgres disponible (p. ej.
un lint/smoke-check previo al job que sí levanta la base). **Qué NO cubre —
importante, no lo confundas con "la app entera pasó los tests"**:

- Ninguna query SQL real: nada de índices, `UNIQUE`, `FK` ni códigos de error
  de Postgres (`23505`, etc.).
- `POST /api/contact`, el flujo completo de leads, artículos, imágenes
  (incluido el binario BYTEA y el `/raw`), el CRUD de usuarios (bcrypt, la
  guarda del último admin, `ON DELETE SET NULL` de `author_id`), auth
  (login/JWT contra usuarios reales), rate limiting montado sobre `createApp()`,
  ni el middleware de errores montado sobre una app real — todo eso vive en los
  otros 9 archivos y **solo** corre con `npm test`.
- La migración `ALTER TABLE users ADD COLUMN role` (`ensureSchema`), que se
  separó a propósito a `tests/roles.schema.test.js` — sigue necesitando DB y
  solo corre con `npm test`.
- No es una señal de "deploy seguro". Antes de cerrar cualquier feature, la
  verificación obligatoria sigue siendo `npm test` completo (§2), con
  Postgres arriba.

Verificado que corre igual con Postgres apagado de verdad — sin levantar ni
detener el servicio del sistema, apuntando la conexión a un puerto muerto:

```bash
TEST_DATABASE_URL="postgres://nouser:nopass@127.0.0.1:1/nodb" npm run test:no-db
```

pasa igual (30/30), mientras que el mismo `TEST_DATABASE_URL` roto hace que
cualquier suite con DB real (p. ej. `npm test -- tests/contact.test.js`) falle
con `ECONNREFUSED` — confirma que `test:no-db` nunca llega a intentar una
conexión.

## 2. Comandos

```bash
npm install          # solo si tocaste dependencias
npm test             # vitest run — la verificación obligatoria, requiere Postgres
npm run test:no-db   # subconjunto sin DB (phone, email, roles puro) — ver §1.1
npm test -- tests/contact.test.js     # una suite concreta, mientras iteras
npm run dev          # servidor con --watch en http://localhost:3001
```

**No existe `npm run build`.** Es JavaScript ESM plano: no hay compilación ni
type-check. Cualquier instrucción que mencione `build`, `tsc` o `nest` está
desactualizada.

## 3. Baseline conocido

Última corrida verde de referencia (2026-07-30, feature 8):

```
npm test
Test Files  12 passed (12)
     Tests  221 passed (221)
  Duration  ~20-30 s
```

Archivos: `contact`, `email`, `articles`, `auth`, `leads`, `phone`, `roles`,
`roles.schema`, `app`, `ratelimit`, `images`, `users`. `users.test.js` (53
tests) entró con la feature 8 (CRUD de usuarios), que además convirtió en 3 el
test de `articles.test.js` que afirmaba `403` para el `editor` en el `DELETE` de
artículos (ese permiso cambió a propósito: ahora es `204`; el test se
**actualizó**, no se borró, y el archivo pasó de 13 a 15 tests). El baseline
anterior era 11 archivos / 166 tests (feature 7) y ningún test se eliminó ni se
marcó `skip`. `images.test.js` (49 tests) entró con la feature 7; antes de ella
el baseline era 10 archivos / 117 tests (feature 4).
`roles.test.js` y `roles.schema.test.js`
son dos archivos desde la feature 4 (split para separar la parte pura de
`roles.js` de la migración `ALTER TABLE users ADD COLUMN role`, que sí
necesita DB) — el total de tests de "roles" (15) no cambió, solo su reparto
entre dos archivos.

```
npm run test:no-db
Test Files  3 passed (3)
     Tests  30 passed (30)
```

Si tras tu cambio hay **menos** tests que antes, explica por qué en
`progress/current.md`. Borrar un test para poner la suite en verde es un fallo
de review automático.

## 4. Qué mirar además de "verde"

- **stderr esperado**: `[auth] AUTH_SECRET no configurada…` en `contact.test.js`
  es normal (la suite no define secreto). Cualquier otro warning nuevo es tuyo.
- **Sin `console.log` de debug** en `src/`. Los logs legítimos llevan prefijo
  (`[startup]`, `[mail]`, `[leads]`, `[articles]`).
- **Schemas huérfanos**: si una suite se corta a mitad puede dejar
  `maia_test_*`. Compruébalo y límpialo:

  ```bash
  psql -Atc "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'maia_test_%'"
  ```

## 5. Verificación manual (cuando tocas HTTP o correo)

```bash
npm run dev
curl -s localhost:3001/api/health
curl -s -X POST localhost:3001/api/contact \
  -H 'Content-Type: application/json' \
  -d '{"nombre":"Test","email":"t@e.com","telefono":"+525512345678","tipo":"demo"}'
```

Con `SMTP_HOST` vacío el correo se omite (`status: 'skipped'`) y el lead se
guarda igual: es el modo por defecto de desarrollo, no un fallo.

Para el flujo admin necesitas un usuario:

```bash
node scripts/create-user.js admin@maiabuilder.ai <password> "Admin"
```

## 6. Checklist antes de cerrar

1. `npm test` → 12/12 archivos (221 tests), sin tests eliminados sin justificar.
   Si tocaste solo `phone`/`email`/`roles` puedes iterar rápido con
   `npm run test:no-db` (§1.1), pero **no sustituye** a `npm test` para cerrar.
2. Los criterios de `acceptance` de tu feature tienen **un test que los cubre**.
3. `CHECKPOINT.md` repasado: nada que estaba `[x]` quedó roto.
4. Si tocaste un endpoint → `docs/api-contract.md` actualizado en el mismo commit.
5. Si tocaste el esquema → `docs/database.md` actualizado en el mismo commit.
6. `git status` limpio de temporales.
