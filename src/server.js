import 'dotenv/config';
import { createApp } from './app.js';
import { ensureSchema } from './db.js';

// Validación temprana de variables críticas
const missing = ['DATABASE_URL', 'AUTH_SECRET'].filter(k => !process.env[k]?.trim());
if (missing.length) {
  console.error(`[startup] Variables de entorno requeridas no configuradas: ${missing.join(', ')}`);
  console.error('[startup] Configúralas en el dashboard de Render antes de reintentar.');
  process.exit(1);
}

const app    = createApp();
const port   = Number(process.env.PORT) || 3001;
const schema = app._schema;

try {
  await ensureSchema(app._pool, { schema });
  console.log(`[startup] Schema "${schema}" listo.`);
} catch (err) {
  const detail = err?.message || err?.code || err?.toString() || '(sin detalle)';
  console.error(`[startup] No se pudo inicializar el esquema: ${detail}`);
  if (err?.code) console.error(`[startup] PG error code: ${err.code}`);
  process.exit(1);
}

app.listen(port, () => {
  console.log(`[startup] MaIA API escuchando en http://localhost:${port}`);
});
