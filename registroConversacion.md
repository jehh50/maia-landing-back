Lancé el leader en modo análisis (sin permiso para implementar ni marcar nada). Le pedí que no se quede en feature_list.json: la deuda real de hoy está dispersa en las secciones "Menores" de los cinco veredictos de review y en el §14 de architecture.md, y nadie la ha convertido en features.

También le pedí explícitamente que diga si la conclusión es no hacer nada más — para una landing con un formulario y un panel pequeño en el plan free de Render, un backlog inflado sería el peor resultado de este análisis.

✻ Cooked for 42s

● Agent "Analiza el backlog" finished · 5m 13s

  Searched for 1 pattern, read 1 file

El análisis está en progress/analisis_backlog.md. He verificado los puntos sustantivos contra el código.

El hallazgo principal no es una feature

Nada de lo trabajado se ha commiteado. main y origin/main están idénticos en 13f5ab5. Las cinco features aprobadas existen solo como cambios sin commitear en este disco.

Dos consecuencias que yo no había subrayado lo suficiente al cerrar la feature 1: el repo público de GitHub sigue teniendo .env trackeado ahora mismo — el git rm --cached solo tocó el índice local, así que el problema que esa feature dice resolver sigue íntegro en el repo real. Y si este entorno se pierde, se pierde el trabajo de las cinco features. El leader recomienda resolver esto antes de abrir nada nuevo, y estoy de acuerdo.

Backlog: cerrado de verdad

Cruzó cada nota de cierre contra el código y no encontró ninguna que prometa más de lo que hay. Lo verifiqué por encima y coincide.

Dos candidatas, no más

A — Fail-fast si CORS_ORIGIN queda en * en producción (alta). Confirmé el código: src/app.js:75 cae a '*' por defecto y la línea 105 lo convierte en origin: true, que refleja cualquier Origin, combinado con credentials: true. render.yaml:19-20 marca la variable como sync: false (se pone a mano en el dashboard) y src/server.js:6 solo valida DATABASE_URL y AUTH_SECRET. Si alguien despliega y olvida configurarla, no falla ni deja rastro en logs: cualquier web podría hacer peticiones autenticadas a /api/admin/* con la cookie de un admin logueado. Es un archivo de cambio y extiende la validación de arranque que ya existe.

B — JSON malformado debería dar 400, no 500 (media). La deuda que dejamos anotada dos veces hoy sin convertirla en feature.

Y descartó explícitamente seis ideas por desproporcionadas para el tamaño del proyecto: CSRF, Redis, un migrador formal, APM, linter/CI, y un test para el guard defensivo de la feature 5. Esa lista de descartes me parece tan valiosa como las propuestas.

Riesgo que no había en el radar

Si CORS_ORIGIN está o no configurada hoy en tu dashboard de Render no es verificable desde el repo. Si está en el default, la exposición del panel admin es real ahora, no hipotética. Merece que lo mires antes que nada — junto con la rotación de credenciales, que sigue pendiente.

Detalles menores

docs/architecture.md:57 y CHECKPOINT.md:9 siguen diciendo "7 suites (86 tests)" cuando son 10 y 117; docs/context.md §5 describe como pendientes tres features que cerramos hoy. Son incoherencias de documentación, sin impacto.

¿Quieres que arregle esas tres líneas desfasadas y añada las candidatas A y B al backlog, o prefieres resolver primero lo de los commits?