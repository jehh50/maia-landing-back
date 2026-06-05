// Dev-only: sirve la build de Vite (client/dist) + API en el mismo puerto.
// Útil para probar la app construida sin reverse-proxy.
// Para hot-reload durante desarrollo usa `npm run dev` en /client (Vite con proxy /api).
import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createApp } from './src/app.js';
import { ensureSchema } from './src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const CLIENT_DIST = resolve(REPO, 'client', 'dist');

const api = createApp();
await ensureSchema(api._pool, { schema: api._schema });
console.log(`Schema "${api._schema}" listo.`);

const root = express();

// Sirve la SPA si existe el build; si no, cae a la versión legacy.
if (existsSync(CLIENT_DIST)) {
  console.log(`Sirviendo SPA desde ${CLIENT_DIST}`);
  root.use(express.static(CLIENT_DIST));
  // Fallback SPA: cualquier GET no manejado por la API ni static → index.html
  root.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(resolve(CLIENT_DIST, 'index.html'));
  });
} else {
  console.log(`SPA no encontrada (corre \`cd ../client && npm run build\`). Sirviendo legacy.html`);
  root.use(express.static(REPO, { index: 'legacy.html', extensions: ['html'] }));
}

root.use(api);

const port = Number(process.env.PORT) || 3001;
root.listen(port, () => {
  console.log(`\n  ▶ Landing: http://localhost:${port}/\n  ▶ API health: http://localhost:${port}/api/health\n`);
});
