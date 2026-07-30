# Contexto del proyecto — MaIA Landing Back

> Léelo **antes** de `architecture.md`. Aquí está el *porqué*; allí el *qué*.

## 1. Qué es esto

API JSON en Node.js/Express que da servicio a la landing de MaIA. Tres
responsabilidades, en orden de importancia de negocio:

1. **Capturar leads** del formulario de contacto/demo (`POST /api/contact`).
   Es el camino crítico: si esto se cae, el negocio pierde dinero directo.
2. **Enviar correos transaccionales** (aviso a ventas + confirmación al usuario).
   Best-effort: importante, pero nunca debe bloquear la captura del lead.
3. **Panel admin**: login con cookie, CRUD de artículos (blog), consulta de
   leads, CRUD de las imágenes de las secciones de la landing (feature 7) y
   mantenedor de usuarios/roles (feature 8, solo `admin`).

## 2. Repos hermanos

| Repo | Rol |
|---|---|
| `../maia-landing-front` | SPA React que consume esta API (deploy en Vercel) |
| `../maia-landing` | Sitio/landing original |
| **este repo** | API (deploy en Render, servicio `maia-api`) |

El front y el back se despliegan por separado y en dominios distintos → **todo
es cross-origin**. De ahí las decisiones de CORS y de cookies (`SameSite=None` +
`Secure` en producción). Cambiar eso rompe el login del panel en producción
aunque los tests locales sigan verdes.

## 3. Decisiones ya tomadas (no las reabras sin motivo)

| Decisión | Por qué | Dónde vive |
|---|---|---|
| JavaScript ESM plano, sin TypeScript ni framework | Proyecto pequeño; el coste de un build step no se paga | `package.json` (`"type": "module"`, sin `build`) |
| Factory functions con inyección de dependencias | Permite tests de integración reales sin mocks globales | `architecture.md` §2 |
| DDL idempotente en `db.js`, sin migrador | Suficiente para el tamaño actual; corre en cada boot | `database.md` |
| Tests contra Postgres real, un schema por suite | Cubre SQL, índices, UNIQUE, FK y códigos de error de verdad | `verification.md` |
| Correo best-effort, persistencia bloqueante | Un lead perdido es peor que un correo perdido | `architecture.md` §6 |
| Doble proveedor de correo (SMTP / Resend HTTP) | Render free bloquea puertos SMTP salientes | `architecture.md` §9 |
| Multi-tenancy por `DB_SCHEMA` interpolado | Es lo que aísla los tests; **nunca** viene de input de usuario | `database.md` |
| Imágenes subidas con el binario en Postgres (BYTEA) | El filesystem de Render es efímero y un proveedor externo (S3/Cloudinary) pediría credenciales nuevas | `architecture.md` §7 / §7.1 |
| El `editor` gestiona solo el blog (incluido borrar publicaciones); usuarios e imágenes son solo de `admin` | Es la definición del rol; repartir cuentas y roles es administración del sistema | `architecture.md` §8 / §8.1 |
| Borrado de usuario físico, y no se puede borrar al último `admin` | Los artículos sobreviven por `ON DELETE SET NULL`, así que no hace falta borrado lógico; quedarse sin admins deja el panel inaccesible | `architecture.md` §8.1 |

## 4. Restricciones del entorno

- **Render plan free**: el servicio se duerme por inactividad (primer request
  lento, `ensureSchema` corre en cada despertar) y **no permite SMTP saliente**.
- **Node 22** fijado en `.node-version`. No uses APIs más nuevas.
- **`npm test` (la verificación obligatoria) requiere un Postgres accesible.**
  Un subconjunto pequeño (`npm run test:no-db`: `phone`, `email`, la parte pura
  de `roles`) corre sin DB para iterar rápido o para un paso de CI sin base de
  datos, pero no sustituye a `npm test` (ver `verification.md` §1.1).
- Los secretos viven en el dashboard de Render (`sync: false` en `render.yaml`),
  nunca en el repo.

## 5. Estado actual

v1.3.0, en producción y funcionando. El trabajo pendiente **no es construir el
sistema**, sino cerrar las brechas listadas en `architecture.md` §14 y
reflejadas como features `pending` en `feature_list.json` (rate limiting,
middleware de errores, `.env` versionado, etc.).

Corolario práctico: casi todo cambio aquí es sobre **código que ya existe y ya
tiene tests**. Antes de escribir, lee el módulo y su suite.
