# Review — feature 5: Refresh / renovación de sesión

**Veredicto:** APPROVED
**Tests:** `npm test` → 9 suites / 117 tests (verde). Baseline previo 9 suites/110 tests + 7 nuevos en `tests/auth.test.js` (describe `"Renovación de sesión (feature 5)"`) = 117. Corrida por mí mismo:

```
Test Files  9 passed (9)
     Tests  117 passed (117)
```

## Contexto del diff

El repo no tiene nada commiteado; `git diff` sobre `src/auth.js`, `src/app.js`,
`src/articlesRouter.js`, `src/leadsRouter.js`, `.gitignore`, `README.md` mezcla
trabajo de las features 2 (`asyncHandler`/`errorHandler`) y 3 (rate limit), ya
aprobadas (`progress/review_2.md`, `progress/review_3.md`) y cerradas hoy
(2026-07-27), con el trabajo de la feature 5. Ignorado ese ruido según
indicación explícita de la tarea. `progress/current.md` reporta como tocados
por la feature 5: `src/auth.js`, `tests/auth.test.js`, `.env.example`,
`docs/architecture.md`; también se tocó `docs/api-contract.md` (mencionado en
el plan y verificado en el contenido, aunque no aparece en la tabla "Archivos
tocados" — hallazgo menor, ver abajo). No hay discrepancia real entre lo
reportado y lo que aporta la feature 5 al diff de `src/auth.js`/`tests/auth.test.js`.

## Acceptance (feature 5, `feature_list.json`)

1. **"Una request autenticada con token a punto de expirar re-emite la cookie
   con nueva expiración"** → `tests/auth.test.js:181` `it('token a punto de
   expirar (dentro de la ventana) re-emite la cookie con nueva expiración')`.
   Cubierto: verifica `Set-Cookie`, `HttpOnly`, `Path=/`, y que el nuevo token
   decodificado tiene `exp` mayor que el original.
2. **"La ventana de renovación es configurable y está documentada"** →
   `tests/auth.test.js:229` `it('la ventana de renovación es configurable
   (equivalente a AUTH_REFRESH_WINDOW_MS)')` (compara `refreshWindowMs: 100_000`
   vs `250_000` con el mismo reloj inyectado). Documentada en
   `.env.example` (`AUTH_REFRESH_WINDOW_MS=86400000` con comentario) y en
   `docs/architecture.md` §8 y §12.
3. **"Un token ya expirado sigue devolviendo 401 (no se renueva lo caducado)"**
   → `tests/auth.test.js:206` `it('un token ya expirado sigue devolviendo 401
   y nunca se renueva')`. Verifica `res.status === 401` y ausencia de
   `Set-Cookie`.
4. **"El rol se sigue recargando desde DB en cada request"** →
   `tests/auth.test.js:245` `it('el rol se sigue recargando desde DB en cada
   request (invariante I5) aunque la cookie se renueve')`. Promueve el rol en
   DB sin volver a hacer login y comprueba que la respuesta ya lo refleja.

Los 4 criterios están cubiertos.

## Puntos de ataque de la consigna

1. **I6 — cookie renovada con las mismas opciones, y probado en modo
   producción.** Verificado a nivel de código: `cookieOpts` se construye una
   sola vez en `createAuthRouter` (`src/auth.js:75`,
   `cookieOptions({ secure: cookieSecure ?? process.env.NODE_ENV === 'production' })`)
   y tanto `POST /api/auth/login` (`src/auth.js:172`,
   `res.cookie(COOKIE_NAME, token, cookieOpts)`) como
   `renewCookieIfNeeded` (`src/auth.js:117`,
   `res.cookie(COOKIE_NAME, freshToken, cookieOpts)`) usan **literalmente el
   mismo objeto** — no hay una segunda llamada a `cookieOptions()` en la
   renovación. El test `tests/auth.test.js:296`
   `it('la cookie renovada conserva exactamente
   httpOnly/sameSite/secure/path que la original (invariante I6)')` invoca
   `buildAuthOnlyApp({ ..., cookieSecure: true })` — es decir, simula
   explícitamente el modo producción (`cookieSecure: true` fuerza
   `sameSite: 'none'`, `secure: true` independientemente del `NODE_ENV` real
   del proceso de test) y comprueba `HttpOnly`, `SameSite=None`, `Secure` y
   `Path=/` en la cookie **renovada**. No se apoya en el `NODE_ENV` por
   defecto de desarrollo. Cubierto correctamente.
2. **Token expirado nunca renueva.** `verifyToken` (`src/auth.js:85`) envuelve
   `jwt.verify` en try/catch y devuelve `null` ante `TokenExpiredError`;
   `loadSession` (`src/auth.js:93-105`) corta ahí (`if (!payload?.sub) return
   { user: null, payload: null }`), por lo que `requireAuth`/`me` responden
   401 sin llegar nunca a `renewCookieIfNeeded`. Hay además un guard
   defensivo redundante (`remainingMs <= 0`) dentro de `renewCookieIfNeeded`
   que es inalcanzable en el flujo normal, documentado como tal en el
   comentario — no es un problema, es cinturón y tirantes. Test:
   `tests/auth.test.js:206` (ver arriba), sin `Set-Cookie`.
3. **No renovar fuera de la ventana.** `renewCookieIfNeeded` (`src/auth.js:117-123`)
   corta con `remainingMs > resolvedRefreshWindowMs`. Test:
   `tests/auth.test.js:195` `it('token lejos de expirar (fuera de la ventana)
   NO re-emite la cookie — no se renueva en cada request')`: token con 1h de
   vida real, reloj inyectado a 30 min restantes, ventana 60s → sin
   `Set-Cookie`. Cubierto.
4. **I5 intacta tras la refactorización `loadUserFromCookie` →
   `loadSession`.** `loadSession` sigue haciendo el mismo
   `SELECT id, email, name, role, created_at FROM "${schema}".users WHERE id
   = $1` (parametrizado) en cada llamada, sin caché — el único cambio es que
   ahora también devuelve el `payload` decodificado junto al `user`. Ni
   `requireAuth` ni `/me` cachean el resultado entre requests. Confirmado
   además por el test dedicado del punto 4 del acceptance
   (`tests/auth.test.js:245`), que promueve el rol en DB sin reautenticar y
   comprueba que la respuesta ya lo refleja **incluso cuando la cookie se
   renueva en la misma request** (reloj dentro de la ventana), que es
   justamente el caso donde una regresión sería más fácil de introducir
   (p. ej. usar el rol del payload viejo).
5. **Sin esperas reales.** Grep de `setTimeout` en `tests/auth.test.js`: cero
   resultados. El reloj de decisión (`now`) es 100% inyectado
   (`fakeNow = () => expSeconds * 1000 - N`); el único uso de `Date.now()`
   real es para craftar el `exp` del token (necesario porque `jwt.verify`
   usa el reloj real del sistema, no es inyectable — documentado
   explícitamente en el comentario de `signRaw` en el test). No hay
   dependencia del paso real del tiempo en ningún test.
6. **Tests preexistentes no modificados.** `git diff -- tests/auth.test.js`
   muestra que el único cambio a código preexistente es en el bloque de
   imports (añade `jwt`, `express`, `cookie-parser`, `createAuthRouter` a la
   importación ya existente de `AUTH_COOKIE_NAME`); todo lo demás es
   estrictamente **añadido** al final del archivo (`describe('Renovación de
   sesión (feature 5)')`). Ningún `it()` preexistente fue tocado ni su
   aserción alterada.
7. **`logout` no dispara renovación.** El handler de
   `POST /api/auth/logout` (`src/auth.js:174-177`) no cambió: sigue sin
   llamar a `loadSession`/`renewCookieIfNeeded`, solo `res.clearCookie(...)`.
   Test explícito: `tests/auth.test.js:279`
   `it('POST /api/auth/logout no dispara renovación (nunca re-emite
   maia_session con expiración nueva)')`, que verifica que el único
   `Set-Cookie` es el de borrado (`Expires=`/`Max-Age=0`/valor vacío), no una
   renovación.

## Checkpoints

- C1 Tests verdes: [x] — 9 suites / 117 tests, verificado por mí (`npm test`), ningún test eliminado ni `skip`.
- C2 Cobertura del acceptance: [x] — los 4 criterios, ver arriba con archivo + `it()`.
- C3 Factories con DI: [x] — `createAuthRouter` sigue sin leer `process.env` fuera de funciones internas (`positiveNumberFromEnv`, `resolveSecret` se invocan dentro del cuerpo de la factory, no a nivel de módulo); nuevas opciones `refreshWindowMs`/`now` van con default en la firma, consistente con el patrón existente.
- C4 SQL seguro: [x] — `loadSession` (`src/auth.js:99-102`) sigue parametrizando `$1`; sin SQL nuevo añadido por esta feature.
- C5 Contrato de API: [x] — `docs/api-contract.md:113-123` documenta el nuevo `Set-Cookie` en `/api/auth/me` y `/api/admin/*`, la condición (`AUTH_REFRESH_WINDOW_MS`) y que las opciones de la cookie no cambian.
- C6 Sin secretos: [x] — `AUTH_REFRESH_WINDOW_MS` documentada solo por nombre/default (no es secreto, mismo criterio ya usado para las vars de rate limit de la feature 3); no se leyó ni escribió ningún valor real de `.env`.
- C7 Separación de capas: [x] — no aplica cambio de capa; `auth.js` sigue siendo el único que toca `pool`/HTTP para auth (patrón preexistente, no alterado por esta feature).
- C8 Errores manejados: [x] — `renewCookieIfNeeded` se invoca dentro del `try/catch` ya existente de `requireAuth`/`me`; sin nuevo `await` fuera de try/catch.
- C9 DDL idempotente: [x] — no aplica, sin cambios de esquema.
- C10 Escape HTML en correo: [x] — no aplica.
- C11 Limpieza: [x] — sin `console.log` de debug (solo `console.warn`/`console.error` preexistentes con prefijo `[auth]`), sin TODOs, sin archivos temporales nuevos.
- C12 Alcance: [x] — el contenido propio de la feature 5 dentro de `src/auth.js`/`tests/auth.test.js` está acotado a la renovación de sesión; el resto del diff de `src/auth.js` (asyncHandler, rateLimiter) pertenece a features 2/3 ya aprobadas, según instrucción explícita de esta review.
- C13 Trazabilidad: [~] — `progress/current.md` describe fielmente el trabajo, pero la tabla "Archivos tocados" omite `docs/api-contract.md` (sí mencionado en el plan y sí modificado realmente). Hallazgo menor, no bloqueante.
- C14 Estado coherente: [x] — `feature_list.json` feature 5 en `status: "in_progress"`, no se marcó `done` (correcto, eso corresponde al implementer tras este APPROVED).
- C15 Git: ignorado por indicación explícita de la tarea (nada commiteado).

## Invariantes del sistema

- I1: [x] — no tocado por esta feature.
- I2: [x] — no tocado por esta feature.
- I3: [x] — `publicUser()` sin cambios, sigue sin exponer `password_hash`.
- I4: [x] — no tocado por esta feature.
- I5: [x] — `loadSession` sigue recargando desde DB en cada request; ver ataque #4 arriba y test dedicado.
- I6: [x] — cookie renovada reutiliza literalmente `cookieOpts`; test cubre el caso `cookieSecure: true` (producción). Ver ataque #1 arriba.

## Bloqueantes

Ninguno.

## Menores (no bloquean)

1. `progress/current.md` — la tabla "Archivos tocados" (líneas 24-31) no lista
   `docs/api-contract.md`, aunque sí fue modificado y el plan (línea 20-21) lo
   menciona. Corregir la tabla para trazabilidad completa la próxima vez.
2. `renewCookieIfNeeded` (`src/auth.js:117-123`) tiene un guard
   `remainingMs <= 0` que el propio comentario reconoce como inalcanzable en
   el flujo normal (un token expirado nunca llega ahí porque `verifyToken` ya
   lo filtra antes). No es incorrecto, pero es código defensivo sin test que
   lo ejercite directamente (los tests lo cubren indirectamente vía el 401 en
   `loadSession`). Aceptable, solo lo señalo para que quede constancia.
