# Sesión actual

> Plantilla. Rellénala **mientras** trabajas, no al final. Al cerrar sesión,
> mueve el bloque al final de `progress/history.md` y deja este archivo con la
> plantilla vacía.

**Feature en curso:** — (ninguna)
**Estado:** idle · in_progress · blocked
**Inicio:** —

## Plan

- [ ] …

## Archivos tocados

| Archivo | Qué cambió |
|---|---|
| — | — |

## Decisiones tomadas

—

## Bloqueos

—

## Variables de entorno nuevas

> Solo **nombre y propósito**. Nunca valores.

—

## Verificación

```
npm test  → (pegar el resumen: Test Files / Tests)
```

---

## ⚠️ DEUDA ABIERTA MÁS IMPORTANTE DEL REPO — rotación de credenciales pendiente

> No borrar esta sección al vaciar la plantilla de arriba. Se queda aquí,
> visible, hasta que un humano confirme que rotó las credenciales de abajo.
> Detalle completo en `progress/history.md` (entrada "2026-07-28 — feature 1")
> y en `feature_list.json` (`done`, id 1).

El repo `maia-landing-back` es **público** en GitHub. `.env` estuvo trackeado
en git desde antes de que existiera la regla de `.gitignore` (feature 1,
cerrada 2026-07-28: `git rm --cached .env` sacó el archivo del **índice**,
pero eso **no cierra la exposición**). Sus valores han sido legibles por
cualquiera y **siguen intactos en el historial de commits** — sacarlo del
índice no los borra ni los invalida, solo detiene que se sigan añadiendo
cambios futuros de `.env` a git.

**Pendiente, solo lo puede hacer un humano:**

1. **Rotar** (nombre de variable, nunca su valor — ningún agente los ha leído):
   - `DATABASE_URL`
   - `SMTP_PASS`
   - `SMTP_USER`
   - `AUTH_SECRET`
   - `MAIA_ADMIN_PASSWORD`
2. Actualizar los valores rotados en las variables de entorno de Render.
3. Opcional: purgar el historial de git (`git filter-repo` / BFG) si se
   quiere eliminar también el rastro, no solo invalidar las credenciales.

Mientras esto no se haga, **la exposición sigue activa** aunque `.env` ya no
esté trackeado en el índice de git.
