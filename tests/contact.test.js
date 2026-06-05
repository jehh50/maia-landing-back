import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createPool, ensureSchema } from '../src/db.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres:///maia-landing?host=/var/run/postgresql';

const schema = `maia_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let app, pool;
const sentMails = [];
const fakeMailer = {
  enabled: true,
  async sendLead(lead, id) {
    sentMails.push({ lead, id });
    return { status: 'sent', messageId: `<fake-${id}@test>`, response: '250 OK', accepted: [lead.email], rejected: [] };
  },
};

const validPayload = {
  nombre: 'Ana Pérez',
  empresa: 'Acme',
  email: 'ana@acme.com',
  telefono: '+525512345678',
  industria: 'Tecnología / SaaS',
  mensaje: 'Quiero un demo',
  tipo: 'demo',
};

beforeAll(async () => {
  pool = createPool({ connectionString: TEST_DB_URL });
  await ensureSchema(pool, { schema });
  app = createApp({ pool, schema, mailer: fakeMailer, corsOrigin: '*' });
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

describe('POST /api/contact (demo flow)', () => {
  it('crea un lead con payload válido y devuelve id', async () => {
    const res = await request(app).post('/api/contact').send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.id).toBe('number');

    const { rows } = await pool.query(
      `SELECT email, empresa, telefono, pais, pais_iso, industria, mensaje, tipo FROM "${schema}".leads WHERE id = $1`,
      [res.body.id],
    );
    expect(rows[0].email).toBe('ana@acme.com');
    expect(rows[0].empresa).toBe('Acme');
    expect(rows[0].telefono).toBe('+525512345678');
    expect(rows[0].pais).toBe('México');
    expect(rows[0].pais_iso).toBe('MX');
    expect(rows[0].industria).toBe('Tecnología / SaaS');
    expect(rows[0].tipo).toBe('demo');

    expect(sentMails.length).toBe(1);
    expect(sentMails[0].lead.industria).toBe('Tecnología / SaaS');
    expect(sentMails[0].lead.pais).toBe('México');
    expect(sentMails[0].lead.pais_iso).toBe('MX');
  });

  it('decodifica país desde prefijo +58 (Venezuela)', async () => {
    const res = await request(app).post('/api/contact').send({
      ...validPayload, email: 've@test.com', telefono: '+584242848748',
    });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT pais, pais_iso FROM "${schema}".leads WHERE id = $1`,
      [res.body.id],
    );
    expect(rows[0].pais_iso).toBe('VE');
    expect(rows[0].pais).toBe('Venezuela');
  });

  it('pais queda vacío cuando el flow no exige teléfono (tipo=email)', async () => {
    const res = await request(app).post('/api/contact').send({
      email: 'noPhone@test.com', tipo: 'email',
    });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT pais, pais_iso, telefono FROM "${schema}".leads WHERE id = $1`,
      [res.body.id],
    );
    expect(rows[0].telefono).toBe('');
    expect(rows[0].pais).toBe('');
    expect(rows[0].pais_iso).toBe('');
  });

  it('normaliza el teléfono quitando espacios/guiones/paréntesis', async () => {
    const res = await request(app).post('/api/contact').send({
      ...validPayload, email: 'norm@test.com', telefono: '+1 (415) 555-7890',
    });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT telefono FROM "${schema}".leads WHERE id = $1`,
      [res.body.id],
    );
    expect(rows[0].telefono).toBe('+14155557890');
  });

  it('rechaza email inválido con 422', async () => {
    const res = await request(app).post('/api/contact').send({ ...validPayload, email: 'no-es-email' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/email/i);
    expect(res.body.field).toBe('email');
  });

  it('rechaza request sin email con 422', async () => {
    const res = await request(app).post('/api/contact').send({ ...validPayload, email: undefined });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('email');
  });

  it('rechaza sin nombre con 422 (demo flow)', async () => {
    const res = await request(app).post('/api/contact').send({ ...validPayload, nombre: '   ' });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('nombre');
  });

  it('rechaza teléfono inválido con 422 (demo flow)', async () => {
    const res = await request(app).post('/api/contact').send({ ...validPayload, telefono: '12345' });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('telefono');
  });

  it('rechaza teléfono ausente con 422 (demo flow)', async () => {
    const res = await request(app).post('/api/contact').send({ ...validPayload, telefono: '' });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('telefono');
  });

  it('industria es opcional — acepta string vacío', async () => {
    const res = await request(app).post('/api/contact').send({
      ...validPayload, email: 'no-ind@test.com', industria: '',
    });
    expect(res.status).toBe(201);
  });

  it('normaliza tipo a "demo" cuando es desconocido', async () => {
    const res = await request(app).post('/api/contact').send({ ...validPayload, email: 'b@b.com', tipo: 'pirata' });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT tipo FROM "${schema}".leads WHERE id = $1`,
      [res.body.id],
    );
    expect(rows[0].tipo).toBe('demo');
  });

  it('acepta tipo "contacto" y lo preserva', async () => {
    const res = await request(app).post('/api/contact').send({ ...validPayload, email: 'c@c.com', tipo: 'contacto' });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT tipo FROM "${schema}".leads WHERE id = $1`,
      [res.body.id],
    );
    expect(rows[0].tipo).toBe('contacto');
  });
});

describe('POST /api/contact (email-only flow — CTA final / ROI)', () => {
  it('acepta tipo="email" sin nombre ni teléfono', async () => {
    const res = await request(app).post('/api/contact').send({
      email: 'cta@test.com', tipo: 'email', mensaje: 'Empezar gratis',
    });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT tipo, nombre, telefono FROM "${schema}".leads WHERE id = $1`,
      [res.body.id],
    );
    expect(rows[0].tipo).toBe('email');
    expect(rows[0].nombre).toBe('');
    expect(rows[0].telefono).toBe('');
  });

  it('rechaza tipo="email" con email inválido (422)', async () => {
    const res = await request(app).post('/api/contact').send({ email: 'no-es-email', tipo: 'email' });
    expect(res.status).toBe(422);
  });
});

describe('persistencia', () => {
  it('persiste created_at como TIMESTAMPTZ reciente', async () => {
    const before = new Date();
    const res = await request(app).post('/api/contact').send({ ...validPayload, email: 'time@test.com' });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT created_at FROM "${schema}".leads WHERE id = $1`,
      [res.body.id],
    );
    const createdAt = new Date(rows[0].created_at);
    expect(createdAt instanceof Date && !Number.isNaN(+createdAt)).toBe(true);
    expect(+createdAt).toBeGreaterThanOrEqual(+before - 1000);
    expect(+createdAt).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('GET /api/health', () => {
  it('responde con ok:true y db:true', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.db).toBe(true);
  });
});

describe('Método no permitido', () => {
  it('GET /api/contact responde 404', async () => {
    const res = await request(app).get('/api/contact');
    expect(res.status).toBe(404);
  });
});
