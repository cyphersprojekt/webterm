'use strict';
// Cliente webterm. Modelo:
//   sessions: [{id, name, root, focus}]   (cada sesión = una "pestaña" estilo Tilix)
//   root: {pane:id} | {dir:'row'|'col', ratio:0..1, a:node, b:node}
const $ = (s) => document.querySelector(s);
const stage = $('#stage'), tabsEl = $('#tabs'), statusEl = $('#status');
const decodeKey = (s) => s.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\t/g, '\t');

let sessions = [];
let active = null;
let fontSize = +localStorage.getItem('fontSize') || 14;
const panes = new Map(); // id -> {el, term, fit, ws, retry}
const mods = { ctrl: 0, alt: 0 }; // 0 off, 1 one-shot, 2 locked

// ---------- API ----------
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  if (r.status === 401) { location.href = '/login'; throw new Error('auth'); }
  return r.json();
}
let saveTimer;
function saveLayout() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api('PUT', '/api/layout', { sessions, active }).catch(() => {}), 400);
}

// ---------- árbol ----------
const uid = () => Math.random().toString(36).slice(2, 8);
function leaves(n, out = []) { if (n.pane) out.push(n.pane); else { leaves(n.a, out); leaves(n.b, out); } return out; }
function replaceNode(n, id, fn) {
  if (n.pane) return n.pane === id ? fn(n) : n;
  return { ...n, a: replaceNode(n.a, id, fn), b: replaceNode(n.b, id, fn) };
}
function removeLeaf(n, id) { // devuelve null si el árbol queda vacío
  if (n.pane) return n.pane === id ? null : n;
  const a = removeLeaf(n.a, id), b = removeLeaf(n.b, id);
  if (!a) return b; if (!b) return a;
  return { ...n, a, b };
}
const curSession = () => sessions.find((s) => s.id === active);
const focusedId = () => curSession()?.focus;

// ---------- panes ----------
function createPaneView(id) {
  const el = document.createElement('div');
  el.className = 'pane';
  const term = new Terminal({
    fontSize, cursorBlink: true, scrollback: 5000, allowProposedApi: true,
    fontFamily: '"JetBrains Mono","Fira Code",ui-monospace,Menlo,Consolas,monospace',
    theme: { background: '#000000', foreground: '#f8f8f2', cursor: '#f8f8f2' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(el);
  // Teclados móviles: sin sugerencias/autocorrección (si no, reenvían texto ya escrito al aceptar una sugerencia)
  const ta = term.textarea;
  if (ta) {
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'none');
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('enterkeyhint', 'send');
    ta.setAttribute('data-gramm', 'false');
    if (COARSE) { // la entrada táctil va por nuestro propio campo (ver setupIme)
      ta.readOnly = true; ta.inputMode = 'none';
      ta.addEventListener('focus', () => { if (kbWanted && ime) ime.focus(); else ta.blur(); }); // el teclado solo se abre con su botón
    }
  }
  const pane = { id, el, term, fit, ws: null, retry: 0, dead: false };
  term.onData((d) => send(pane, applyMods(d)));
  term.onResize(({ cols, rows }) => wsSend(pane, { t: 'r', c: cols, r: rows }));
  term.attachCustomKeyEventHandler((e) => shortcut(e));
  el.addEventListener('pointerdown', (e) => {
    if (COARSE && e.pointerType === 'touch') { e.preventDefault(); lastPaneTap = performance.now(); } // tocar un panel lo selecciona, sin tocar el teclado
    focusPane(id);
  }, true);
  enableTouchScroll(pane);
  new ResizeObserver(() => refit(pane)).observe(el);
  panes.set(id, pane);
  connect(pane);
  return pane;
}
// Scroll táctil: arrastre vertical. Historial normal → term.scrollLines; pantalla alternativa (less, vim) o
// reporte de mouse (Claude Code, tmux) → eventos de rueda, que xterm.js traduce a flechas o a secuencias de mouse.
function enableTouchScroll(pane) {
  const el = pane.el;
  let y0 = null, last = 0, acc = 0, moved = false, vel = 0, lastT = 0, raf = 0;
  const lineH = () => Math.max(8, (el.clientHeight || 300) / (pane.term.rows || 24));
  const wheel = (lines, x, y) => {
    const t = pane.term;
    // historial normal sin reporte de mouse: scroll directo del buffer
    if (t.buffer.active.type === 'normal' && t.modes.mouseTrackingMode === 'none') { t.scrollLines(lines); return; }
    const target = el.querySelector('.xterm-screen'); if (!target) return;
    for (let i = 0; i < Math.min(Math.abs(lines), 30); i++)
      target.dispatchEvent(new WheelEvent('wheel', { deltaY: Math.sign(lines), deltaMode: 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  };
  el.addEventListener('touchstart', (e) => {
    cancelAnimationFrame(raf);
    if (e.touches.length !== 1) { y0 = null; return; }
    y0 = last = e.touches[0].clientY; acc = 0; moved = false; vel = 0; lastT = e.timeStamp;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (y0 === null || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!moved && Math.abs(t.clientY - y0) < 8) return; // umbral: un toque no es un scroll
    moved = true; e.preventDefault();
    const dy = last - t.clientY; last = t.clientY;     // dedo hacia abajo → contenido anterior
    const dt = Math.max(1, e.timeStamp - lastT); lastT = e.timeStamp; vel = 0.8 * vel + 0.2 * (dy / dt);
    acc += dy;
    const n = Math.trunc(acc / lineH());
    if (n) { acc -= n * lineH(); wheel(n, t.clientX, t.clientY); }
  }, { passive: false });
  const end = (e) => {
    if (y0 === null || !moved) { y0 = null; return; }
    y0 = null;
    const t = e.changedTouches[0]; let v = vel * 16; // px por frame
    const fling = () => { // inercia
      if (Math.abs(v) < 0.5) return;
      acc += v; v *= 0.94;
      const n = Math.trunc(acc / lineH());
      if (n) { acc -= n * lineH(); wheel(n, t.clientX, t.clientY); }
      raf = requestAnimationFrame(fling);
    };
    raf = requestAnimationFrame(fling);
  };
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', () => { y0 = null; }, { passive: true });
}
function refit(pane) {
  if (!pane.el.offsetWidth) return;
  clearTimeout(pane.fitT);
  pane.fitT = setTimeout(() => { try { pane.fit.fit(); } catch {} }, 30);
}
function wsSend(pane, msg) { if (pane.ws && pane.ws.readyState === 1) pane.ws.send(JSON.stringify(msg)); }
function send(pane, d) { wsSend(pane, { t: 'i', d }); }
function connect(pane) {
  if (pane.dead) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${pane.id}`);
  pane.ws = ws;
  ws.onopen = () => { pane.retry = 0; setStatus(false); wsSend(pane, { t: 'r', c: pane.term.cols, r: pane.term.rows }); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'o') { if (m.replay) pane.term.reset(); pane.term.write(m.d); }
    else if (m.t === 'x') paneExited(pane.id);
  };
  ws.onclose = async () => {
    if (pane.dead) return;
    setStatus(true);
    try {
      const st = await api('GET', '/api/state'); // 401 → redirige a login
      if (!st.panes.includes(pane.id)) return paneExited(pane.id);
    } catch { /* servidor caído, reintentar */ }
    pane.retry++;
    setTimeout(() => connect(pane), Math.min(5000, 300 * pane.retry));
  };
}
function setStatus(off) { statusEl.hidden = !off; statusEl.textContent = 'Reconectando…'; }
function destroyView(id) {
  const p = panes.get(id); if (!p) return;
  p.dead = true; try { p.ws.close(); } catch {} p.term.dispose(); p.el.remove(); panes.delete(id);
}

// ---------- entrada táctil (IME) ----------
// xterm.js reenvía texto ya escrito con la composición de Gboard. En pantallas táctiles usamos un
// textarea propio que espeja lo que se ve y enviamos al PTY solo la diferencia (borrados + texto nuevo).
const COARSE = matchMedia('(pointer: coarse)').matches;
const SENT = ' '; // centinela: permite detectar un Backspace aunque el buffer esté vacío
let ime = null, imePrev = SENT;
let lastPaneTap = 0; // el navegador quita el foco al tocar un panel: no cuenta como cerrar el teclado
let kbWanted = false; // teclado virtual abierto a pedido del usuario
function refreshKb() { document.querySelectorAll('[data-act=keyboard]').forEach((b) => b.classList.toggle('on', kbWanted)); }
function imeReset() { if (ime) { ime.value = SENT; imePrev = SENT; } }
function setupIme() {
  ime = document.createElement('textarea');
  ime.id = 'ime';
  for (const [k, v] of Object.entries({ autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'send', 'aria-label': 'terminal input' })) ime.setAttribute(k, v);
  ime.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;border:0;padding:0;resize:none;font-size:16px;';
  document.body.appendChild(ime);
  ime.addEventListener('focus', () => { kbWanted = true; refreshKb(); });
  ime.addEventListener('blur', () => {
    if (performance.now() - lastPaneTap < 500) { setTimeout(() => kbWanted && ime.focus(), 0); return; }
    kbWanted = false; refreshKb();
  });
  imeReset();
  const out = (s) => { const p = panes.get(focusedId()); if (p && s) send(p, s); };
  ime.addEventListener('input', (e) => {
    const cur = ime.value;
    let p = 0; const max = Math.min(imePrev.length, cur.length);
    while (p < max && imePrev[p] === cur[p]) p++;
    const del = imePrev.length - p, added = cur.slice(p).replace(/\r?\n/g, '\r');
    out(del ? '\x7f'.repeat(del) + added : added.length === 1 ? applyMods(added) : added);
    if (!e.isComposing && cur.length > 100) imeReset(); else imePrev = cur;
  });
  const keys = { Enter: '\r', Tab: '\t', Escape: '\x1b', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
    Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~', Delete: '\x1b[3~' };
  ime.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (keys[e.key]) { e.preventDefault(); out(applyMods(keys[e.key])); imeReset(); return; }
    if ((e.ctrlKey || e.altKey) && e.key.length === 1) { // teclado físico
      e.preventDefault(); let d = e.key;
      if (e.ctrlKey) { const c = d.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64); }
      out(e.altKey ? '\x1b' + d : d);
    }
  });
  ime.addEventListener('beforeinput', (e) => { if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') { e.preventDefault(); out('\r'); imeReset(); } });
}

// ---------- modificadores (teclado móvil) ----------
function applyMods(d) {
  if (mods.ctrl && d.length === 1) {
    const c = d.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
    else if (d === ' ') d = '\x00';
  }
  if (mods.alt) d = '\x1b' + d;
  for (const k of ['ctrl', 'alt']) if (mods[k] === 1) { mods[k] = 0; }
  refreshMods();
  return d;
}
function refreshMods() {
  document.querySelectorAll('[data-mod]').forEach((b) => b.classList.toggle('on', !!mods[b.dataset.mod]));
}

// ---------- acciones ----------
async function newPaneId(from) { return (await api('POST', '/api/panes', { from })).id; }
async function newSession() {
  const id = await newPaneId(focusedId());
  const s = { id: uid(), name: String(sessions.length + 1), root: { pane: id }, focus: id };
  sessions.push(s); active = s.id; render();
}
async function split(dir) {
  const s = curSession(); if (!s) return;
  const target = s.focus;
  const id = await newPaneId(target);
  s.root = replaceNode(s.root, target, (leaf) => ({ dir, ratio: 0.5, a: leaf, b: { pane: id } }));
  s.focus = id; render();
}
async function closePane(id = focusedId()) {
  await api('DELETE', `/api/panes/${id}`);
  // el cierre real llega por WS ('x') → paneExited
}
function paneExited(id) {
  const s = sessions.find((x) => leaves(x.root).includes(id));
  destroyView(id);
  if (!s) return;
  const order = leaves(s.root);
  s.root = removeLeaf(s.root, id);
  if (!s.root) {
    sessions = sessions.filter((x) => x !== s);
    if (!sessions.length) return newSession();
    if (active === s.id) active = sessions[Math.max(0, Math.min(sessions.length - 1, sessions.indexOf(s)))]?.id || sessions[0].id;
  } else if (s.focus === id) {
    const i = order.indexOf(id), rest = leaves(s.root);
    s.focus = rest[Math.min(i, rest.length - 1)];
  }
  render();
}
function focusPane(id) {
  const s = sessions.find((x) => leaves(x.root).includes(id)); if (!s) return;
  const changed = s.focus !== id;
  s.focus = id;
  document.querySelectorAll('.pane').forEach((el) => el.classList.toggle('focus', el === panes.get(id)?.el));
  panes.get(id)?.term.focus();
  if (changed) saveLayout();
}
function focusDir(dx, dy) {
  const cur = panes.get(focusedId()); if (!cur) return;
  const r = cur.el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, bd = Infinity;
  for (const id of leaves(curSession().root)) {
    if (id === cur.id) continue;
    const q = panes.get(id).el.getBoundingClientRect(), qx = q.left + q.width / 2, qy = q.top + q.height / 2;
    const ddx = qx - cx, ddy = qy - cy;
    if ((dx && Math.sign(ddx) !== dx) || (dy && Math.sign(ddy) !== dy)) continue;
    const dist = dx ? Math.abs(ddx) + 3 * Math.abs(ddy) : Math.abs(ddy) + 3 * Math.abs(ddx);
    if (dist < bd) { bd = dist; best = id; }
  }
  if (best) focusPane(best);
}
function switchSession(delta) {
  const i = sessions.findIndex((s) => s.id === active);
  active = sessions[(i + delta + sessions.length) % sessions.length].id; render();
}
function setFont(delta) {
  fontSize = Math.max(8, Math.min(28, fontSize + delta));
  localStorage.setItem('fontSize', fontSize);
  panes.forEach((p) => { p.term.options.fontSize = fontSize; refit(p); });
}

// atajos de escritorio (estilo Tilix)
function shortcut(e) {
  if (e.type !== 'keydown') return true;
  if (e.ctrlKey && e.altKey) {
    const k = e.key.toLowerCase(), map = { r: () => split('row'), d: () => split('col'), t: newSession, w: () => closePane() };
    if (map[k]) { e.preventDefault(); map[k](); return false; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) { e.preventDefault(); focusDir(...arrows[e.key]); return false; }
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    if (e.key === 'PageUp') { switchSession(-1); return false; }
    if (e.key === 'PageDown') { switchSession(1); return false; }
    if (/^[1-9]$/.test(e.key) && sessions[+e.key - 1]) { active = sessions[+e.key - 1].id; render(); return false; }
  }
  return true;
}

// ---------- render ----------
function render() {
  // tabs
  tabsEl.textContent = '';
  for (const s of sessions) {
    const b = document.createElement('button');
    b.textContent = s.name; b.className = s.id === active ? 'active' : '';
    b.onclick = () => { if (active !== s.id) { active = s.id; render(); } else renameSession(); };
    tabsEl.appendChild(b);
  }
  tabsEl.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  // stage
  while (stage.firstChild) stage.firstChild.remove(); // los panes se re-adjuntan, no se destruyen
  const s = curSession(); if (!s) return;
  stage.appendChild(build(s.root));
  requestAnimationFrame(() => { panes.forEach(refit); focusPane(s.focus); });
  saveLayout();
}
function build(n) {
  if (n.pane) return (panes.get(n.pane) || createPaneView(n.pane)).el;
  const box = document.createElement('div'); box.className = `split ${n.dir}`;
  const a = document.createElement('div'), b = document.createElement('div'), d = document.createElement('div');
  a.className = b.className = 'cell'; d.className = 'divider';
  a.style.flex = `${n.ratio} 1 0`; b.style.flex = `${1 - n.ratio} 1 0`;
  a.appendChild(build(n.a)); b.appendChild(build(n.b));
  d.addEventListener('pointerdown', (ev) => {
    ev.preventDefault(); d.setPointerCapture(ev.pointerId); d.classList.add('drag');
    const move = (e) => {
      const r = box.getBoundingClientRect();
      const ratio = n.dir === 'row' ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
      n.ratio = Math.max(0.1, Math.min(0.9, ratio));
      a.style.flex = `${n.ratio} 1 0`; b.style.flex = `${1 - n.ratio} 1 0`;
    };
    const up = () => { d.classList.remove('drag'); d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', up); saveLayout(); };
    d.addEventListener('pointermove', move); d.addEventListener('pointerup', up);
  });
  box.append(a, d, b);
  return box;
}
function renameSession() {
  const s = curSession(); const n = prompt('Nombre de la sesión', s.name);
  if (n && n.trim()) { s.name = n.trim().slice(0, 24); render(); }
}

// ---------- UI ----------
const actions = {
  newSession, splitRight: () => split('row'), splitDown: () => split('col'), closePane: () => closePane(),
  keyboard: () => { if (!ime) return; if (document.activeElement === ime) ime.blur(); else { kbWanted = true; ime.focus(); } },
  renameSession, fontUp: () => setFont(1), fontDown: () => setFont(-1),
  menu: () => { const m = $('#menu'); m.hidden = !m.hidden; },
  paste: () => { $('#pasteTxt').value = ''; $('#pasteDlg').showModal(); },
  logout: async () => { await fetch('/logout', { method: 'POST' }); location.href = '/login'; },
};
// los botones no deben robar el foco (para no ocultar el teclado del móvil)
document.addEventListener('pointerdown', (e) => { if (e.target.closest('button') && !e.target.closest('dialog')) e.preventDefault(); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.act) { if (b.dataset.act !== 'menu') $('#menu').hidden = true; actions[b.dataset.act]?.(); }
  else if (b.dataset.key) { const p = panes.get(focusedId()); imeReset(); if (p) send(p, applyMods(decodeKey(b.dataset.key))); p?.term.focus(); }
  else if (b.dataset.mod) { const k = b.dataset.mod; mods[k] = mods[k] === 0 ? 1 : mods[k] === 1 ? 2 : 0; refreshMods(); panes.get(focusedId())?.term.focus(); }
});
$('#pasteDlg').addEventListener('close', (e) => {
  if (e.target.returnValue === 'ok') { const p = panes.get(focusedId()); if (p) send(p, $('#pasteTxt').value); }
});
// teclado virtual: ajustar al viewport visible
if (window.visualViewport) {
  const fix = () => { document.documentElement.style.setProperty('--vh', visualViewport.height + 'px'); panes.forEach(refit); };
  visualViewport.addEventListener('resize', fix); fix();
}
window.addEventListener('resize', () => panes.forEach(refit));

// ---------- arranque ----------
if (COARSE) setupIme();
(async () => {
  const st = await api('GET', '/api/state');
  const alive = new Set(st.panes);
  const saved = st.layout;
  if (saved?.sessions) {
    const prune = (n) => {
      if (n.pane) return alive.has(n.pane) ? n : null;
      const a = prune(n.a), b = prune(n.b);
      return a && b ? { ...n, a, b } : a || b;
    };
    sessions = saved.sessions.map((s) => ({ ...s, root: prune(s.root) })).filter((s) => s.root);
    for (const s of sessions) if (!leaves(s.root).includes(s.focus)) s.focus = leaves(s.root)[0];
    active = sessions.find((s) => s.id === saved.active)?.id || sessions[0]?.id;
  }
  // paneles vivos que no están en ningún layout → sesión "recuperada"
  const known = new Set(sessions.flatMap((s) => leaves(s.root)));
  for (const id of alive) if (!known.has(id)) {
    sessions.push({ id: uid(), name: 'rec', root: { pane: id }, focus: id });
    active = active || sessions[sessions.length - 1].id;
  }
  if (!sessions.length) return newSession();
  render();
})();
