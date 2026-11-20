'use strict';
// Envío de correo (SMTP) para el segundo factor de autenticación. La configuración vive en data/smtp.json.
const fs = require('fs');

function loadSmtp(file) { try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); return c && c.host ? c : null; } catch { return null; } }
function transport(cfg) {
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: cfg.host, port: +cfg.port || 587, secure: !!cfg.secure, ignoreTLS: !!cfg.ignoreTLS,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    tls: { rejectUnauthorized: cfg.rejectUnauthorized !== false },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
}
async function sendMail(cfg, { to, subject, text }) {
  return transport(cfg).sendMail({ from: cfg.from || cfg.user, to, subject, text });
}
const maskEmail = (e) => { const [u, d] = String(e).split('@'); return u ? `${u[0]}${'•'.repeat(Math.max(1, Math.min(6, u.length - 1)))}@${d || ''}` : ''; };
module.exports = { loadSmtp, transport, sendMail, maskEmail };
