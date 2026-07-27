import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Logos compartidos por ambos correos. Se adjuntan como CID inline para que
// Outlook/Gmail/Apple Mail los muestren sin permitir descargar imágenes externas.
const ASSETS_DIR = path.resolve(__dirname, '../docs/images');
const LOGO_CID = 'logo-maia';
const ISOTIPO_CID = 'isotipo-maia';

const MIME_BY_EXT = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
};

// Gmail y Outlook no renderizan SVG en correo (Apple Mail sí). Si algún día se
// añade un PNG junto al SVG, se prefiere automáticamente sin tocar código.
const EXT_PREFERENCE = ['.png', '.jpg', '.jpeg', '.gif', '.svg'];

/**
 * Lee un logo de `docs/images` una sola vez al importar el módulo. Devuelve
 * `null` si no se encuentra: el correo debe salir igual aunque falte el asset
 * (un lead sin notificar es peor que un correo sin logo).
 */
function loadLogo(basename, cid) {
  for (const ext of EXT_PREFERENCE) {
    const filename = basename + ext;
    try {
      return { filename, content: readFileSync(path.join(ASSETS_DIR, filename)), contentType: MIME_BY_EXT[ext], cid };
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.warn(`[mail] no se pudo leer ${filename}: ${err?.message}`);
      }
    }
  }
  console.warn(`[mail] logo "${basename}" no encontrado en ${ASSETS_DIR} — los correos saldrán sin él.`);
  return null;
}

const LOGOS = [loadLogo('logo-maia', LOGO_CID), loadLogo('isotipo-maia', ISOTIPO_CID)].filter(Boolean);
const HAS_LOGO    = LOGOS.some(l => l.cid === LOGO_CID);
const HAS_ISOTIPO = LOGOS.some(l => l.cid === ISOTIPO_CID);

// ---------- Helpers ----------

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return false;
}

// Formato nodemailer: `content` (Buffer) + `cid` + `contentType`.
function buildLogoAttachments() {
  return LOGOS.map(({ filename, content, contentType, cid }) => ({ filename, content, contentType, cid }));
}

// Formato Resend: `content` en base64 y `contentId` para el inline (camelCase).
// `path` en Resend es una URL pública, no una ruta de filesystem.
function toResendAttachments(attachments) {
  return attachments.map(a => ({
    filename:    a.filename,
    content:     a.content.toString('base64'),
    contentType: a.contentType,
    contentId:   a.cid,
  }));
}

// ---------- Asunto (ventas) y asunto (usuario) ----------

function buildSalesSubject(lead) {
  return `[MaIA Lead] ${lead.nombre || lead.email}${lead.empresa ? ` – ${lead.empresa}` : ''}`;
}

function buildUserSubject() {
  return 'Confirmamos tu solicitud de demo — MaIA';
}

// ---------- Versión texto plano ----------

function buildSalesText(lead, id) {
  const pais = lead.pais ? `${lead.pais}${lead.pais_iso ? ` (${lead.pais_iso})` : ''}` : '';
  return [
    'Nuevo lead recibido desde la landing page.',
    '',
    `Nombre:      ${lead.nombre || ''}`,
    `Empresa:     ${lead.empresa || ''}`,
    `Industria:   ${lead.industria || ''}`,
    `Email:       ${lead.email}`,
    `Teléfono:    ${lead.telefono || ''}`,
    `País:        ${pais}`,
    `Comentarios:`,
    lead.mensaje || '',
    '',
    `Tipo:        ${lead.tipo || 'demo'}`,
    `ID en DB:    ${id}`,
  ].join('\n');
}

function buildUserText(lead) {
  const nombre = lead.nombre ? lead.nombre.split(' ')[0] : '';
  const saludo = nombre ? `Hola ${nombre},` : 'Hola,';
  return [
    saludo,
    '',
    'Gracias por agendar una demo con MaIA. Recibimos tu solicitud y un',
    'miembro de nuestro equipo se pondrá en contacto contigo en menos de 24 horas',
    'para coordinar la sesión.',
    '',
    'Mientras tanto, si tienes preguntas puedes responder este correo o',
    'escribirnos a maia@maiabuilder.ai.',
    '',
    'Saludos,',
    'El equipo de MaIA',
    'https://app.maiabuilder.ai',
  ].join('\n');
}

// ---------- Plantillas HTML compartidas ----------
//
// Reglas (design-system §10):
// - <table> con width="600" centrada, sin flex/grid.
// - font-family con fallback `Arial, sans-serif`.
// - Sin box-shadow. Bordes finos.
// - Colores en hex completo (#FFFFFF, no #fff).
// - Header `#E8440A` con logo blanco. Body card con borde `#F0EBE8`.
// - Footer `#FAFAF9` con isotipo + texto muted `#A89E9A`.
// - TODOS los strings de usuario pasan por escapeHtml().

function htmlShell({ title, previewText, bodyHtml }) {
  const preview = escapeHtml(previewText || '');
  const safeTitle = escapeHtml(title || 'MaIA');

  // Si el asset no está disponible, se cae a wordmark de texto en vez de dejar
  // el icono de imagen rota que mostraría un `cid:` sin adjunto.
  const logoHtml = HAS_LOGO
    ? `<img src="cid:${LOGO_CID}" alt="MaIA" width="140" height="36" style="display:block;border:0;outline:none;text-decoration:none;height:36px;width:140px;" />`
    : `<span style="font-family:'Inter',Arial,sans-serif;font-size:26px;font-weight:700;letter-spacing:-0.02em;color:#1A1410;">MaIA</span>`;

  const isotipoHtml = HAS_ISOTIPO
    ? `<img src="cid:${ISOTIPO_CID}" alt="MaIA" width="32" height="32" style="display:block;border:0;outline:none;text-decoration:none;margin:0 auto 8px auto;height:32px;width:32px;" />`
    : '';

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background:#FAFAF9;font-family:'Inter',Arial,sans-serif;color:#1A1410;-webkit-font-smoothing:antialiased;">
  <div style="display:none;font-size:1px;color:#FAFAF9;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preview}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAFAF9;">
    <tr>
      <td align="center" style="padding:24px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#FFFFFF;border:1px solid #F0EBE8;border-radius:12px;overflow:hidden;">
          <!-- HEADER -->
          <tr>
            <td align="center" style="background:#FAFAF9;padding:28px 24px;border-bottom:1px solid #F0EBE8;">
              ${logoHtml}
            </td>
          </tr>
          <!-- BODY -->
          <tr>
            <td style="padding:32px 32px 24px 32px;color:#1A1410;font-family:'Inter',Arial,sans-serif;font-size:15px;line-height:1.6;">
              ${bodyHtml}
            </td>
          </tr>
          <!-- FOOTER -->
          <tr>
            <td align="center" style="background:#FAFAF9;border-top:1px solid #F0EBE8;padding:24px;">
              ${isotipoHtml}
              <p style="margin:0;color:#A89E9A;font-family:'Inter',Arial,sans-serif;font-size:12px;line-height:1.5;">
                MaIA · Agentes de IA para equipos LatAm<br />
                <a href="https://www.maiabuilder.ai" style="color:#A89E9A;text-decoration:none;">app.maiabuilder.ai</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------- Cuerpo HTML — Ventas ----------

function buildSalesHtml(lead, id) {
  const row = (label, value, opts = {}) => `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid #F0EBE8;color:#7A6E6A;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;width:36%;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #F0EBE8;color:#1A1410;font-size:14px;${opts.preWrap ? 'white-space:pre-wrap;word-break:break-word;' : ''}">${opts.raw ? value : escapeHtml(value)}</td>
    </tr>`;

  const paisCell = lead.pais
    ? `${escapeHtml(lead.pais)}${lead.pais_iso ? ` <span style="color:#A89E9A;">(${escapeHtml(lead.pais_iso)})</span>` : ''}`
    : '';

  const emailCell = lead.email
    ? `<a href="mailto:${escapeHtml(lead.email)}" style="color:#E8440A;text-decoration:none;">${escapeHtml(lead.email)}</a>`
    : '';

  const telCell = lead.telefono
    ? `<a href="tel:${escapeHtml(lead.telefono)}" style="color:#E8440A;text-decoration:none;">${escapeHtml(lead.telefono)}</a>`
    : '';

  const bodyHtml = `
    <p style="margin:0 0 8px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#E8440A;">Nuevo lead</p>
    <h1 style="margin:0 0 8px 0;font-family:'Inter',Arial,sans-serif;font-size:22px;font-weight:700;color:#1A1410;line-height:1.3;">${escapeHtml(lead.nombre || lead.email || 'Lead sin nombre')}</h1>
    <p style="margin:0 0 24px 0;color:#4A3F3A;font-size:14px;">Recibido desde la landing — Lead ID <strong style="color:#1A1410;">#${escapeHtml(id)}</strong></p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #F0EBE8;border-radius:12px;border-collapse:separate;border-spacing:0;overflow:hidden;margin:0 0 24px 0;">
      ${row('Nombre', lead.nombre || '')}
      ${row('Empresa', lead.empresa || '')}
      ${row('Industria', lead.industria || '')}
      ${row('Email', emailCell, { raw: true })}
      ${row('Teléfono', telCell, { raw: true })}
      ${row('País', paisCell, { raw: true })}
      ${row('Tipo', lead.tipo || 'demo')}
      ${row('Comentarios', lead.mensaje || '', { preWrap: true })}
    </table>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px 0;">
      <tr>
        <td align="center" style="background:#E8440A;border-radius:100px;">
          <a href="mailto:${escapeHtml(lead.email || '')}" style="display:inline-block;padding:12px 28px;color:#FFFFFF;font-family:'Inter',Arial,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:100px;">Responder al lead</a>
        </td>
      </tr>
    </table>
  `;

  return htmlShell({
    title: 'Nuevo lead — MaIA',
    previewText: `Nuevo lead: ${lead.nombre || lead.email}${lead.empresa ? ' · ' + lead.empresa : ''}`,
    bodyHtml,
  });
}

// ---------- Cuerpo HTML — Usuario ----------

function buildUserHtml(lead) {
  const nombre = lead.nombre ? lead.nombre.split(' ')[0] : '';
  const saludo = nombre ? `Hola ${escapeHtml(nombre)},` : 'Hola,';

  const bodyHtml = `
    <p style="margin:0 0 8px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#E8440A;">Solicitud recibida</p>
    <h1 style="margin:0 0 16px 0;font-family:'Inter',Arial,sans-serif;font-size:24px;font-weight:700;color:#1A1410;line-height:1.3;">¡Gracias por agendar una demo!</h1>

    <p style="margin:0 0 16px 0;color:#1A1410;font-size:15px;line-height:1.6;">${saludo}</p>

    <p style="margin:0 0 16px 0;color:#4A3F3A;font-size:15px;line-height:1.6;">
      Recibimos tu solicitud para conocer <strong style="color:#1A1410;">MaIA</strong>.
      Un miembro de nuestro equipo se pondrá en contacto contigo en menos de
      <strong style="color:#1A1410;">24 horas hábiles</strong> para coordinar la sesión.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFF8F5;border:1px solid #F0EBE8;border-radius:12px;margin:0 0 24px 0;">
      <tr>
        <td style="padding:20px 24px;color:#1A1410;font-size:14px;line-height:1.6;">
          <p style="margin:0 0 8px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#7A6E6A;">Próximos pasos</p>
          <ol style="margin:0;padding-left:20px;color:#4A3F3A;">
            <li style="margin-bottom:6px;">Te enviaremos un correo con horarios disponibles.</li>
            <li style="margin-bottom:6px;">Confirmas el slot que mejor te acomode.</li>
            <li>Hacemos la demo (30 min) adaptada a tu caso.</li>
          </ol>
        </td>
      </tr>
    </table>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
      <tr>
        <td align="center" style="background:#E8440A;border-radius:100px;">
          <a href="https://app.maiabuilder.ai" style="display:inline-block;padding:14px 28px;color:#FFFFFF;font-family:'Inter',Arial,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:100px;">Conocer más sobre MaIA</a>
        </td>
      </tr>
    </table>

    <p style="margin:0;color:#7A6E6A;font-size:13px;line-height:1.6;">
      Si tienes alguna pregunta, puedes responder directamente este correo o escribirnos a
      <a href="mailto:maia@maiabuilder.ai" style="color:#E8440A;text-decoration:none;">maia@maiabuilder.ai</a>.
    </p>
  `;

  return htmlShell({
    title: 'Confirmación de demo — MaIA',
    previewText: 'Gracias por agendar tu demo con MaIA. Te contactamos en 24 horas hábiles.',
    bodyHtml,
  });
}

// ---------- Mailer ----------

export function createMailer(config = {}) {
  const host = config.host ?? process.env.SMTP_HOST;
  const port = Number(config.port ?? process.env.SMTP_PORT ?? 587);
  const secure = asBool(config.secure ?? process.env.SMTP_SECURE);
  const user = config.user ?? process.env.SMTP_USER;
  const pass = config.pass ?? process.env.SMTP_PASS;
  const from = config.from ?? process.env.MAIL_FROM ?? 'noreply@maiabuilder.ai';
  const to = config.to ?? process.env.MAIL_TO ?? 'maia@maiabuilder.ai';

  if (!host) {
    return {
      enabled: false,
      provider: 'nodemailer',
      async sendLead() {
        return {
          status: 'skipped',
          reason: 'SMTP_HOST no configurada',
          sentTo: [],
          messageIds: [],
          results: { sales: { status: 'skipped' }, user: { status: 'skipped' } },
        };
      },
    };
  }

  // Resend HTTP API — usa cuando SMTP_HOST=resend (evita bloqueos de puerto SMTP en Render/Railway)
  if (host === 'resend') {
    const apiKey = pass ?? user;
    const resendClient = config.resendClient ?? new Resend(apiKey);

    async function sendOneResend({ from: f, to: t, replyTo, subject, text, html, attachments }) {
      try {
        const payload = { from: f, to: Array.isArray(t) ? t : [t], subject, text, html };
        if (replyTo) payload.replyTo = replyTo;
        if (attachments?.length) payload.attachments = toResendAttachments(attachments);
        const { data, error } = await resendClient.emails.send(payload);
        if (error) return { status: 'failed', to: t, reason: error.message, statusCode: error.statusCode };
        return { status: 'sent', to: t, messageId: data?.id };
      } catch (err) {
        return { status: 'failed', to: t, reason: err?.message, statusCode: err?.statusCode };
      }
    }

    return {
      enabled: true,
      provider: 'resend',
      to,
      async sendLead(lead, id) {
        const attachments = buildLogoAttachments();
        const salesResult = await sendOneResend({
          from, to, replyTo: lead.email,
          subject: buildSalesSubject(lead),
          text: buildSalesText(lead, id),
          html: buildSalesHtml(lead, id),
          attachments,
        });
        const userResult = lead.email
          ? await sendOneResend({
              from, to: lead.email,
              subject: buildUserSubject(),
              text: buildUserText(lead),
              html: buildUserHtml(lead),
              attachments,
            })
          : { status: 'skipped', to: '', reason: 'lead sin email' };

        const sentTo = [salesResult, userResult].filter(r => r.status === 'sent').map(r => r.to);
        const messageIds = [salesResult, userResult].filter(r => r.messageId).map(r => r.messageId);
        const status = salesResult.status === 'sent' && userResult.status === 'sent' ? 'sent'
          : salesResult.status === 'sent' || userResult.status === 'sent' ? 'partial' : 'failed';
        return { status, sentTo, messageIds, results: { sales: salesResult, user: userResult } };
      },
    };
  }

  const transporter = config.transporter ?? nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  async function sendOne(msg) {
    try {
      const info = await transporter.sendMail(msg);
      return {
        status: 'sent',
        to: msg.to,
        messageId: info?.messageId,
        response: info?.response,
        accepted: info?.accepted,
        rejected: info?.rejected,
      };
    } catch (err) {
      return {
        status: 'failed',
        to: msg.to,
        statusCode: err?.responseCode ?? err?.code,
        reason: err?.message,
        body: err?.response,
      };
    }
  }

  return {
    enabled: true,
    provider: 'nodemailer',
    async sendLead(lead, id) {
      const attachments = buildLogoAttachments();

      const salesMsg = {
        from,
        to,
        replyTo: lead.email,
        subject: buildSalesSubject(lead),
        text: buildSalesText(lead, id),
        html: buildSalesHtml(lead, id),
        attachments,
      };

      const userMsg = {
        from,
        to: lead.email,
        subject: buildUserSubject(),
        text: buildUserText(lead),
        html: buildUserHtml(lead),
        attachments,
      };

      const salesResult = await sendOne(salesMsg);
      const userResult = lead.email ? await sendOne(userMsg) : { status: 'skipped', to: '', reason: 'lead sin email' };

      const sentTo = [];
      const messageIds = [];
      if (salesResult.status === 'sent') {
        sentTo.push(salesResult.to);
        if (salesResult.messageId) messageIds.push(salesResult.messageId);
      }
      if (userResult.status === 'sent') {
        sentTo.push(userResult.to);
        if (userResult.messageId) messageIds.push(userResult.messageId);
      }

      let status;
      if (salesResult.status === 'sent' && userResult.status === 'sent') {
        status = 'sent';
      } else if (salesResult.status === 'sent' || userResult.status === 'sent') {
        status = 'partial';
      } else {
        status = 'failed';
      }

      return {
        status,
        sentTo,
        messageIds,
        results: { sales: salesResult, user: userResult },
      };
    },
  };
}

// Exports auxiliares para testing.
export const __internals = {
  escapeHtml,
  buildSalesSubject,
  buildUserSubject,
  buildSalesText,
  buildUserText,
  buildSalesHtml,
  buildUserHtml,
};
