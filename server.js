'use strict';
// webterm — terminal web multi-sesión (estilo Tilix) con xterm.js + node-pty.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const fsp = fs.promises;
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const PORT = parseInt(process.env.PORT || '8022', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA = process.env.WEBTERM_DATA || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA, 'users.json');
const LAYOUT_FILE = path.join(DATA, 'layouts.json');
const SMTP_FILE = path.join(DATA, 'smtp.json');
const THUMB_DIR = path.join(DATA, 'thumbs');
const TLS_DIR = path.join(DATA, 'tls');
const sysinfo = require('./lib/status');
const mail = require('./lib/mail');
const thumbs = require('./lib/thumbs');
const { PtyHub } = require('./lib/ptyhub');
const net = require('net');
const SESSIONS_FILE = path.join(DATA, 'sessions.json');
const PERSIST = process.env.WEBTERM_PERSIST !== '0'; // terminales que sobreviven a reinicios (demonio lib/ptyd.js)
// los sockets Unix admiten ~100 caracteres de ruta: si data/ está muy profundo, usar el directorio de runtime del usuario
const PTYD_SOCK = (() => {
  const own = path.join(DATA, 'ptyd.sock');
  if (own.length <= 100) return own;
  return path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `webterm-${crypto.createHash('sha1').update(DATA).digest('hex').slice(0, 10)}.sock`);
})();
const SESSION_TTL = 12 * 3600 * 1000; // inactividad máxima
const SCROLLBACK_BYTES = 256 * 1024;
const COOKIE = 'webterm_sid';

fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

// ---------- auditoría ----------
const AUDIT_FILE = path.join(DATA, 'audit.log');
function audit(ev, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ev, ...fields });
  console.log(line); // también va al journal de systemd
  try {
    if (fs.existsSync(AUDIT_FILE) && fs.statSync(AUDIT_FILE).size > 10 * 1024 * 1024) fs.renameSync(AUDIT_FILE, AUDIT_FILE + '.1');
    fs.appendFileSync(AUDIT_FILE, line + '\n', { mode: 0o600 });
  } catch (e) { console.error('audit error', e.message); }
}

// ---------- usuarios ----------
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; }
}
function verifyPassword(user, password) {
  const users = loadUsers();
  const rec = users[user];
  // hash ficticio para no filtrar por timing si el usuario no existe
  const salt = rec ? Buffer.from(rec.salt, 'hex') : Buffer.alloc(16);
  const expected = rec ? Buffer.from(rec.hash, 'hex') : Buffer.alloc(64);
  const got = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(got, expected) && !!rec;
}
if (!Object.keys(loadUsers()).length) {
  console.error('No hay usuarios configurados. Ejecutá primero:  node setup.js');
  process.exit(1);
}

// ---------- sesiones HTTP ----------
// Sobreviven a reinicios: se guardan en data/sessions.json con el hash del identificador (nunca el valor de la cookie).
const sessions = new Map(); // sha256(sid) -> {user, last}
const sidHash = (sid) => crypto.createHash('sha256').update(sid).digest('hex');
try {
  const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')), now = Date.now();
  for (const [k, v] of Object.entries(saved)) if (v && typeof v.user === 'string' && now - v.last <= SESSION_TTL) sessions.set(k, { user: v.user, last: v.last, created: v.created, ip: v.ip, ua: v.ua });
} catch {}
let sessSaveT = null, sessSavedAt = 0;
function saveSessions() {
  clearTimeout(sessSaveT);
  sessSaveT = setTimeout(() => {
    try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 }); fs.chmodSync(SESSIONS_FILE, 0o600); } catch {}
    sessSavedAt = Date.now();
  }, 500);
}
function parseCookies(h) {
  const out = {};
  (h || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function sessionFrom(req) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  const key = sid && sidHash(sid), s = key && sessions.get(key);
  if (!s) return null;
  const now = Date.now();
  if (now - s.last > SESSION_TTL) { sessions.delete(key); saveSessions(); return null; }
  s.last = now;
  if (now - sessSavedAt > 60000) saveSessions(); // la expiración deslizante se persiste como mucho una vez por minuto
  return { sid: key, user: s.user };
}
setInterval(() => {
  const now = Date.now(); let changed = false;
  for (const [k, v] of sessions) if (now - v.last > SESSION_TTL) { sessions.delete(k); changed = true; }
  if (changed) saveSessions();
}, 600000).unref();

// ---------- anti fuerza bruta ----------
const fails = new Map(); // ip -> {n, until}
function ipOf(req) { return req.socket.remoteAddress || 'x'; }
function lockedFor(ip) {
  const f = fails.get(ip);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function registerFail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + Math.min(900000, 30000 * 2 ** (f.n - 5)); }
  fails.set(ip, f);
}

// ---------- panes (PTYs) ----------
const panes = new Map(); // id -> {pty, buf:[], size, clients:Set}
let hub = null; // cliente del demonio de terminales (si la persistencia está activa)
function wirePane(id, p, user, nonce, replay) {
  const pane = { pty: p, buf: replay ? [replay] : [], size: replay ? replay.length : 0, clients: new Set(), user, nonce, tail: '' };
  p.onData((d) => {
    d = extractCommands(pane, id, d);
    if (!d) return;
    pane.buf.push(d); pane.size += d.length;
    while (pane.size > SCROLLBACK_BYTES && pane.buf.length > 1) pane.size -= pane.buf.shift().length;
    const msg = JSON.stringify({ t: 'o', d });
    for (const c of pane.clients) if (c.readyState === 1) c.send(msg);
  });
  p.onExit(() => {
    audit('pane_exit', { user: pane.user, pane: id });
    const msg = JSON.stringify({ t: 'x' });
    for (const c of pane.clients) { try { c.send(msg); c.close(); } catch {} }
    panes.delete(id);
  });
  panes.set(id, pane);
  return pane;
}
async function newPane(fromId, user, cwdOverride) {
  let cwd = process.env.HOME || '/';
  const src = fromId && panes.get(fromId);
  if (cwdOverride) cwd = cwdOverride;
  else if (src && src.pty.pid) { try { cwd = fs.readlinkSync(`/proc/${src.pty.pid}/cwd`); } catch {} }
  const shell = process.env.SHELL || '/bin/bash';
  const id = crypto.randomBytes(6).toString('hex');
  const nonce = crypto.randomBytes(12).toString('hex');
  const isBash = path.basename(shell) === 'bash';
  const args = isBash ? ['--rcfile', path.join(__dirname, 'shell', 'bashrc.webterm'), '-i'] : [];
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', WEBTERM_NONCE: nonce };
  let p;
  if (hub) {
    await hub.ensure();
    p = hub.spawnPty(id, { shell, args, cwd, env, cols: 80, rows: 24, meta: { user, nonce, cwd, shell } });
  } else p = pty.spawn(shell, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd, env });
  wirePane(id, p, user, nonce, '');
  audit('pane_new', { user, pane: id, cwd, shell, cmd_logging: isBash });
  return id;
}
// Al arrancar: reconectar con el demonio y recuperar las terminales que quedaron vivas
async function initPersistence() {
  try {
    const h = new PtyHub(PTYD_SOCK, __dirname);
    await h.ensure();
    const list = await h.list();
    hub = h;
    for (const x of list) {
      wirePane(x.id, hub.adopt(x.id, x.pid), x.meta.user, x.meta.nonce, x.buf);
      audit('pane_restored', { user: x.meta.user, pane: x.id });
    }
    if (list.length) console.log(`${list.length} terminal(es) recuperada(s) tras el reinicio`);
  } catch (e) { console.error('Persistencia de terminales desactivada:', e.message); hub = null; }
}
// Extrae (y quita del flujo) las secuencias OSC 777 que emite el hook de bash: ESC ] 777 ; wt:<nonce> ; <base64> BEL
function extractCommands(pane, id, d) {
  const data = pane.tail + d; pane.tail = '';
  const START = '\x1b]777;wt:';
  let out = '', i = 0;
  for (;;) {
    const s = data.indexOf(START, i);
    if (s < 0) {
      // ¿termina con un prefijo parcial de START? guardarlo para el próximo chunk
      let keep = 0;
      for (let k = Math.min(START.length - 1, data.length - i); k > 0; k--) if (data.endsWith(START.slice(0, k))) { keep = k; break; }
      out += data.slice(i, data.length - keep); pane.tail = data.slice(data.length - keep); return out;
    }
    const e = data.indexOf('\x07', s);
    if (e < 0) { out += data.slice(i, s); pane.tail = data.slice(s); if (pane.tail.length > 8192) { out += pane.tail; pane.tail = ''; } return out; }
    out += data.slice(i, s);
    const [nonce, b64] = data.slice(s + START.length, e).split(';');
    if (nonce === pane.nonce && b64 !== undefined) {
      let cmd = ''; try { cmd = Buffer.from(b64, 'base64').toString('utf8'); } catch {}
      if (cmd) audit('cmd', { user: pane.user, pane: id, from: [...new Set([...pane.clients].map((c) => c.remoteIp))], cmd: cmd.slice(0, 2000) });
    }
    i = e + 1;
  }
}
function killPane(id) {
  const p = panes.get(id);
  if (p) { audit('pane_close', { user: p.user, pane: id }); try { p.pty.kill(); } catch {} }
}

// ---------- layouts ----------
function loadLayouts() { try { return JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8')); } catch { return {}; } }
function saveLayout(user, layout) {
  const all = loadLayouts(); all[user] = layout;
  fs.writeFileSync(LAYOUT_FILE, JSON.stringify(all), { mode: 0o600 });
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  next();
});
// protección CSRF: en métodos mutantes, Origin (si viene) debe coincidir con Host
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return res.status(403).end();
  next();
});
const jsonSmall = express.json({ limit: '256kb' });
app.use((req, res, next) => (req.path === '/api/fs/text' ? next() : jsonSmall(req, res, next))); // el editor de texto tiene su propio límite (más alto)

const isSecure = (req) => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';

app.get('/login', (req, res) => {
  if (sessionFrom(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
// ---------- segundo factor (correo o app TOTP), dispositivos recordados y aviso de acceso nuevo ----------
const totp = require('./lib/totp');
const DEVICES_FILE = path.join(DATA, 'devices.json'), KNOWN_FILE = path.join(DATA, 'known-ips.json');
const DEV_COOKIE = 'webterm_dev', DEV_TTL = 30 * 86400000;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const writeJson = (f, o) => { fs.writeFileSync(f, JSON.stringify(o), { mode: 0o600 }); try { fs.chmodSync(f, 0o600); } catch {} };
const pending2fa = new Map(); // token -> {user, email, totp, hash, salt, exp, tries, ip, sends, lastSend}
const lastTotpStep = new Map(); // user -> último paso TOTP aceptado (un código no se puede usar dos veces)
setInterval(() => { const n = Date.now(); for (const [k, v] of pending2fa) if (v.exp < n) pending2fa.delete(k); }, 60000).unref();
const uaOf = (req) => (req.headers['user-agent'] || '').slice(0, 160);
const hashCode = (code, salt) => crypto.createHash('sha256').update(salt + code).digest('hex');
const cookieAttrs = (req, maxAge) => `HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
function startSession(req, res, user) {
  const sid = crypto.randomBytes(32).toString('hex'), now = Date.now();
  sessions.set(sidHash(sid), { user, last: now, created: now, ip: ipOf(req), ua: uaOf(req) });
  saveSessions();
  res.append('Set-Cookie', `${COOKIE}=${sid}; ${cookieAttrs(req, SESSION_TTL / 1000)}`);
}
function deviceOk(req, user) {
  const t = parseCookies(req.headers.cookie)[DEV_COOKIE]; if (!t) return false;
  const d = readJson(DEVICES_FILE)[sidHash(t)]; return !!d && d.user === user && d.exp > Date.now();
}
function rememberDevice(req, res, user) {
  const t = crypto.randomBytes(32).toString('hex'), all = readJson(DEVICES_FILE), now = Date.now();
  for (const [k, v] of Object.entries(all)) if (v.exp < now) delete all[k];
  all[sidHash(t)] = { user, created: now, exp: now + DEV_TTL, ip: ipOf(req), ua: uaOf(req) }; writeJson(DEVICES_FILE, all);
  res.append('Set-Cookie', `${DEV_COOKIE}=${t}; ${cookieAttrs(req, DEV_TTL / 1000)}`);
}
// Aviso por correo cuando un usuario con correo entra desde una IP que nunca había usado (la primera vez solo se registra)
function notifyNewIp(req, user) {
  const ip = ipOf(req), known = readJson(KNOWN_FILE), list = known[user] || [];
  if (list.includes(ip)) return;
  known[user] = [...list, ip].slice(-50); writeJson(KNOWN_FILE, known);
  const email = loadUsers()[user]?.email, cfg = mail.loadSmtp(SMTP_FILE);
  if (!list.length || !email || !cfg) return;
  audit('login_new_ip', { user, ip });
  mail.sendMail(cfg, { to: email, subject: 'webterm: nuevo acceso a tu cuenta', text: `Se inició sesión como «${user}» desde una IP que no se había usado antes.\n\nIP: ${ip}\nNavegador: ${uaOf(req) || 'desconocido'}\nFecha: ${new Date().toLocaleString()}\n\nSi no fuiste vos, cambiá la contraseña (node setup.js user ${user}) y revisá el registro de actividad.\n` })
    .catch((e) => audit('alert_mail_error', { user, error: String(e.message).slice(0, 160) }));
}
function finishLogin(req, res, user, extra = {}) {
  fails.delete(ipOf(req)); audit('login_ok', { ip: ipOf(req), user, ua: uaOf(req), ...extra });
  startSession(req, res, user); notifyNewIp(req, user);
}
async function sendCode(req, p) {
  const cfg = mail.loadSmtp(SMTP_FILE); if (!cfg) throw new Error('SMTP no configurado');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  p.salt = crypto.randomBytes(8).toString('hex'); p.hash = hashCode(code, p.salt); p.exp = Date.now() + 10 * 60000; p.tries = 0;
  p.sends++; p.lastSend = Date.now();
  await mail.sendMail(cfg, { to: p.email, subject: `Tu código de acceso a webterm: ${code}`,
    text: `Tu código de acceso es ${code}.\n\nVence en 10 minutos.\n\nSolicitado desde ${ipOf(req)} (${uaOf(req) || 'navegador desconocido'}) el ${new Date().toLocaleString()}.\nSi no fuiste vos, alguien conoce tu contraseña: cambiala y no compartas este código.\n` });
  audit('login_2fa_sent', { user: p.user, ip: ipOf(req), to: mail.maskEmail(p.email) });
}
const challenge = (token, p) => ({ need2fa: true, token, method: p.totp ? 'totp' : 'email', hint: p.email ? mail.maskEmail(p.email) : null, canEmail: !!p.email && !!mail.loadSmtp(SMTP_FILE) });
app.post('/login', async (req, res) => {
  const ip = ipOf(req);
  const wait = lockedFor(ip);
  if (wait) { audit('login_blocked', { ip, wait_s: wait }); return res.status(429).json({ error: `Demasiados intentos. Esperá ${wait}s.` }); }
  const { user, password } = req.body || {};
  if (typeof user !== 'string' || typeof password !== 'string' || !user || password.length > 512
      || !verifyPassword(user, password)) {
    registerFail(ip);
    audit('login_fail', { ip, user: typeof user === 'string' ? user.slice(0, 64) : null, ua: uaOf(req) });
    return setTimeout(() => res.status(401).json({ error: 'Usuario o contraseña incorrectos.' }), 600);
  }
  const rec = loadUsers()[user], hasTotp = !!rec.totp, email = rec.email;
  if (hasTotp || email) { // el usuario tiene segundo factor: la contraseña sola no alcanza (salvo en un dispositivo recordado)
    if (deviceOk(req, user)) { finishLogin(req, res, user, { device: true }); return res.json({ ok: true }); }
    const token = crypto.randomBytes(24).toString('hex');
    const p = { user, email, totp: hasTotp, ip, sends: 0, lastSend: 0, exp: Date.now() + 10 * 60000, tries: 0 };
    if (!hasTotp) { // sin app, el código se envía por correo
      try { await sendCode(req, p); } catch (e) {
        audit('login_2fa_error', { user, ip, error: String(e.message).slice(0, 160) });
        return res.status(502).json({ error: 'No se pudo enviar el código por correo. Revisá la configuración SMTP del servidor.' });
      }
    }
    pending2fa.set(token, p);
    return res.json(challenge(token, p));
  }
  finishLogin(req, res, user);
  res.json({ ok: true });
});
app.post('/login/verify', (req, res) => {
  const ip = ipOf(req), wait = lockedFor(ip);
  if (wait) return res.status(429).json({ error: `Demasiados intentos. Esperá ${wait}s.` });
  const { token, code, remember } = req.body || {};
  const p = typeof token === 'string' && pending2fa.get(token);
  if (!p || p.ip !== ip || p.exp < Date.now()) return res.status(401).json({ error: 'El código venció. Volvé a iniciar sesión.', expired: true });
  const c = typeof code === 'string' ? code.trim() : '';
  let ok = false;
  if (/^\d{6}$/.test(c)) {
    if (p.totp) { const secret = loadUsers()[p.user]?.totp, step = secret ? totp.verify(secret, c) : null; if (step !== null && step > (lastTotpStep.get(p.user) || 0)) { lastTotpStep.set(p.user, step); ok = true; } }
    if (!ok && p.hash) ok = crypto.timingSafeEqual(Buffer.from(hashCode(c, p.salt)), Buffer.from(p.hash));
  }
  if (!ok) {
    registerFail(ip); audit('login_2fa_fail', { user: p.user, ip });
    if (++p.tries >= 5) { pending2fa.delete(token); return res.status(401).json({ error: 'Demasiados intentos con el código. Volvé a iniciar sesión.', expired: true }); }
    return setTimeout(() => res.status(401).json({ error: 'Código incorrecto.' }), 500);
  }
  pending2fa.delete(token);
  if (remember === true) { rememberDevice(req, res, p.user); audit('device_remembered', { user: p.user, ip }); }
  finishLogin(req, res, p.user, { twofa: p.totp ? 'totp' : 'email' });
  res.json({ ok: true });
});
app.post('/login/resend', async (req, res) => { // reenviar el código por correo (también sirve para pedirlo por correo si el usuario usa app)
  const ip = ipOf(req), p = typeof req.body?.token === 'string' && pending2fa.get(req.body.token);
  if (!p || p.ip !== ip) return res.status(401).json({ error: 'Volvé a iniciar sesión.', expired: true });
  if (!p.email) return res.status(400).json({ error: 'Este usuario no tiene correo configurado.' });
  if (Date.now() - p.lastSend < 30000) return res.status(429).json({ error: 'Esperá unos segundos antes de pedir otro código.' });
  if (p.sends >= 3) return res.status(429).json({ error: 'Ya se envió el código varias veces. Volvé a iniciar sesión.', expired: true });
  try { await sendCode(req, p); res.json({ ok: true, hint: mail.maskEmail(p.email) }); }
  catch (e) { audit('login_2fa_error', { user: p.user, ip, error: String(e.message).slice(0, 160) }); res.status(502).json({ error: 'No se pudo enviar el código.' }); }
});
app.post('/logout', (req, res) => {
  const s = sessionFrom(req);
  if (s) { audit('logout', { ip: ipOf(req), user: s.user }); sessions.delete(s.sid); saveSessions(); }
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/vendor/links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));
app.use('/vendor/search', express.static(path.join(__dirname, 'node_modules/@xterm/addon-search')));
app.get('/favicon.svg', (req, res) => res.type('image/svg+xml').sendFile(path.join(__dirname, 'public', 'favicon.svg')));
// app instalable (PWA): manifiesto, service worker mínimo e íconos; públicos porque el navegador los pide sin sesión
const pub = (f) => path.join(__dirname, 'public', f);
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').sendFile(pub('manifest.webmanifest')));
app.get('/sw.js', (req, res) => res.type('application/javascript').sendFile(pub('sw.js')));
app.get(/^\/icon-(192|512)\.png$/, (req, res) => res.sendFile(pub(req.path.slice(1))));
app.get('/ca.pem', (req, res) => { // certificado público de la autoridad propia, para instalarlo en el teléfono/PC
  const f = path.join(TLS_DIR, 'ca.pem');
  if (!fs.existsSync(f)) return res.status(404).end();
  res.type('application/x-x509-ca-cert').setHeader('Content-Disposition', 'attachment; filename="webterm-ca.pem"');
  res.send(fs.readFileSync(f));
});
app.get('/login.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.js')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'public', 'style.css')));

// ---- a partir de acá todo requiere sesión ----
app.use((req, res, next) => {
  const s = sessionFrom(req);
  if (s) { req.user = s.user; return next(); }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth' });
  res.redirect('/login');
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.js')));
app.get('/shortcuts.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'shortcuts.js')));
app.get('/extras.js', (req, res) => res.sendFile(pub('extras.js')));
app.get('/files2.js', (req, res) => res.sendFile(pub('files2.js')));
app.get('/system.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'system.js')));

app.get('/api/state', (req, res) => {
  res.json({ user: req.user, layout: loadLayouts()[req.user] || null, panes: [...panes.keys()] });
});
app.put('/api/layout', (req, res) => { saveLayout(req.user, req.body); res.json({ ok: true }); });
// preferencias por usuario (atajos de teclado); sólo se guardan las diferencias con los valores por defecto
const PREFS_FILE = path.join(DATA, 'prefs.json');
const loadPrefs = () => { try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { return {}; } };
app.get('/api/prefs', (req, res) => res.json(loadPrefs()[req.user] || {}));
app.put('/api/prefs', (req, res) => {
  const sc = req.body && req.body.shortcuts, la = req.body && req.body.launchers, upd = {};
  if (sc !== undefined) {
    if (!sc || typeof sc !== 'object' || Array.isArray(sc)) return res.status(400).json({ error: 'Formato inválido' });
    upd.shortcuts = {};
    for (const [k, v] of Object.entries(sc).slice(0, 100)) if (/^[A-Za-z0-9_]{1,40}$/.test(k) && typeof v === 'string' && v.length <= 60) upd.shortcuts[k] = v;
  }
  if (la !== undefined) {
    if (!Array.isArray(la)) return res.status(400).json({ error: 'Formato inválido' });
    upd.launchers = la.slice(0, 100).filter((x) => x && typeof x.name === 'string' && typeof x.cmd === 'string')
      .map((x) => ({ id: String(x.id || '').slice(0, 20), name: x.name.slice(0, 60), cmd: x.cmd.slice(0, 4000), mode: x.mode === 'session' ? 'session' : 'current', enter: x.enter !== false }));
  }
  if (!Object.keys(upd).length) return res.status(400).json({ error: 'Formato inválido' });
  const all = loadPrefs(); all[req.user] = { ...all[req.user], ...upd };
  fs.writeFileSync(PREFS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  res.json({ ok: true });
});
app.post('/api/panes', async (req, res) => {
  try {
    const from = typeof req.body?.from === 'string' ? req.body.from : null;
    let cwd = null;
    if (req.body?.cwd !== undefined) { // "abrir en terminal": la shell arranca en esa carpeta (o en la carpeta del archivo)
      cwd = absPath(req.body.cwd);
      const st = await fsp.stat(cwd);
      if (!st.isDirectory()) cwd = path.dirname(cwd);
    }
    res.json({ id: await newPane(from, req.user, cwd) });
  } catch (e) { fsFail(res, e); }
});
app.delete('/api/panes/:id', (req, res) => { killPane(req.params.id); res.json({ ok: true }); });

// ---------- explorador de archivos ----------
const homeDir = () => process.env.HOME || os.homedir();
const httpErr = (status, error) => Object.assign(new Error(error), { status });
function absPath(p) {
  if (p !== undefined && typeof p !== 'string') throw httpErr(400, 'Ruta inválida');
  if (p && p.includes('\0')) throw httpErr(400, 'Ruta inválida');
  if (p === '~' || (p && p.startsWith('~/'))) p = path.join(homeDir(), p.slice(1));
  return path.resolve(p ? (path.isAbsolute(p) ? p : path.join(homeDir(), p)) : homeDir());
}
function cleanName(n) {
  if (typeof n !== 'string') throw httpErr(400, 'Nombre inválido');
  n = n.trim();
  if (!n || n === '.' || n === '..' || /[\/\0]/.test(n) || Buffer.byteLength(n) > 255) throw httpErr(400, 'Nombre inválido');
  return n;
}
function fsFail(res, e) {
  const map = { ENOENT: [404, 'No existe'], EACCES: [403, 'Sin permiso'], EPERM: [403, 'Operación no permitida'],
    ENOTDIR: [400, 'No es una carpeta'], EISDIR: [400, 'Es una carpeta'], EEXIST: [409, 'Ya existe'],
    ENOTEMPTY: [409, 'La carpeta no está vacía'], ENOSPC: [507, 'Sin espacio en disco'] };
  const [status, msg] = e.status ? [e.status, e.message] : (map[e.code] || [500, 'Error: ' + (e.code || e.message)]);
  if (!res.headersSent) res.status(status).json({ error: msg }); else res.destroy();
}
const contentDisposition = (name) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`;
async function uniquePath(file) {
  const { dir, name, ext } = path.parse(file);
  for (let i = 0; ; i++) {
    const cand = i ? path.join(dir, `${name} (${i})${ext}`) : file;
    try { await fsp.access(cand); } catch { return cand; }
  }
}
const fsAudit = (ev, req, f) => audit(ev, { user: req.user, ip: ipOf(req), ...f });

app.get('/api/fs/list', async (req, res) => {
  try {
    const dir = absPath(req.query.path);
    if (!(await fsp.stat(dir)).isDirectory()) throw httpErr(400, 'No es una carpeta');
    const all = await fsp.readdir(dir, { withFileTypes: true });
    const entries = await Promise.all(all.slice(0, 5000).map(async (d) => {
      let st = null;
      try { st = await fsp.stat(path.join(dir, d.name)); } catch {} // sigue symlinks; roto => null
      return { name: d.name, dir: st ? st.isDirectory() : d.isDirectory(), size: st ? st.size : 0,
        mtime: st ? st.mtimeMs : 0, link: d.isSymbolicLink(), broken: !st };
    }));
    res.json({ path: dir, parent: dir === path.parse(dir).root ? null : path.dirname(dir), home: homeDir(), entries, truncated: all.length > 5000 });
  } catch (e) { fsFail(res, e); }
});

app.get('/api/fs/download', async (req, res) => {
  try {
    const p = absPath(req.query.path);
    const st = await fsp.stat(p);
    if (st.isDirectory()) {
      if (p === path.parse(p).root) throw httpErr(400, 'No se puede descargar la raíz');
      fsAudit('fs_download', req, { path: p, folder: true });
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', contentDisposition(path.basename(p) + '.tar.gz'));
      const tar = spawn('tar', ['-czf', '-', '-C', path.dirname(p), '--', path.basename(p)], { stdio: ['ignore', 'pipe', 'ignore'] });
      tar.stdout.pipe(res);
      tar.on('error', () => res.destroy());
      res.on('close', () => tar.kill());
    } else if (st.isFile()) {
      fsAudit('fs_download', req, { path: p, size: st.size });
      res.download(p, path.basename(p), { dotfiles: 'allow' }, (err) => { if (err) fsFail(res, err); });
    } else throw httpErr(400, 'Tipo de archivo no soportado');
  } catch (e) { fsFail(res, e); }
});

app.post('/api/fs/upload', async (req, res) => {
  let tmp;
  try {
    const dir = absPath(req.query.dir), name = cleanName(req.query.name);
    if (!(await fsp.stat(dir)).isDirectory()) throw httpErr(400, 'No es una carpeta');
    const final = req.query.overwrite === '1' ? path.join(dir, name) : await uniquePath(path.join(dir, name));
    tmp = path.join(dir, `.${crypto.randomBytes(6).toString('hex')}.webterm-part`);
    await new Promise((ok, fail) => {
      const w = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o644 });
      req.on('close', () => { if (!req.complete) { w.destroy(); fail(httpErr(499, 'Subida cancelada')); } });
      req.on('error', fail); w.on('error', fail); w.on('finish', ok);
      req.pipe(w);
    });
    await fsp.rename(tmp, final); tmp = null;
    const size = (await fsp.stat(final)).size;
    fsAudit('fs_upload', req, { path: final, size });
    res.json({ ok: true, name: path.basename(final), size });
  } catch (e) {
    if (tmp) fsp.rm(tmp, { force: true }).catch(() => {});
    fsFail(res, e);
  }
});

app.post('/api/fs/mkdir', async (req, res) => {
  try {
    const p = path.join(absPath(req.body?.dir), cleanName(req.body?.name));
    await fsp.mkdir(p);
    fsAudit('fs_mkdir', req, { path: p });
    res.json({ ok: true });
  } catch (e) { fsFail(res, e); }
});

app.post('/api/fs/rename', async (req, res) => {
  try {
    const from = absPath(req.body?.path), to = path.join(path.dirname(from), cleanName(req.body?.name));
    try { await fsp.access(to); throw httpErr(409, 'Ya existe'); } catch (e) { if (e.status) throw e; }
    await fsp.rename(from, to);
    fsAudit('fs_rename', req, { from, to });
    res.json({ ok: true });
  } catch (e) { fsFail(res, e); }
});

app.post('/api/fs/delete', async (req, res) => {
  try {
    const p = absPath(req.body?.path), home = homeDir();
    if (p === path.parse(p).root || p === home || home.startsWith(p + path.sep)) throw httpErr(400, 'No se puede borrar esta carpeta');
    const st = await fsp.lstat(p);
    await fsp.rm(p, { recursive: true });
    fsAudit('fs_delete', req, { path: p, folder: st.isDirectory() });
    res.json({ ok: true });
  } catch (e) { fsFail(res, e); }
});

// ---------- explorador: copiar/mover, zip, búsqueda y edición de texto ----------
app.post('/api/fs/paste', async (req, res) => {
  try {
    const op = req.body?.op === 'move' ? 'move' : 'copy', dir = absPath(req.body?.dir), paths = (Array.isArray(req.body?.paths) ? req.body.paths : []).slice(0, 500).map(absPath);
    if (!(await fsp.stat(dir)).isDirectory()) throw httpErr(400, 'El destino no es una carpeta');
    let done = 0; const errors = [];
    for (const src of paths) {
      try {
        if (dir === src || dir.startsWith(src + path.sep)) throw httpErr(400, 'No se puede pegar una carpeta dentro de sí misma');
        if (op === 'move' && path.dirname(src) === dir) { done++; continue; } // ya está ahí
        const dest = await uniquePath(path.join(dir, path.basename(src)));
        if (op === 'copy') await fsp.cp(src, dest, { recursive: true, errorOnExist: true });
        else { try { await fsp.rename(src, dest); } catch (e) { if (e.code !== 'EXDEV') throw e; await fsp.cp(src, dest, { recursive: true }); await fsp.rm(src, { recursive: true }); } }
        fsAudit(op === 'copy' ? 'fs_copy' : 'fs_move', req, { from: src, to: dest }); done++;
      } catch (e) { errors.push(`${path.basename(src)}: ${e.status ? e.message : (e.code || e.message)}`); }
    }
    res.json({ ok: true, done, errors });
  } catch (e) { fsFail(res, e); }
});
app.get('/api/fs/zip', async (req, res) => { // varios elementos de una misma carpeta, en un .zip (o .tar.gz si no hay zip)
  try {
    const dir = absPath(req.query.dir), names = [].concat(req.query.n || []).slice(0, 500).map(cleanName);
    if (!names.length || !(await fsp.stat(dir)).isDirectory()) throw httpErr(400, 'Selección inválida');
    const zip = require('child_process').spawnSync('which', ['zip']).status === 0, ext = zip ? 'zip' : 'tar.gz';
    fsAudit('fs_download', req, { path: dir, items: names.length, archive: ext });
    res.setHeader('Content-Type', zip ? 'application/zip' : 'application/gzip');
    res.setHeader('Content-Disposition', contentDisposition(`${path.basename(dir) || 'seleccion'}-seleccion.${ext}`));
    const child = spawn(zip ? 'zip' : 'tar', zip ? ['-r', '-q', '-', '--', ...names] : ['-czf', '-', '--', ...names], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.pipe(res); child.on('error', () => res.destroy()); res.on('close', () => child.kill());
  } catch (e) { fsFail(res, e); }
});
app.get('/api/fs/search', async (req, res) => {
  try {
    const root = absPath(req.query.dir), q = String(req.query.q || '').trim().toLowerCase(); if (!q) return res.json({ results: [] });
    const out = [], queue = [[root, 0]], t0 = Date.now(); let scanned = 0;
    while (queue.length && out.length < 300 && Date.now() - t0 < 4000 && scanned < 60000) {
      const [d, depth] = queue.shift(); let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        scanned++; const full = path.join(d, e.name);
        if (e.name.toLowerCase().includes(q)) { let st = null; try { st = await fsp.stat(full); } catch {} out.push({ path: full, name: e.name, dir: e.isDirectory(), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 }); if (out.length >= 300) break; }
        if (e.isDirectory() && !e.isSymbolicLink() && depth < 8 && e.name !== 'node_modules' && e.name !== '.git') queue.push([full, depth + 1]);
      }
    }
    res.json({ results: out, partial: queue.length > 0 || out.length >= 300 });
  } catch (e) { fsFail(res, e); }
});
const MAX_TEXT = 1024 * 1024;
app.get('/api/fs/text', async (req, res) => {
  try {
    const p = absPath(req.query.path), st = await fsp.stat(p);
    if (!st.isFile()) throw httpErr(400, 'No es un archivo');
    if (st.size > MAX_TEXT) throw httpErr(413, 'El archivo es muy grande para editarlo aquí (máx. 1 MB)');
    const buf = await fsp.readFile(p); if (buf.includes(0)) throw httpErr(415, 'Parece un archivo binario');
    res.json({ content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs });
  } catch (e) { fsFail(res, e); }
});
app.put('/api/fs/text', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const p = absPath(req.body?.path), content = req.body?.content; if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_TEXT) throw httpErr(413, 'Contenido demasiado grande');
    const st = await fsp.stat(p); if (!st.isFile()) throw httpErr(400, 'No es un archivo');
    if (typeof req.body.mtime === 'number' && Math.abs(req.body.mtime - st.mtimeMs) > 1) throw httpErr(409, 'El archivo cambió en el equipo desde que lo abriste. Cerralo y volvé a abrirlo para no pisar esos cambios.');
    const tmp = path.join(path.dirname(p), `.${crypto.randomBytes(6).toString('hex')}.webterm-part`);
    await fsp.writeFile(tmp, content, { mode: st.mode & 0o7777 }); await fsp.chmod(tmp, st.mode & 0o7777); await fsp.rename(tmp, p);
    fsAudit('fs_edit', req, { path: p, size: Buffer.byteLength(content) });
    res.json({ ok: true, mtime: (await fsp.stat(p)).mtimeMs });
  } catch (e) { fsFail(res, e); }
});

// ---------- estado del equipo, registro y miniaturas ----------
app.get('/api/status', async (req, res) => {
  try { res.json({ ...(await sysinfo.status()), me: os.userInfo().username, webterm: { panes: panes.size, sessions: sessions.size, pid: process.pid, node: process.version, tls: USE_TLS, twofa: !!mail.loadSmtp(SMTP_FILE), inhibit: !!inhibitProc } }); }
  catch (e) { res.status(500).json({ error: 'No se pudo leer el estado: ' + e.message }); }
});
app.get('/api/audit', (req, res) => {
  const cat = typeof req.query.cat === 'string' ? req.query.cat : '', q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  res.json({ entries: sysinfo.readAudit(AUDIT_FILE, { limit: +req.query.limit || 300, cat, q }) });
});
app.post('/api/proc/kill', (req, res) => {
  const pid = Number(req.body?.pid), sig = req.body?.signal === 'KILL' ? 'SIGKILL' : 'SIGTERM';
  if (!Number.isInteger(pid) || pid <= 1) return res.status(400).json({ error: 'PID inválido' });
  if (pid === process.pid) return res.status(400).json({ error: 'Ese es el propio webterm; reinicialo desde systemd.' });
  try { process.kill(pid, sig); fsAudit('proc_kill', req, { pid, signal: sig }); res.json({ ok: true }); }
  catch (e) { res.status(e.code === 'ESRCH' ? 404 : 403).json({ error: e.code === 'ESRCH' ? 'El proceso ya no existe' : 'Sin permiso para terminar ese proceso' }); }
});
app.get('/api/fs/thumb', async (req, res) => {
  try {
    const p = absPath(req.query.path), st = await fsp.stat(p);
    fs.mkdirSync(THUMB_DIR, { recursive: true, mode: 0o700 });
    const out = await thumbs.thumbFor(THUMB_DIR, p, st);
    if (!out) return res.status(404).json({ error: 'Sin miniatura' });
    res.type('image/webp').sendFile(out, { cacheControl: false, headers: { 'Cache-Control': 'private, max-age=86400' } });
  } catch (e) { fsFail(res, e.code ? e : Object.assign(e, { status: 404 })); }
});
app.get('/api/fs/view', async (req, res) => { // vista previa de imágenes en línea (no descarga)
  try {
    const p = absPath(req.query.path), st = await fsp.stat(p);
    if (!st.isFile() || !thumbs.isImage(p)) throw httpErr(400, 'Solo se pueden previsualizar imágenes');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:");
    fsAudit('fs_view', req, { path: p, size: st.size });
    res.sendFile(p, { dotfiles: 'allow', cacheControl: false, headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (e) { fsFail(res, e); }
});
app.get('/api/sessions', (req, res) => {
  const mine = sessionFrom(req), now = Date.now(), devs = readJson(DEVICES_FILE);
  res.json({
    sessions: [...sessions].filter(([, v]) => v.user === req.user).map(([k, v]) => ({ id: k.slice(0, 16), current: k === mine.sid, ip: v.ip || null, ua: v.ua || '', created: v.created || v.last, last: v.last })),
    devices: Object.entries(devs).filter(([, v]) => v.user === req.user && v.exp > now).map(([k, v]) => ({ id: k.slice(0, 16), ip: v.ip, ua: v.ua || '', created: v.created, exp: v.exp })),
  });
});
app.post('/api/sessions/revoke', (req, res) => {
  const id = String(req.body?.id || ''), kind = req.body?.kind === 'device' ? 'device' : 'session';
  if (!/^[0-9a-f]{16}$/.test(id)) return res.status(400).json({ error: 'Identificador inválido' });
  if (kind === 'session') {
    const k = [...sessions.keys()].find((x) => x.startsWith(id) && sessions.get(x).user === req.user);
    if (!k) return res.status(404).json({ error: 'No existe' }); sessions.delete(k); saveSessions();
  } else {
    const all = readJson(DEVICES_FILE), k = Object.keys(all).find((x) => x.startsWith(id) && all[x].user === req.user);
    if (!k) return res.status(404).json({ error: 'No existe' }); delete all[k]; writeJson(DEVICES_FILE, all);
  }
  fsAudit('session_revoked', req, { kind, id }); res.json({ ok: true });
});
app.get('/api/capabilities', (req, res) => res.json({ thumbs: thumbs.caps }));
thumbs.cleanup(THUMB_DIR);

// ---------- servidor + websocket ----------
// HTTPS: certificado indicado por TLS_CERT/TLS_KEY o, si existe, el autofirmado de data/tls (node setup.js tls)
const tlsCert = process.env.TLS_CERT || path.join(TLS_DIR, 'cert.pem');
const tlsKey = process.env.TLS_KEY || path.join(TLS_DIR, 'key.pem');
const USE_TLS = fs.existsSync(tlsCert) && fs.existsSync(tlsKey);
let server;
if (USE_TLS) {
  server = https.createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey), minVersion: 'TLSv1.2' }, app);
} else {
  server = http.createServer(app);
}
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const m = /^\/ws\/([0-9a-f]{12})$/.exec((req.url || '').split('?')[0]);
  const s = sessionFrom(req);
  if (!m || !s || !sameOrigin(req) || !req.headers.origin || !panes.has(m[1])) {
    audit('ws_denied', { ip: ipOf(req), origin: req.headers.origin || null, authed: !!s });
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, m[1], s.user, ipOf(req)));
});
// ---------- no suspender la PC mientras haya alguien conectado ----------
// Se pide un bloqueo de suspensión que se renueva cada INHIBIT_SECS mientras haya conexiones; si el servidor muriera de golpe, caduca solo.
// Estrategias, en orden: GNOME (gnome-session-inhibit, no requiere permisos) y logind (systemd-inhibit, que en algunos equipos exige polkit).
// Solo evita la suspensión automática por inactividad; cerrar la tapa o suspender a mano no se bloquea. Se desactiva con WEBTERM_NO_INHIBIT=1.
const INHIBIT_SECS = +process.env.WEBTERM_INHIBIT_SECS || 150;
const have = (c) => require('child_process').spawnSync('which', [c]).status === 0;
const INHIBIT_CMDS = process.env.WEBTERM_NO_INHIBIT === '1' ? [] : [
  have('gnome-session-inhibit') && ['gnome-session-inhibit', '--inhibit', 'suspend', '--reason', 'Sesión remota de webterm conectada', 'sleep', String(INHIBIT_SECS)],
  have('systemd-inhibit') && ['systemd-inhibit', '--what=sleep', '--who=webterm', '--why=Sesión remota conectada', '--mode=block', 'sleep', String(INHIBIT_SECS)],
].filter(Boolean);
let nClients = 0, inhibitProc = null, inhibitIdx = 0;
function updateInhibit() {
  if (nClients < 1 || inhibitProc || inhibitIdx >= INHIBIT_CMDS.length) return;
  const [cmd, ...args] = INHIBIT_CMDS[inhibitIdx], t0 = Date.now();
  const p = require('child_process').spawn(cmd, args, { stdio: 'ignore' });
  inhibitProc = p;
  const done = () => {
    if (inhibitProc !== p) return; inhibitProc = null;
    if (Date.now() - t0 < 2000) { inhibitIdx++; if (inhibitIdx >= INHIBIT_CMDS.length) console.error('No se pudo bloquear la suspensión de la PC; la función queda desactivada.'); }
    updateInhibit(); // probar la siguiente estrategia, o renovar si sigue habiendo clientes
  };
  p.on('exit', done); p.on('error', done);
}
process.on('exit', () => { try { inhibitProc?.kill(); } catch {} });
function attach(ws, id, user, ip) {
  nClients++; updateInhibit(); let counted = true;
  const uncount = () => { if (counted) { counted = false; nClients--; } };
  ws.on('close', uncount); ws.on('error', uncount);
  const pane = panes.get(id);
  ws.remoteIp = ip;
  audit('attach', { user, ip, pane: id });
  pane.clients.add(ws);
  ws.send(JSON.stringify({ t: 'o', d: pane.buf.join(''), replay: true }));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === 'i' && typeof m.d === 'string') pane.pty.write(m.d);
    else if (m.t === 'r' && m.c > 0 && m.r > 0 && m.c < 1000 && m.r < 500) {
      try { pane.pty.resize(m.c | 0, m.r | 0); } catch {}
    }
  });
  ws.on('close', () => { pane.clients.delete(ws); audit('detach', { user, ip, pane: id }); });
  ws.on('error', () => pane.clients.delete(ws));
}

function listenAll() {
  const done = () => console.log(`webterm escuchando en ${USE_TLS ? 'https' : 'http'}://${HOST}:${PORT}${USE_TLS ? ' (HTTP en el mismo puerto redirige a HTTPS)' : ''}`);
  if (!USE_TLS) return server.listen(PORT, HOST, done);
  // Mismo puerto para ambos: se mira el primer byte (0x16 = inicio de un handshake TLS); lo demás es HTTP plano y se redirige.
  const redirect = http.createServer((req, res) => {
    const host = String(req.headers.host || '');
    try {
      if (!/^[A-Za-z0-9.\-:\[\]]{1,255}$/.test(host)) { res.writeHead(400); return res.end('Solicitud inválida'); }
      res.writeHead(308, { Location: `https://${host}${req.url}`, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`Este sitio usa HTTPS: https://${host}\n`);
    } catch { try { res.writeHead(400); res.end(); } catch {} }
  });
  redirect.on('clientError', (e, sock) => sock.destroy());
  net.createServer((sock) => {
    sock.setTimeout(15000, () => sock.destroy());
    sock.on('error', () => {});
    sock.once('data', (buf) => {
      sock.setTimeout(0); sock.pause(); sock.unshift(buf);
      (buf[0] === 0x16 ? server : redirect).emit('connection', sock);
      process.nextTick(() => sock.resume());
    });
  }).listen(PORT, HOST, done);
}
(async () => { if (PERSIST) await initPersistence(); listenAll(); })();
// Con persistencia, apagar el servidor NO cierra las terminales (siguen en el demonio). Sin ella, sí.
const bye = () => { if (!hub) for (const id of panes.keys()) killPane(id); process.exit(0); };
process.on('SIGTERM', bye); process.on('SIGINT', bye);
