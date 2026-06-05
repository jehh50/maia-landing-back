import { describe, it, expect } from 'vitest';
import { createMailer } from '../src/email.js';

function makeFakeTransporter(behavior = {}) {
  const sent = [];
  let call = 0;
  const fake = {
    sendMail: async (msg) => {
      call += 1;
      sent.push(msg);
      const override = behavior[`call${call}`] ?? behavior.default;
      if (override === 'throw') {
        const err = new Error('Invalid login: 535 Authentication failed');
        err.responseCode = 535;
        err.response     = '535 Authentication failed';
        throw err;
      }
      return {
        messageId: `<msg-${call}@test>`,
        response:  '250 OK',
        accepted:  [msg.to],
        rejected:  [],
      };
    },
    _sent: sent,
  };
  return fake;
}

describe('createMailer (Nodemailer / SMTP) — 2 correos (ventas + usuario)', () => {
  it('está deshabilitado si no hay SMTP_HOST', async () => {
    const m = createMailer({ host: '', from: 'a@b.com', to: 'c@d.com' });
    expect(m.enabled).toBe(false);
    expect(m.provider).toBe('nodemailer');
    const r = await m.sendLead({ email: 'x@y.com' }, 1);
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/SMTP_HOST/);
    expect(r.sentTo).toEqual([]);
    expect(r.messageIds).toEqual([]);
  });

  it('envía DOS correos cuando hay host y email del lead', async () => {
    const fake = makeFakeTransporter();
    const m = createMailer({
      host: 'smtp.test.com',
      port: 587,
      user: 'u', pass: 'p',
      from: 'noreply@maiabuilder.ai',
      to:   'maia@maiabuilder.ai',
      transporter: fake,
    });
    expect(m.enabled).toBe(true);

    const lead = {
      nombre: 'Ana Pérez', empresa: 'Acme', email: 'ana@acme.com',
      telefono: '+525512345678', industria: 'Tecnología / SaaS',
      pais: 'México', pais_iso: 'MX',
      mensaje: 'Quiero un demo', tipo: 'demo',
    };
    const res = await m.sendLead(lead, 42);

    // Resultado agregado
    expect(res.status).toBe('sent');
    expect(res.sentTo).toEqual(['maia@maiabuilder.ai', 'ana@acme.com']);
    expect(res.messageIds.length).toBe(2);
    expect(res.results.sales.status).toBe('sent');
    expect(res.results.user.status).toBe('sent');

    // Se invocó sendMail dos veces
    expect(fake._sent.length).toBe(2);

    const [salesMsg, userMsg] = fake._sent;

    // --- Sales ---
    expect(salesMsg.from).toBe('noreply@maiabuilder.ai');
    expect(salesMsg.to).toBe('maia@maiabuilder.ai');
    expect(salesMsg.replyTo).toBe('ana@acme.com');
    expect(salesMsg.subject).toContain('[MaIA Lead]');
    expect(salesMsg.subject).toContain('Ana');
    expect(salesMsg.subject).toContain('Acme');
    expect(salesMsg.text).toContain('ana@acme.com');
    expect(salesMsg.text).toContain('Quiero un demo');
    expect(salesMsg.text).toContain('ID en DB:');

    // --- User ---
    expect(userMsg.from).toBe('noreply@maiabuilder.ai');
    expect(userMsg.to).toBe('ana@acme.com');
    expect(userMsg.subject).toMatch(/MaIA/);
    expect(userMsg.subject.toLowerCase()).toMatch(/demo|confirm/);
    expect(userMsg.text.toLowerCase()).toContain('gracias');

    // Ambos correos llevan logos inline con CID (header + footer)
    for (const msg of fake._sent) {
      expect(Array.isArray(msg.attachments)).toBe(true);
      const cids = msg.attachments.map(a => a.cid);
      expect(cids).toContain('logo-maia');
      expect(cids).toContain('isotipo-maia');
      expect(msg.html).toContain('cid:logo-maia');
      expect(msg.html).toContain('cid:isotipo-maia');
    }
  });

  it('el correo a ventas incluye datos del lead (escapados)', async () => {
    const fake = makeFakeTransporter();
    const m = createMailer({
      host: 'smtp.test.com', from: 'a@b.com', to: 'ventas@maia.test', transporter: fake,
    });
    const lead = {
      nombre: 'Ana <"O">', empresa: 'Acme & Co', email: 'ana@acme.com',
      telefono: '+525512345678', industria: 'Tecnología & Salud',
      pais: 'México', pais_iso: 'MX',
      mensaje: 'Mucha & magia', tipo: 'demo',
    };
    await m.sendLead(lead, 7);

    const [salesMsg] = fake._sent;
    // Nombre escapado en HTML
    expect(salesMsg.html).toContain('Ana &lt;&quot;O&quot;&gt;');
    expect(salesMsg.html).not.toContain('<"O">');
    // Empresa, industria, país y comentarios presentes y escapados
    expect(salesMsg.html).toContain('Acme &amp; Co');
    expect(salesMsg.html).toContain('Tecnología &amp; Salud');
    expect(salesMsg.html).toContain('México');
    expect(salesMsg.html).toContain('MX');
    expect(salesMsg.html).toContain('Mucha &amp; magia');
    // Header + footer presentes
    expect(salesMsg.html).toContain('cid:logo-maia');
    expect(salesMsg.html).toContain('cid:isotipo-maia');
  });

  it('el correo al usuario NO incluye comentarios/industria del lead (es solo confirmación)', async () => {
    const fake = makeFakeTransporter();
    const m = createMailer({
      host: 'smtp.test.com', from: 'a@b.com', to: 'ventas@maia.test', transporter: fake,
    });
    const lead = {
      nombre: 'Ana', empresa: 'Acme SecretCorp', email: 'ana@acme.com',
      telefono: '+525512345678', industria: 'Finanzas-confidencial',
      pais: 'México', pais_iso: 'MX',
      mensaje: 'TopSecretProjectX-123', tipo: 'demo',
    };
    await m.sendLead(lead, 9);

    const [, userMsg] = fake._sent;
    // Datos privados del lead no deben aparecer en el correo al usuario
    expect(userMsg.html).not.toContain('TopSecretProjectX-123');
    expect(userMsg.html).not.toContain('Finanzas-confidencial');
    expect(userMsg.html).not.toContain('Acme SecretCorp');
    expect(userMsg.text).not.toContain('TopSecretProjectX-123');
    expect(userMsg.text).not.toContain('Finanzas-confidencial');
    // Pero sí saluda con el nombre
    expect(userMsg.html).toContain('Ana');
    expect(userMsg.text).toContain('Ana');
  });

  it('escapa HTML peligroso en el cuerpo del email (anti-XSS)', async () => {
    const fake = makeFakeTransporter();
    const m = createMailer({
      host: 'smtp.test.com', from: 'a@b.com', to: 'c@d.com', transporter: fake,
    });
    await m.sendLead({
      email: 'x@y.com',
      nombre: '<script>alert(1)</script>',
      mensaje: '<script>alert(2)</script>',
    }, 1);

    const [salesMsg, userMsg] = fake._sent;
    expect(salesMsg.html).not.toContain('<script>alert(1)</script>');
    expect(salesMsg.html).not.toContain('<script>alert(2)</script>');
    expect(salesMsg.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(salesMsg.html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');

    // El correo del usuario sólo refleja el nombre (primer token), también escapado.
    expect(userMsg.html).not.toContain('<script>');
    expect(userMsg.html).toContain('&lt;script&gt;');
  });

  it('status="partial" cuando el segundo envío falla', async () => {
    const fake = makeFakeTransporter({ call2: 'throw' });
    const m = createMailer({
      host: 'smtp.test.com', from: 'a@b.com', to: 'ventas@maia.test', transporter: fake,
    });
    const r = await m.sendLead({ nombre: 'Ana', email: 'ana@acme.com' }, 5);

    expect(r.status).toBe('partial');
    expect(r.results.sales.status).toBe('sent');
    expect(r.results.user.status).toBe('failed');
    expect(r.results.user.statusCode).toBe(535);
    expect(r.results.user.reason).toMatch(/Authentication failed/i);
    expect(r.sentTo).toEqual(['ventas@maia.test']);
    expect(r.messageIds.length).toBe(1);
  });

  it('status="partial" cuando el primer envío falla y el segundo no', async () => {
    const fake = makeFakeTransporter({ call1: 'throw' });
    const m = createMailer({
      host: 'smtp.test.com', from: 'a@b.com', to: 'ventas@maia.test', transporter: fake,
    });
    const r = await m.sendLead({ nombre: 'Ana', email: 'ana@acme.com' }, 6);

    expect(r.status).toBe('partial');
    expect(r.results.sales.status).toBe('failed');
    expect(r.results.user.status).toBe('sent');
    expect(r.sentTo).toEqual(['ana@acme.com']);
  });

  it('status="failed" cuando ambos envíos fallan', async () => {
    const fake = makeFakeTransporter({ default: 'throw' });
    const m = createMailer({
      host: 'smtp.test.com', from: 'a@b.com', to: 'c@d.com', transporter: fake,
    });
    const r = await m.sendLead({ email: 'x@y.com' }, 9);
    expect(r.status).toBe('failed');
    expect(r.results.sales.status).toBe('failed');
    expect(r.results.user.status).toBe('failed');
    expect(r.results.sales.statusCode).toBe(535);
    expect(r.results.user.statusCode).toBe(535);
    expect(r.sentTo).toEqual([]);
    expect(r.messageIds).toEqual([]);
  });

  it('SMTP_SECURE como string "true" lo interpreta como booleano', async () => {
    const fake = makeFakeTransporter();
    const m = createMailer({
      host: 'smtp.test.com',
      secure: 'true',
      from: 'a@b.com',
      to: 'c@d.com',
      transporter: fake,
    });
    expect(m.enabled).toBe(true);
    const r = await m.sendLead({ email: 'x@y.com', nombre: 'Tester' }, 1);
    expect(r.status).toBe('sent');
    expect(fake._sent.length).toBe(2);
    expect(fake._sent[0].to).toBe('c@d.com');
    expect(fake._sent[1].to).toBe('x@y.com');
  });
});
