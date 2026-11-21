'use strict';
// Extras de la interfaz: maximizar panel, buscar en la terminal, portapapeles, rutas clicables y lanzadores.

// ---------- hook por panel: búsqueda, rutas clicables y botón de maximizar ----------
const PATH_RE = /(^|[\s"'(\[=])((?:~|\.{1,2})?\/[\w.@%+=,:~\/-]{2,})/g;
window.onPaneCreated = (pane) => {
  try { pane.search = new SearchAddon.SearchAddon(); pane.term.loadAddon(pane.search); } catch {}
  // tocar una ruta absoluta (o con ~) en la salida la abre en el explorador de archivos
  pane.term.registerLinkProvider({
    provideLinks(y, cb) {
      const line = pane.term.buffer.active.getLine(y - 1); if (!line) return cb(undefined);
      const text = line.translateToString(true), links = []; PATH_RE.lastIndex = 0; let m;
      while ((m = PATH_RE.exec(text))) {
        const p = m[2].replace(/[.,:;)\]]+$/, ''); if (!/^(~|\/)/.test(p) || p.length < 3) continue;
        const x = m.index + m[1].length + 1;
        links.push({ range: { start: { x, y }, end: { x: x + p.length - 1, y } }, text: p, decorations: { underline: true, pointerCursor: true }, activate: () => openPathInExplorer(p) });
      }
      cb(links);
    },
  });
  const z = document.createElement('button'); z.className = 'zbtn'; z.type = 'button'; z.title = 'Maximizar / restaurar este panel'; z.setAttribute('aria-label', 'Maximizar panel');
  z.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  z.onclick = (e) => { e.stopPropagation(); focusPane(pane.id); toggleZoom(); };
  pane.el.appendChild(z);
};
async function openPathInExplorer(p) {
  if (F.el.hidden) openFiles(p); else await fload(p);
  await sleep(400);
  const name = p.replace(/\/+$/, '').split('/').pop();
  const row = [...document.querySelectorAll('#flist .frow')].find((r) => r.querySelector('b')?.textContent === name);
  if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1800); }
  else if (!F.entries.length || F.cur !== p) { /* si era un archivo, el explorador muestra su carpeta */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// si la ruta es un archivo el servidor no puede listarla: caer a su carpeta
const _fload = fload;
fload = async function (p) { // eslint-disable-line no-func-assign
  if (p && /\.[A-Za-z0-9]{1,8}$/.test(p) && !F.entries.some((e) => e.dir && joinPath(F.cur || '', e.name) === p)) {
    try { await fapi('GET', '/api/fs/list?path=' + encodeURIComponent(p)); } catch { return _fload(p.replace(/\/[^/]*$/, '') || '/'); }
  }
  return _fload(p);
};

// ---------- maximizar panel ----------
function toggleZoom() {
  const s = curSession(); if (!s) return;
  s.zoom = s.zoom ? null : s.focus; render();
}
actions.toggleZoom = toggleZoom;

// ---------- búsqueda en la salida de la terminal ----------
const sb = document.createElement('div'); sb.id = 'sbar'; sb.hidden = true;
sb.innerHTML = '<input type="search" placeholder="Buscar en la terminal" autocomplete="off" spellcheck="false" aria-label="Buscar"><button type="button" data-s="prev" title="Anterior (Shift+Enter)">↑</button><button type="button" data-s="next" title="Siguiente (Enter)">↓</button><button type="button" data-s="x" title="Cerrar (Esc)">✕</button>';
document.body.appendChild(sb);
const sIn = sb.querySelector('input');
const sAddon = () => panes.get(focusedId())?.search;
const OPTS = { decorations: { matchBackground: '#44475a', activeMatchBackground: '#bd93f9', matchOverviewRuler: '#bd93f9', activeMatchColorOverviewRuler: '#50fa7b' } };
function closeSearch() { sb.hidden = true; sAddon()?.clearDecorations(); panes.get(focusedId())?.term.focus(); }
actions.search = () => { sb.hidden = false; sIn.focus(); sIn.select(); };
sIn.addEventListener('input', () => sAddon()?.findNext(sIn.value, { incremental: true, ...OPTS }));
sIn.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { (e.shiftKey ? sAddon()?.findPrevious(sIn.value, OPTS) : sAddon()?.findNext(sIn.value, OPTS)); e.preventDefault(); }
  else if (e.key === 'Escape') closeSearch();
});
sb.addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (!b) return; if (b.dataset.s === 'x') closeSearch(); else if (b.dataset.s === 'prev') sAddon()?.findPrevious(sIn.value, OPTS); else sAddon()?.findNext(sIn.value, OPTS); });

// ---------- portapapeles ----------
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove(); return ok;
}
function toast(t) { const el = $('#status'); el.textContent = t; el.hidden = false; el.style.background = '#2f7d4f'; setTimeout(() => { el.hidden = true; el.style.background = ''; }, 1600); }
actions.copy = async () => {
  const sel = panes.get(focusedId())?.term.getSelection();
  if (!sel) return toast('Seleccioná texto en la terminal primero');
  toast((await copyText(sel)) ? 'Copiado' : 'No se pudo copiar');
};
const _paste = actions.paste;
actions.paste = async () => { // con HTTPS de confianza se lee el portapapeles real; si no, el diálogo de siempre
  try { const t = await navigator.clipboard.readText(); const p = panes.get(focusedId()); if (p && t) { send(p, t); imeReset(); return; } } catch {}
  _paste();
};

// ---------- lanzadores ----------
let LA = [];
api('GET', '/api/prefs').then((p) => { LA = (p && p.launchers) || []; }).catch(() => {});
const saveLA = () => api('PUT', '/api/prefs', { launchers: LA }).catch(() => {});
async function typeInto(id, text, run = true) { // espera a que la terminal esté conectada y con su prompt
  for (let i = 0; i < 80; i++) { const p = panes.get(id); if (p && p.ws && p.ws.readyState === 1) { await sleep(450); send(p, text + (run ? '\r' : '')); return; } await sleep(100); }
}
async function runLauncher(L) {
  const lines = L.cmd.split('\n').map((x) => x.replace(/\s+$/, '')).filter(Boolean); if (!lines.length) return;
  const run = L.enter !== false;
  if (L.mode !== 'session') { const p = panes.get(focusedId()); if (p) { send(p, lines.join('\r') + (run ? '\r' : '')); imeReset(); } return; }
  await newSession(); await typeInto(curSession().focus, lines[0], run);
  for (let i = 1; i < lines.length; i++) { await split(i % 2 ? 'row' : 'col'); await typeInto(curSession().focus, lines[i], run); }
}
const laDlg = document.createElement('dialog'); laDlg.id = 'ladlg';
laDlg.innerHTML = '<h3>Lanzadores</h3><p class="hint">Tocá uno para ejecutarlo. En "sesión nueva" cada línea abre un panel.</p><div id="lalist"></div><div class="fbtns"><button type="button" data-la="new">＋ Nuevo</button><button type="button" data-la="close" class="primary">Cerrar</button></div>';
document.body.appendChild(laDlg);
function renderLA() {
  const box = laDlg.querySelector('#lalist'); box.textContent = '';
  if (!LA.length) { const d = document.createElement('div'); d.className = 'fempty'; d.textContent = 'Todavía no hay lanzadores'; box.appendChild(d); }
  for (const L of LA) {
    const row = document.createElement('div'); row.className = 'larow';
    const go = document.createElement('button'); go.type = 'button'; go.className = 'lago'; go.textContent = L.name;
    const sub = document.createElement('small'); sub.textContent = (L.mode === 'session' ? '▣ sesión nueva · ' : '') + L.cmd.split('\n')[0].slice(0, 60); go.appendChild(sub);
    go.onclick = () => { laDlg.close(); runLauncher(L); };
    const ed = document.createElement('button'); ed.type = 'button'; ed.textContent = '✎'; ed.title = 'Editar'; ed.onclick = () => editLA(L);
    row.append(go, ed); box.appendChild(row);
  }
}
const edDlg = document.createElement('dialog'); edDlg.id = 'ledlg';
edDlg.innerHTML = '<h3>Lanzador</h3><input name="name" placeholder="Nombre (p. ej. Conectar a cliente 1)" maxlength="60" autocomplete="off"><textarea name="cmd" rows="5" placeholder="Un comando por línea" spellcheck="false" autocapitalize="none" autocorrect="off"></textarea><label class="lachk"><span>Dónde</span><select name="mode"><option value="current">En el panel actual</option><option value="session">En una sesión nueva (un panel por línea)</option></select></label><label class="lachk"><input type="checkbox" name="enter" checked> Ejecutar (Enter al final)</label><div class="fbtns"><button type="button" data-ed="del" class="danger">Borrar</button><span style="flex:1"></span><button type="button" data-ed="cancel">Cancelar</button><button type="button" data-ed="ok" class="primary">Guardar</button></div>';
document.body.appendChild(edDlg);
function editLA(L) {
  const isNew = !L; L = L || { id: uid(), name: '', cmd: '', mode: 'current', enter: true };
  const f = edDlg; f.querySelector('[name=name]').value = L.name; f.querySelector('[name=cmd]').value = L.cmd; f.querySelector('[name=mode]').value = L.mode; f.querySelector('[name=enter]').checked = L.enter !== false;
  f.querySelector('[data-ed=del]').hidden = isNew; f._cur = L; f._new = isNew; laDlg.close(); f.showModal(); f.querySelector('[name=name]').focus();
}
edDlg.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ed]'); if (!b) return; const L = edDlg._cur;
  if (b.dataset.ed === 'ok') {
    const name = edDlg.querySelector('[name=name]').value.trim(), cmd = edDlg.querySelector('[name=cmd]').value;
    if (!name || !cmd.trim()) return;
    Object.assign(L, { name, cmd, mode: edDlg.querySelector('[name=mode]').value, enter: edDlg.querySelector('[name=enter]').checked });
    if (edDlg._new) LA.push(L); saveLA();
  } else if (b.dataset.ed === 'del') { LA = LA.filter((x) => x !== L); saveLA(); }
  edDlg.close(); renderLA(); laDlg.showModal();
});
laDlg.addEventListener('click', (e) => { const b = e.target.closest('[data-la]'); if (!b) return; if (b.dataset.la === 'close') laDlg.close(); else editLA(null); });
actions.launchers = () => { renderLA(); laDlg.showModal(); };

// ---------- atajos nuevos (se suman a la lista configurable) ----------
SC_ACTIONS.push(
  { id: 'toggleZoom', group: 'Sesiones y paneles', label: 'Maximizar / restaurar panel', def: 'Ctrl+Alt+Z', run: () => toggleZoom() },
  { id: 'search', group: 'Otros', label: 'Buscar en la terminal', def: 'Ctrl+Alt+S', run: () => actions.search() },
  { id: 'copy', group: 'Otros', label: 'Copiar selección', def: '', run: () => actions.copy() },
  { id: 'launchers', group: 'Otros', label: 'Lanzadores', def: 'Ctrl+Alt+L', run: () => actions.launchers() },
);
scApply();

// ---------- app instalable (requiere HTTPS de confianza) ----------
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
