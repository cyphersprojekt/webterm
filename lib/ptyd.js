'use strict';
// Demonio que mantiene vivas las shells (PTYs) aunque se reinicie el servidor web.
// Habla con el servidor por un socket Unix (JSON por línea). Guarda la salida reciente de cada terminal
// para que, al reconectar, el servidor recupere lo que se veía. Se cierra solo si pasa un rato sin terminales.
const net = require('net');
const fs = require('fs');
const pty = require('node-pty');

const SOCK = process.env.WEBTERM_PTYD_SOCK;
const MAX = 256 * 1024, IDLE_MS = 60000;
if (!SOCK) process.exit(2);

const panes = new Map(); // id -> {p, buf:[], size, meta}
let client = null, attached = false, lastBusy = Date.now();
const send = (m) => { if (client && !client.destroyed) client.write(JSON.stringify(m) + '\n'); };

function spawnPane(m) {
  try {
    const p = pty.spawn(m.shell, m.args || [], { name: 'xterm-256color', cols: m.cols || 80, rows: m.rows || 24, cwd: m.cwd, env: m.env });
    const pane = { p, buf: [], size: 0, meta: m.meta || {} };
    panes.set(m.id, pane);
    p.onData((d) => {
      pane.buf.push(d); pane.size += d.length;
      while (pane.size > MAX && pane.buf.length > 1) pane.size -= pane.buf.shift().length;
      if (attached) send({ t: 'o', id: m.id, d });
    });
    p.onExit(({ exitCode }) => { panes.delete(m.id); lastBusy = Date.now(); send({ t: 'x', id: m.id, code: exitCode }); });
    send({ t: 'spawned', id: m.id, pid: p.pid });
  } catch (e) { send({ t: 'err', id: m.id, error: String(e.message) }); }
}

function onMessage(m) {
  lastBusy = Date.now();
  const pane = m.id && panes.get(m.id);
  switch (m.op) {
    case 'list': // el servidor se (re)conecta: entregar el estado y recién ahí empezar a transmitir
      send({ t: 'list', panes: [...panes].map(([id, x]) => ({ id, pid: x.p.pid, meta: x.meta, cols: x.p.cols, rows: x.p.rows, buf: x.buf.join('') })) });
      attached = true; break;
    case 'spawn': spawnPane(m); break;
    case 'in': if (pane && typeof m.d === 'string') pane.p.write(m.d); break;
    case 'resize': if (pane) { try { pane.p.resize(m.c | 0, m.r | 0); } catch {} } break;
    case 'kill': if (pane) { try { pane.p.kill(); } catch {} } break;
    case 'quit': shutdown(); break;
  }
}

function shutdown() {
  for (const x of panes.values()) { try { x.p.kill(); } catch {} }
  try { fs.unlinkSync(SOCK); } catch {}
  setTimeout(() => process.exit(0), 150);
}

function serve() {
  const server = net.createServer((sock) => {
    if (client) client.destroy(); // un solo servidor a la vez: el más nuevo reemplaza al anterior
    client = sock; attached = false;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { onMessage(JSON.parse(line)); } catch { /* línea inválida */ } }
    });
    const gone = () => { if (client === sock) { client = null; attached = false; lastBusy = Date.now(); } };
    sock.on('close', gone); sock.on('error', gone);
  });
  server.listen(SOCK, () => { try { fs.chmodSync(SOCK, 0o600); } catch {} });
  setInterval(() => { if (!panes.size && !client && Date.now() - lastBusy > IDLE_MS) shutdown(); }, 15000).unref();
}

// ¿ya hay otro demonio vivo en ese socket?
const probe = net.connect(SOCK);
probe.on('connect', () => { probe.destroy(); process.exit(0); });
probe.on('error', () => { try { fs.unlinkSync(SOCK); } catch {} serve(); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
