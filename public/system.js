'use strict';
// Panel lateral "Sistema": estado del equipo (CPU, memoria, discos, procesos) y registro de actividad (auditoría).
const SY = { el: $('#sys'), depth: 0, tab: 'status', timer: null, logTimer: null, cat: '', q: '', me: null, qT: 0 };
const fmtB = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return (i ? n.toFixed(n < 10 ? 1 : 0) : Math.round(n)) + ' ' + u[i]; };
const fmtUp = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + ' d ' : '') + (h || d ? h + ' h ' : '') + m + ' min'; };
const fmtAge = (s) => (s >= 86400 ? Math.floor(s / 86400) + 'd' : s >= 3600 ? Math.floor(s / 3600) + 'h' : s >= 60 ? Math.floor(s / 60) + 'm' : s + 's');
function h(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function bar(pct, warn = 80, crit = 92) {
  const b = h('div', 'sbar'), i = h('i'); i.style.width = Math.max(1, Math.min(100, pct)) + '%';
  i.className = pct >= crit ? 'crit' : pct >= warn ? 'warn' : ''; b.appendChild(i); return b;
}
function card(title, ...kids) { const c = h('section', 'scard'); c.appendChild(h('h4', '', title)); kids.forEach((k) => k && c.appendChild(k)); return c; }
function line(label, value, cls) { const r = h('div', 'sline'); r.append(h('span', '', label), h('b', cls || '', value)); return r; }

// ---------- estado ----------
async function loadStatus() {
  try {
    const d = await api('GET', '/api/status'); SY.me = d.me;
    const root = $('#sbody-status'), keep = root.scrollTop; root.textContent = '';
    const memUsed = d.mem.total - d.mem.avail, memPct = 100 * memUsed / d.mem.total;
    root.append(
      card('Equipo', line('Nombre', d.host), line('Sistema', d.os), line('Kernel', d.kernel), line('Encendido hace', fmtUp(d.uptime))),
      card('CPU', line('Uso', d.cpu === null ? '—' : d.cpu.toFixed(0) + ' %'), d.cpu === null ? null : bar(d.cpu, 70, 90),
        line('Carga (1 · 5 · 15 min)', d.load.map((x) => x.toFixed(2)).join(' · ') + `  (${d.cores} núcleos)`),
        d.temp === null ? null : line('Temperatura', d.temp.toFixed(0) + ' °C', d.temp >= 85 ? 'crit' : d.temp >= 75 ? 'warn' : '')),
      card('Memoria', line('En uso', `${fmtB(memUsed)} de ${fmtB(d.mem.total)}`), bar(memPct),
        d.mem.swapTotal ? line('Swap', `${fmtB(d.mem.swapTotal - d.mem.swapFree)} de ${fmtB(d.mem.swapTotal)}`) : null,
        d.mem.swapTotal ? bar(100 * (d.mem.swapTotal - d.mem.swapFree) / d.mem.swapTotal, 50, 80) : null),
      card('Discos', ...d.disks.flatMap((k) => { const pct = 100 * k.used / k.size; return [line(k.mount, `${fmtB(k.used)} de ${fmtB(k.size)} · ${pct.toFixed(0)} %`), bar(pct)]; })),
    );
    const bad = [...d.failed.system.map((x) => x), ...d.failed.user.map((x) => x + ' (usuario)')];
    root.append(card('Servicios', bad.length ? line('Con fallas', bad.join(', '), 'crit') : line('systemd', 'Sin servicios fallidos', 'ok')));
    // procesos
    const t = h('table', 'sproc'); const hd = h('tr'); ['PID', 'CPU', 'MEM', 'Hace', 'Comando', ''].forEach((x) => hd.appendChild(h('th', '', x))); t.appendChild(hd);
    for (const p of d.procs) {
      const tr = h('tr'); tr.append(h('td', 'mono', p.pid), h('td', '', p.cpu.toFixed(1) + '%'), h('td', '', p.mem.toFixed(1) + '%'), h('td', '', fmtAge(p.age)), h('td', 'cmd', p.cmd));
      const td = h('td'); if (p.user === d.me && p.pid !== d.webterm.pid) { const k = h('button', 'kill', '✕'); k.title = `Terminar el proceso ${p.pid}`; k.onclick = () => killProc(p); td.appendChild(k); }
      tr.appendChild(td); t.appendChild(tr);
    }
    root.append(card('Procesos que más CPU usan', t));
    root.append(card('webterm', line('Terminales abiertas', String(d.webterm.panes)), line('Conexiones', d.webterm.tls ? 'HTTPS' : 'HTTP sin cifrar', d.webterm.tls ? 'ok' : 'warn'),
      line('Segundo factor por correo', d.webterm.twofa ? 'configurado' : 'sin configurar'), line('Node.js', d.webterm.node)));
    root.scrollTop = keep;
  } catch (e) { if (e.message !== 'auth') { const r = $('#sbody-status'); r.textContent = ''; r.appendChild(h('div', 'fempty', 'No se pudo leer el estado: ' + e.message)); } }
}
async function killProc(p) {
  const r = await fdlg({ title: `Terminar proceso ${p.pid}`, text: p.cmd, buttons: [BTN_CANCEL, { label: 'Terminar (TERM)', action: 'TERM', cls: 'primary' }, { label: 'Forzar (KILL)', action: 'KILL', cls: 'danger' }], stack: true });
  if (!r || r.action === 'cancel') return;
  try { await api('POST', '/api/proc/kill', { pid: p.pid, signal: r.action }); } catch (e) { alert(e.message); }
  setTimeout(loadStatus, 500);
}

// ---------- registro ----------
const CATS = [['', 'Todo'], ['alerts', 'Alertas'], ['access', 'Accesos'], ['cmd', 'Comandos'], ['files', 'Archivos'], ['panes', 'Terminales'], ['system', 'Sistema']];
const catOf = (ev) => /^(login_fail|login_blocked|login_2fa_fail|login_2fa_error|ws_denied)/.test(ev) ? 'alert'
  : /^(login_|logout|attach|detach)/.test(ev) ? 'access' : ev === 'cmd' ? 'cmd' : /^fs_/.test(ev) ? 'files' : /^pane_/.test(ev) ? 'panes' : 'system';
const base = (p) => String(p || '').split('/').filter(Boolean).pop() || p;
function describe(e) {
  const who = e.user || '?', ip = e.ip ? ` desde ${e.ip}` : '';
  switch (e.ev) {
    case 'login_ok': return `${who} inició sesión${ip}${e.twofa ? ' (con código por correo)' : ''}`;
    case 'login_fail': return `Contraseña incorrecta para «${who}»${ip}`;
    case 'login_blocked': return `Acceso bloqueado${ip}: demasiados intentos (${e.wait_s}s)`;
    case 'login_2fa_sent': return `Código enviado a ${e.to} (${who})`;
    case 'login_2fa_fail': return `Código incorrecto para «${who}»${ip}`;
    case 'login_2fa_error': return `Falló el envío del código a «${who}»: ${e.error}`;
    case 'logout': return `${who} cerró sesión${ip}`;
    case 'attach': return `${who} se conectó a la terminal ${String(e.pane).slice(0, 4)}${ip}`;
    case 'detach': return `${who} se desconectó de la terminal ${String(e.pane).slice(0, 4)}`;
    case 'ws_denied': return `Conexión de terminal rechazada${ip}${e.authed ? '' : ' (sin sesión)'}`;
    case 'pane_new': return `Nueva terminal ${String(e.pane).slice(0, 4)} de ${who} en ${e.cwd}`;
    case 'pane_close': return `${who} cerró la terminal ${String(e.pane).slice(0, 4)}`;
    case 'pane_exit': return `La terminal ${String(e.pane).slice(0, 4)} terminó`;
    case 'cmd': return e.cmd;
    case 'fs_upload': return `${who} subió ${e.path} (${fmtB(e.size || 0)})${ip}`;
    case 'fs_download': return `${who} descargó ${e.path}${e.folder ? ' (carpeta)' : e.size ? ` (${fmtB(e.size)})` : ''}${ip}`;
    case 'fs_view': return `${who} vio ${e.path}${ip}`;
    case 'fs_mkdir': return `${who} creó la carpeta ${e.path}`;
    case 'fs_rename': return `${who} renombró ${base(e.from)} → ${base(e.to)} en ${String(e.to).replace(/\/[^/]*$/, '') || '/'}`;
    case 'fs_delete': return `${who} borró ${e.path}${e.folder ? ' (carpeta)' : ''}${ip}`;
    case 'proc_kill': return `${who} envió ${e.signal} al proceso ${e.pid}${ip}`;
    default: return `${e.ev} ${JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'ts' && k !== 'ev')))}`;
  }
}
async function loadLog() {
  try {
    const d = await api('GET', `/api/audit?limit=300&cat=${encodeURIComponent(SY.cat)}&q=${encodeURIComponent(SY.q)}`);
    const list = $('#slog'), keep = list.scrollTop; list.textContent = '';
    if (!d.entries.length) list.appendChild(h('div', 'fempty', 'Sin eventos para este filtro'));
    let day = '';
    for (const e of d.entries) {
      const t = new Date(e.ts), dd = t.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      if (dd !== day) { day = dd; list.appendChild(h('div', 'lday', dd)); }
      const cat = catOf(e.ev), row = h('div', 'lrow ' + cat);
      row.append(h('span', 'ltime', t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })), h('span', 'ltxt' + (e.ev === 'cmd' ? ' mono' : ''), describe(e)));
      if (e.ev === 'cmd') row.appendChild(h('span', 'lwho', `${e.user || ''}${e.from?.length ? ' · ' + e.from.join(', ') : ''}`));
      list.appendChild(row);
    }
    list.scrollTop = keep;
  } catch (e) { if (e.message !== 'auth') $('#slog').textContent = 'No se pudo leer el registro: ' + e.message; }
}
(function buildLogBar() {
  const bar = $('#slogbar');
  const chips = h('div', 'schips');
  for (const [k, label] of CATS) { const b = h('button', k === SY.cat ? 'on' : '', label); b.dataset.cat = k; b.onclick = () => { SY.cat = k; chips.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); loadLog(); }; chips.appendChild(b); }
  const q = h('input'); q.type = 'search'; q.placeholder = 'Buscar (usuario, IP, comando, ruta…)'; q.autocomplete = 'off'; q.spellcheck = false;
  q.oninput = () => { clearTimeout(SY.qT); SY.qT = setTimeout(() => { SY.q = q.value; loadLog(); }, 300); };
  const live = h('label', 'slive'); const cb = h('input'); cb.type = 'checkbox'; live.append(cb, document.createTextNode(' En vivo'));
  cb.onchange = () => { clearInterval(SY.logTimer); if (cb.checked) SY.logTimer = setInterval(loadLog, 4000); };
  const rf = h('button', '', 'Actualizar'); rf.onclick = loadLog;
  const row = h('div', 'srow'); row.append(q, live, rf);
  bar.append(chips, row);
})();

// ---------- abrir / cerrar ----------
function sysTab(tab) {
  SY.tab = tab;
  SY.el.querySelectorAll('[data-st]').forEach((b) => b.classList.toggle('on', b.dataset.st === tab));
  $('#sbody-status').hidden = tab !== 'status'; $('#sbody-log').hidden = tab !== 'log';
  clearInterval(SY.timer); clearInterval(SY.logTimer); $('#sbody-log input[type=checkbox]').checked = false;
  if (tab === 'status') { loadStatus(); SY.timer = setInterval(loadStatus, 3000); } else loadLog();
}
function openSys(tab) {
  if (!F.el.hidden) return; // un solo panel lateral a la vez
  if (SY.el.hidden) { SY.el.hidden = false; SY.depth = 1; history.pushState({ wt: 'sys' }, ''); }
  sysTab(tab);
}
function hideSys() { if (!SY.el.hidden) { SY.el.hidden = true; clearInterval(SY.timer); clearInterval(SY.logTimer); panes.get(focusedId())?.term.focus(); } }
function closeSys() { const d = SY.depth; SY.depth = 0; hideSys(); if (d) history.go(-1); }
addEventListener('popstate', (e) => { if (e.state && e.state.wt === 'sys') { SY.depth = 1; if (SY.el.hidden) { SY.el.hidden = false; sysTab(SY.tab); } } else { SY.depth = 0; hideSys(); } });
SY.el.addEventListener('click', (e) => {
  const t = e.target.closest('[data-st]'); if (t) return sysTab(t.dataset.st);
  if (e.target.closest('[data-sa=close]')) closeSys();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !SY.el.hidden && !document.querySelector('dialog[open]')) { e.stopPropagation(); closeSys(); } }, true);
actions.status = () => (SY.el.hidden || SY.tab !== 'status' ? openSys('status') : closeSys());
actions.log = () => (SY.el.hidden || SY.tab !== 'log' ? openSys('log') : closeSys());
