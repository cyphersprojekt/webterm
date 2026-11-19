'use strict';
// webterm — terminal web multi-sesión (estilo Tilix) con xterm.js + node-pty.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const PORT = parseInt(process.env.PORT || '8022', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA = process.env.WEBTERM_DATA || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA, 'users.json');
const LAYOUT_FILE = path.join(DATA, 'layouts.json');
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
const sessions = new Map(); // sid -> {user, last}
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
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.last > SESSION_TTL) { sessions.delete(sid); return null; }
  s.last = Date.now();
  return { sid, user: s.user };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.last > SESSION_TTL) sessions.delete(k);
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
function newPane(fromId, user) {
  let cwd = process.env.HOME || '/';
  const src = fromId && panes.get(fromId);
  if (src) { try { cwd = fs.readlinkSync(`/proc/${src.pty.pid}/cwd`); } catch {} }
  const shell = process.env.SHELL || '/bin/bash';
  const id = crypto.randomBytes(6).toString('hex');
  const nonce = crypto.randomBytes(12).toString('hex');
  const isBash = path.basename(shell) === 'bash';
  const p = pty.spawn(shell, isBash ? ['--rcfile', path.join(__dirname, 'shell', 'bashrc.webterm'), '-i'] : [], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', WEBTERM_NONCE: nonce },
  });
  const pane = { pty: p, buf: [], size: 0, clients: new Set(), user, nonce, tail: '' };
  audit('pane_new', { user, pane: id, cwd, shell, cmd_logging: isBash });
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
  return id;
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
app.use(express.json({ limit: '256kb' }));

const isSecure = (req) => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';

app.get('/login', (req, res) => {
  if (sessionFrom(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.post('/login', (req, res) => {
  const ip = ipOf(req);
  const wait = lockedFor(ip);
  if (wait) { audit('login_blocked', { ip, wait_s: wait }); return res.status(429).json({ error: `Demasiados intentos. Esperá ${wait}s.` }); }
  const { user, password } = req.body || {};
  if (typeof user !== 'string' || typeof password !== 'string' || !user || password.length > 512
      || !verifyPassword(user, password)) {
    registerFail(ip);
    audit('login_fail', { ip, user: typeof user === 'string' ? user.slice(0, 64) : null, ua: (req.headers['user-agent'] || '').slice(0, 120) });
    return setTimeout(() => res.status(401).json({ error: 'Usuario o contraseña incorrectos.' }), 600);
  }
  fails.delete(ip);
  audit('login_ok', { ip, user, ua: (req.headers['user-agent'] || '').slice(0, 120) });
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { user, last: Date.now() });
  res.setHeader('Set-Cookie',
    `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${isSecure(req) ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/logout', (req, res) => {
  const s = sessionFrom(req);
  if (s) { audit('logout', { ip: ipOf(req), user: s.user }); sessions.delete(s.sid); }
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/vendor/links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));
app.get('/favicon.svg', (req, res) => res.type('image/svg+xml').sendFile(path.join(__dirname, 'public', 'favicon.svg')));
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

app.get('/api/state', (req, res) => {
  res.json({ user: req.user, layout: loadLayouts()[req.user] || null, panes: [...panes.keys()] });
});
app.put('/api/layout', (req, res) => { saveLayout(req.user, req.body); res.json({ ok: true }); });
app.post('/api/panes', (req, res) => {
  const from = typeof req.body?.from === 'string' ? req.body.from : null;
  res.json({ id: newPane(from, req.user) });
});
app.delete('/api/panes/:id', (req, res) => { killPane(req.params.id); res.json({ ok: true }); });

// ---------- servidor + websocket ----------
let server;
if (process.env.TLS_CERT && process.env.TLS_KEY) {
  server = https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, app);
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
function attach(ws, id, user, ip) {
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

server.listen(PORT, HOST, () => {
  const proto = process.env.TLS_CERT ? 'https' : 'http';
  console.log(`webterm escuchando en ${proto}://${HOST}:${PORT}`);
});
process.on('SIGTERM', () => { for (const id of panes.keys()) killPane(id); process.exit(0); });
