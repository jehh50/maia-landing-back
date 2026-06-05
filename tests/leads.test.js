import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createPool, ensureSchema } from '../src/db.js';
import { createUser } from '../src/users.js';
import { AUTH_COOKIE_NAME } from '../src/auth.js';
import { listLeads, getLeadById } from '../src/leads.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres:///maia-landing?host=/var/run/postgresql';

const schema = `maia_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const fakeMailer = { enabled: false, to: 'sales@test', async sendLead() { return { status: 'skipped' }; } };

let app, pool, editorCookie;

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.find(c => c.startsWith(`${AUTH_COOKIE_NAME}=`));
}

async function seedLead(values) {
  await pool.query(
    `INSERT INTO "${schema}".leads (nombre, empresa, email, telefono, pais, pais_iso, industria, mensaje, tipo, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW() - ($10 || ' minutes')::interval)`,
    [
      values.nombre, values.empresa, values.email, values.telefono,
      values.pais ?? '', values.pais_iso ?? '', values.industria ?? '',
      values.mensaje ?? '', values.tipo ?? 'demo',
      String(values.ageMinutes ?? 0),
    ],
  );
}

beforeAll(async () => {
  pool = createPool({ connectionString: TEST_DB_URL });
  await ensureSchema(pool, { schema });

  await createUser(pool, { email: 'editor@test', password: 'pass-1', name: 'Editor' }, { schema });

  await seedLead({ nombre: 'Ana',    email: 'ana@acme.com',     empresa: 'Acme',   pais: 'México',    pais_iso: 'MX', tipo: 'demo',     ageMinutes: 10 });
  await seedLead({ nombre: 'Bruno',  email: 'bruno@nexio.com',  empresa: 'Nexio',  pais: 'Venezuela', pais_iso: 'VE', tipo: 'demo',     ageMinutes: 20 });
  await seedLead({ nombre: 'Carla',  email: 'carla@xyz.com',    empresa: 'XYZ',    pais: 'México',    pais_iso: 'MX', tipo: 'contacto', ageMinutes: 30 });
  await seedLead({ nombre: '',       email: 'cta@test.com',     empresa: '',       pais: '',          pais_iso: '',   tipo: 'email',    ageMinutes: 40 });

  app = createApp({ pool, schema, mailer: fakeMailer, corsOrigin: '*', authSecret: 'test-secret-leads' });
  editorCookie = await loginAs('editor@test', 'pass-1');
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

describe('listLeads (helper puro)', () => {
  it('devuelve todos por defecto, orden created_at DESC', async () => {
    const { rows, total } = await listLeads(pool, schema, {});
    expect(total).toBe(4);
    expect(rows.length).toBe(4);
    expect(rows[0].nombre).toBe('Ana');  // el más reciente
  });

  it('filtra por tipo', async () => {
    const { rows, total } = await listLeads(pool, schema, { tipo: 'email' });
    expect(total).toBe(1);
    expect(rows[0].email).toBe('cta@test.com');
  });

  it('filtra por pais_iso', async () => {
    const { rows, total } = await listLeads(pool, schema, { pais_iso: 'MX' });
    expect(total).toBe(2);
    expect(rows.every(r => r.pais_iso === 'MX')).toBe(true);
  });

  it('filtra por q (ILIKE en nombre/email/empresa)', async () => {
    const a = await listLeads(pool, schema, { q: 'ana' });
    expect(a.total).toBe(1);
    expect(a.rows[0].nombre).toBe('Ana');
    const b = await listLeads(pool, schema, { q: 'NEXIO' });
    expect(b.total).toBe(1);
    expect(b.rows[0].empresa).toBe('Nexio');
  });

  it('limit clampa a 200', async () => {
    const r = await listLeads(pool, schema, { limit: 500 });
    expect(r.limit).toBe(200);
  });

  it('paginación: limit=2 offset=0 y offset=2 devuelven distintos', async () => {
    const p1 = await listLeads(pool, schema, { limit: 2, offset: 0 });
    const p2 = await listLeads(pool, schema, { limit: 2, offset: 2 });
    expect(p1.rows.length).toBe(2);
    expect(p2.rows.length).toBe(2);
    expect(p1.rows[0].id).not.toBe(p2.rows[0].id);
  });
});

describe('GET /api/admin/leads', () => {
  it('401 sin cookie', async () => {
    const res = await request(app).get('/api/admin/leads');
    expect(res.status).toBe(401);
  });

  it('200 con cookie editor; rows y total correctos', async () => {
    const res = await request(app).get('/api/admin/leads').set('Cookie', editorCookie);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.rows.length).toBe(4);
  });

  it('filtra por tipo via query string', async () => {
    const res = await request(app).get('/api/admin/leads?tipo=email').set('Cookie', editorCookie);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].tipo).toBe('email');
  });

  it('filtra por pais_iso=MX', async () => {
    const res = await request(app).get('/api/admin/leads?pais_iso=MX').set('Cookie', editorCookie);
    expect(res.body.total).toBe(2);
  });

  it('q parámetro funciona', async () => {
    const res = await request(app).get('/api/admin/leads?q=carla').set('Cookie', editorCookie);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].nombre).toBe('Carla');
  });
});

describe('GET /api/admin/leads/:id', () => {
  it('200 con datos completos', async () => {
    const list = await listLeads(pool, schema, { q: 'Ana' });
    const id = list.rows[0].id;
    const res = await request(app).get(`/api/admin/leads/${id}`).set('Cookie', editorCookie);
    expect(res.status).toBe(200);
    expect(res.body.lead.nombre).toBe('Ana');
    expect(res.body.lead.pais).toBe('México');
  });

  it('404 si no existe', async () => {
    const res = await request(app).get('/api/admin/leads/9999999').set('Cookie', editorCookie);
    expect(res.status).toBe(404);
  });

  it('helper getLeadById devuelve null si no existe', async () => {
    expect(await getLeadById(pool, schema, 9999999)).toBeNull();
  });
});
