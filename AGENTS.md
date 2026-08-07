# AGENTS.md — Mapa de navegación para agentes de IA (Backend)

> Este archivo es el **punto de entrada** para cualquier agente que trabaje en este
> repositorio. NO es una biblia de reglas: es un **mapa**. Lee solo lo que
> necesites cuando lo necesites (divulgación progresiva).

---

## 1. Antes de empezar (obligatorio)

1. Ejecuta los tests del backend (ver `docs/verification.md` para los comandos exactos)
   y verifica que terminan sin errores. Si fallan, **para** y resuelve el entorno antes de
   tocar código. Si el entorno ya estaba roto antes de tu sesión, no es tu culpa —
   pero igual debes detenerte y reportarlo en `progress/current.md`, no "arreglarlo"
   como parte de la feature que ibas a hacer.
2. Lee `progress/current.md` para entender en qué estado quedó la última sesión.
3. Lee `docs/context.md` para entender el contexto y las decisiones ya tomadas, y
   luego `docs/architecture.md` para entender qué significa "hacer un buen trabajo"
   en este proyecto. Lee context antes que architecture: el contexto suele explicar
   el porqué de una decisión de arquitectura.
4. Lee `feature_list.json` y elige **una** tarea con estado `pending`. No
   trabajes en más de una a la vez.

## 2. Mapa del repositorio

| Archivo / carpeta            | Qué contiene                                              | Cuándo leerlo |
|------------------------------|-----------------------------------------------------------|---------------|
| `feature_list.json`          | Lista de tareas con estado (pending / in_progress / done) | Siempre, al empezar |
| `progress/current.md`        | Estado de la sesión actual                                | Siempre, al empezar |
| `progress/history.md`        | Bitácora append-only de sesiones anteriores               | Si necesitas contexto histórico |
| `docs/architecture.md`       | Qué significa "hacer un buen trabajo" en este proyecto    | Antes de implementar (después de context.md) |
| `docs/conventions.md`        | Reglas de estilo, nombres, estructura, y convención de Git| Antes de escribir código, y antes de cerrar sesión |
| `docs/verification.md`       | Cómo verificar que tu trabajo funciona (comandos de test) | Antes de declarar una tarea como `done` |
| `docs/context.md`            | Contexto del proyecto y decisiones tomadas                | Antes de implementar (antes de architecture.md) |
| `docs/database.md`           | Esquema de la BD y ajustes al migrarla                    | Antes de escribir migraciones o entidades |
| `docs/api-contract.md`       | Contratos/esquemas de los endpoints expuestos al frontend | Antes de cambiar la forma de un endpoint existente |
| `CHECKPOINT.md`              | Criterios objetivos de "estado final correcto"            | Para auto-evaluarte |
| `.claude/agents/`            | Definiciones de subagentes (leader, implementer, reviewer) | Si orquestas trabajo |
| `.agents/skills/`            | Skills de referencia técnica (ver §7)                     | Antes de implementar un módulo |
| `src/`                       | Código de la app: entry point, app factory, routers y capas de datos | Para implementar backend |
| `tests/`                     | Tests de integración (vitest + supertest)                  | Para verificar |
| `scripts/`                   | CLIs de operación (`create-user.js`, `seed-users.js`)      | Para crear usuarios en un entorno nuevo |
| `.env.example`               | Nombres y propósito de todas las variables de entorno      | Si tu tarea necesita configuración |

> **Stack:** Node.js 22 + JavaScript **ESM** (`"type": "module"`) + Express +
> PostgreSQL (`pg`), tests con **vitest** + supertest. **No hay TypeScript, ni
> NestJS, ni paso de build**: no existe `npm run build`, `tsc` ni `nest`.
> El código ya existe y está en producción (v1.3.0) — casi todo cambio es sobre
> módulos que ya tienen tests.
>
> **Repos hermanos:** `../maia-landing-front` (SPA que consume esta API) y
> `../maia-landing`. Consultables en solo lectura para entender el contrato;
> **nunca** los modifiques desde este repo.

## 3. Reglas duras (no negociables)

- **Una sola feature a la vez.** No mezcles cambios de varias tareas en la misma sesión.
- **No declares una tarea `done` sin pruebas verdes.** Ejecuta los tests y
  asegúrate de que el bloque pasa al 100%.
- **Documenta lo que haces** en `progress/current.md` mientras trabajas, no al final.
- **Deja el repositorio limpio** antes de cerrar la sesión (ver §5).
- **Si no sabes algo, busca en `docs/`** antes de inventarlo.
- **Nunca leas ni escribas valores de `.env` / `.env.local` ni ningún secreto o
  credencial.** Si tu tarea requiere una variable de entorno nueva, no la inventes:
  documenta el nombre y el propósito en `progress/current.md` y deja que un humano
  la agregue.
- **No modifiques el esquema de `maia_landing` sin revisar `docs/database.md`
  primero.** El DDL vive en `src/db.js` (`ensureSchema`), corre en cada arranque
  y por tanto **debe ser idempotente**. Toda migración queda documentada ahí, no
  solo en el código.
- **No rompas contratos de API existentes** sin actualizar `docs/api-contract.md`
  en el mismo cambio — el frontend depende de esa forma de datos.

## 4. Cómo elegir una tarea

```
1. Abre feature_list.json
2. Filtra por status == "pending"
3. Coge la de menor "id"
4. Cambia su status a "in_progress" y guarda
5. Anota en progress/current.md: feature, hora de inicio, plan breve
```

## 5. Cierre de sesión (lifecycle)

Antes de terminar:

1. Ejecuta los tests — todo verde.
2. Si la tarea está acabada: marca `status: "done"` en `feature_list.json`.
3. Mueve el resumen de `progress/current.md` al final de `progress/history.md`.
4. Vacía `progress/current.md` dejando solo la plantilla.
5. No dejes archivos temporales, ni `console.log()` de debug, ni TODOs sin contexto.
6. Sigue la convención de commits y branches de `docs/conventions.md` §12 — no
   commitees directo a `main`.

## 6. Si te bloqueas

```
1. Relee la sección relevante de docs/ para el problema puntual.
2. Si la herramienta no hace lo que esperas, NO inventes un workaround.
3. Documenta el bloqueo en progress/current.md: qué intentaste, qué esperabas,
   qué obtuviste.
4. Marca la feature bloqueada como status: "blocked" (no "in_progress") en
   feature_list.json, con una referencia al bloqueo documentado.
5. Revisa la siguiente tarea "pending" en feature_list.json:
   a. Si NO depende del mismo bloqueo → tómala y continúa la sesión normalmente.
   b. Si depende del mismo bloqueo → sigue bajando la lista.
   c. Si todas las tareas pending dependen del bloqueo → detén la sesión por
      completo y repórtalo explícitamente como bloqueo global, no como feature
      individual.
```

**Cuándo escalar a un humano** (más allá de bloqueos de herramientas):

- La tarea en `feature_list.json` es ambigua y admite más de una interpretación
  razonable de implementación.
- Resolverla implica una decisión de arquitectura no cubierta en `docs/architecture.md`.
- Implica un cambio de esquema en `maia_landing` no cubierto en `docs/database.md`.
- Requiere una credencial, variable de entorno o acceso que no tienes.

En cualquiera de estos casos, **no improvises una interpretación**: documenta la
ambigüedad en `progress/current.md` con las opciones que consideraste, y trata la
tarea como bloqueada (ver flujo de arriba).

---

## 7. Skills disponibles

Skills de referencia técnica **externa** en `.agents/skills/` (ver
`skills-lock.json` para origen y versión). Léelas bajo demanda y solo si el tema
aplica:

- `nodejs-backend-patterns/` — patrones de backend Node: middleware, manejo de
  errores, autenticación, integración con base de datos, diseño de API.
  Leer antes de tocar `app.js`, `auth.js` o cualquier router.
- `javascript-pro/` — JavaScript moderno: ES2023+, async/await y Promises,
  módulos ESM, APIs de Node. Leer ante dudas de lenguaje o de módulos.
  Referencias adicionales en `references/` (`async-patterns.md`, `modules.md`,
  `node-essentials.md`, `modern-syntax.md`, `browser-apis.md`).

> ⚠️ **Las convenciones de este repo mandan por encima de las skills.** Donde
> se contradigan, gana `docs/conventions.md`. En concreto, `javascript-pro`
> asume Jest con 85% de cobertura y un `eslint --fix` en su workflow: aquí los
> tests son **vitest** (`npm test`) y **no hay linter configurado**. Tampoco
> apliques sus recomendaciones de APIs de navegador: esto es solo servidor.

> En sesiones de Claude Code están disponibles vía la herramienta `Skill` con
> esos mismos nombres; `.claude/skills/` son symlinks a `.agents/skills/`.

**La referencia que sí manda siempre es `docs/`**, no las skills externas:
`architecture.md` (qué es un buen trabajo aquí), `conventions.md` (cómo se
escribe), `database.md` (cómo se toca el esquema), `api-contract.md` (qué no se
puede romper) y `verification.md` (cómo se comprueba).

Cada skill puede tener archivos de referencia adicionales en su subcarpeta `references/`.