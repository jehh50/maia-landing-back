import 'dotenv/config';
import { createApp } from './app.js';
import { ensureSchema } from './db.js';

const app  = createApp();
const port = Number(process.env.PORT) || 3001;
const schema = app._schema;

try {
  await ensureSchema(app._pool, { schema });
  console.log(`Schema "${schema}" listo (tabla leads + índices).`);
} catch (err) {
  console.error('No se pudo inicializar el esquema:', err.message);
  process.exit(1);
}

app.listen(port, () => {
  console.log(`MaIA landing API listening on http://localhost:${port}`);
});
