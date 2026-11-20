'use strict';
// Cliente del demonio de terminales (lib/ptyd.js): lo arranca si hace falta y expone cada terminal como un objeto
// con la misma interfaz que node-pty (onData, onExit, write, resize, kill, pid).
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class RemotePty {
  constructor(hub, id) { this.hub = hub; this.id = id; this.pid = null; this._data = []; this._exit = []; }
  onData(cb) { this._data.push(cb); }
  onExit(cb) { this._exit.push(cb); }
  write(d) { this.hub._send({ op: 'in', id: this.id, d }); }
  resize(c, r) { this.hub._send({ op: 'resize', id: this.id, c, r }); }
  kill() { this.hub._send({ op: 'kill', id: this.id }); }
}

class PtyHub {
  constructor(sockPath, cwd) { this.sockPath = sockPath; this.cwd = cwd; this.sock = null; this.ptys = new Map(); this._waiters = []; }
  get connected() { return !!this.sock && !this.sock.destroyed; }
  _send(m) { if (this.connected) this.sock.write(JSON.stringify(m) + '\n'); }
  _tryConnect() {
    return new Promise((resolve, reject) => { const s = net.connect(this.sockPath); s.once('connect', () => resolve(s)); s.once('error', reject); });
  }
  // Conecta; si el demonio no está, lo lanza (desacoplado del servidor) y espera a que acepte conexiones.
  async ensure() {
    if (this.connected) return;
    let s;
    try { s = await this._tryConnect(); } catch {
      const child = spawn(process.execPath, [path.join(__dirname, 'ptyd.js')], {
        detached: true, stdio: 'ignore', cwd: this.cwd, env: { ...process.env, WEBTERM_PTYD_SOCK: this.sockPath } });
      child.unref();
      for (let i = 0; i < 50 && !s; i++) { await new Promise((r) => setTimeout(r, 100)); try { s = await this._tryConnect(); } catch {} }
      if (!s) throw new Error('No se pudo iniciar el demonio de terminales');
    }
    this.sock = s; s.setEncoding('utf8');
    let buf = '';
    s.on('data', (chunk) => {
      buf += chunk; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { this._onMessage(JSON.parse(line)); } catch {} }
    });
    const lost = () => {
      if (this.sock !== s) return; this.sock = null;
      for (const p of this.ptys.values()) p._exit.forEach((cb) => cb({ exitCode: -1 })); // las terminales se pierden si el demonio cae
      this.ptys.clear();
    };
    s.on('close', lost); s.on('error', lost);
  }
  // Pide el estado al demonio: terminales vivas con su salida reciente (se llama al arrancar el servidor).
  list() {
    return new Promise((resolve, reject) => {
      this._waiters.push({ t: 'list', resolve }); this._send({ op: 'list' });
      setTimeout(() => reject(new Error('el demonio no respondió')), 5000).unref();
    });
  }
  adopt(id, pid) { const p = new RemotePty(this, id); p.pid = pid; this.ptys.set(id, p); return p; }
  spawnPty(id, opts) {
    const p = new RemotePty(this, id); this.ptys.set(id, p);
    this._send({ op: 'spawn', id, ...opts });
    return p;
  }
  quit() { this._send({ op: 'quit' }); }
  _onMessage(m) {
    if (m.t === 'list') { const w = this._waiters.findIndex((x) => x.t === 'list'); if (w >= 0) this._waiters.splice(w, 1)[0].resolve(m.panes); return; }
    const p = this.ptys.get(m.id); if (!p) return;
    if (m.t === 'o') p._data.forEach((cb) => cb(m.d));
    else if (m.t === 'spawned') p.pid = m.pid;
    else if (m.t === 'x') { this.ptys.delete(m.id); p._exit.forEach((cb) => cb({ exitCode: m.code })); }
    else if (m.t === 'err') { this.ptys.delete(m.id); p._exit.forEach((cb) => cb({ exitCode: -1 })); }
  }
}
module.exports = { PtyHub };
