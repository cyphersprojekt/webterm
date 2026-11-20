'use strict';
// Atajos de teclado configurables. Los valores por defecto están acá; cada usuario guarda sus cambios en el
// servidor (data/prefs.json, ignorado por git), así el repo no impone ninguna combinación.
// Una combinación se escribe "Ctrl+Alt+Shift+Meta+Tecla", por ejemplo "Ctrl+Shift+D" o "Shift+PageUp".

const cyclePane = (d) => {
  const s = curSession(); if (!s) return;
  const l = leaves(s.root); if (l.length < 2) return;
  focusPane(l[(l.indexOf(s.focus) + d + l.length) % l.length]);
};
const gotoSession = (n) => { const s = sessions[n - 1]; if (s) { active = s.id; render(); } };

const SC_ACTIONS = [
  { id: 'newSession', group: 'Sesiones y paneles', label: 'Nueva sesión', def: 'Ctrl+Alt+T', run: () => newSession() },
  { id: 'splitRight', group: 'Sesiones y paneles', label: 'Dividir a la derecha', def: 'Ctrl+Alt+R', run: () => split('row') },
  { id: 'splitDown', group: 'Sesiones y paneles', label: 'Dividir hacia abajo', def: 'Ctrl+Alt+D', run: () => split('col') },
  { id: 'closePane', group: 'Sesiones y paneles', label: 'Cerrar panel', def: 'Ctrl+Alt+W', run: () => closePane() },
  { id: 'renameSession', group: 'Sesiones y paneles', label: 'Renombrar sesión', def: '', run: () => renameSession() },
  { id: 'nextPane', group: 'Moverse entre paneles', label: 'Panel siguiente (ciclar)', def: 'Ctrl+Alt+PageDown', run: () => cyclePane(1) },
  { id: 'prevPane', group: 'Moverse entre paneles', label: 'Panel anterior (ciclar)', def: 'Ctrl+Alt+PageUp', run: () => cyclePane(-1) },
  { id: 'focusLeft', group: 'Moverse entre paneles', label: 'Panel a la izquierda', def: 'Ctrl+Alt+ArrowLeft', run: () => focusDir(-1, 0) },
  { id: 'focusRight', group: 'Moverse entre paneles', label: 'Panel a la derecha', def: 'Ctrl+Alt+ArrowRight', run: () => focusDir(1, 0) },
  { id: 'focusUp', group: 'Moverse entre paneles', label: 'Panel de arriba', def: 'Ctrl+Alt+ArrowUp', run: () => focusDir(0, -1) },
  { id: 'focusDown', group: 'Moverse entre paneles', label: 'Panel de abajo', def: 'Ctrl+Alt+ArrowDown', run: () => focusDir(0, 1) },
  { id: 'nextSession', group: 'Cambiar de sesión', label: 'Sesión siguiente', def: 'Alt+PageDown', run: () => switchSession(1) },
  { id: 'prevSession', group: 'Cambiar de sesión', label: 'Sesión anterior', def: 'Alt+PageUp', run: () => switchSession(-1) },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: 'goto' + n, group: 'Cambiar de sesión', label: 'Ir a la sesión ' + n, def: 'Alt+' + n, run: () => gotoSession(n) })),
  { id: 'toggleFiles', group: 'Otros', label: 'Abrir/cerrar archivos', def: 'Ctrl+Alt+F', run: () => actions.files() },
  { id: 'toggleStatus', group: 'Otros', label: 'Estado del equipo', def: '', run: () => actions.status() },
  { id: 'toggleLog', group: 'Otros', label: 'Registro de actividad', def: '', run: () => actions.log() },
  { id: 'fontUp', group: 'Otros', label: 'Aumentar fuente', def: '', run: () => setFont(1) },
  { id: 'fontDown', group: 'Otros', label: 'Reducir fuente', def: '', run: () => setFont(-1) },
];

let scOverrides = {};        // sólo lo que difiere del valor por defecto
const scMap = new Map();     // combinación -> id de acción
let scStop = null;           // cancela la captura en curso
const scEff = (id) => (id in scOverrides ? scOverrides[id] : SC_ACTIONS.find((a) => a.id === id).def);

const SC_NAMED = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Insert', 'Delete', 'Tab', 'Enter', 'Space', 'Backspace']);
function scKeyName(e) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS'].includes(e.key)) return null;
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (e.key === ' ') return 'Space';
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}
function comboOf(e) {
  const k = scKeyName(e); if (!k) return null;
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', k].filter(Boolean).join('+');
}
const scPretty = (c) => !c ? 'Sin asignar' : c.replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace('PageUp', 'PgUp').replace('PageDown', 'PgDn');
// reglas: una combinación no debe interferir con escribir ni con los atajos propios de la terminal
function scInvalid(c) {
  const parts = c.split('+'), key = parts.pop(), mods = parts, single = key.length === 1;
  if (!mods.length && !/^F\d{1,2}$/.test(key)) return 'Necesita un modificador (Ctrl, Alt, Shift) o ser una tecla F.';
  if (mods.length === 1 && mods[0] === 'Shift' && single) return 'Shift + una tecla común escribe texto. Combinalo con Ctrl/Alt, o usá una tecla especial (PgUp, flechas, F1…).';
  if (mods.length === 1 && mods[0] === 'Ctrl' && single) return 'Ctrl + letra choca con atajos de la terminal (Ctrl+C, Ctrl+D…). Agregá Alt o Shift.';
  return null;
}
const SC_RESERVED = new Set(['Ctrl+T', 'Ctrl+N', 'Ctrl+W', 'Ctrl+Shift+T', 'Ctrl+Shift+N', 'Ctrl+Shift+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+PageUp', 'Ctrl+PageDown', 'Alt+F4']);
const scReserved = (c) => SC_RESERVED.has(c) || c.includes('Meta');

function scApply() {
  scMap.clear();
  for (const a of SC_ACTIONS) { const c = scEff(a.id); if (c) scMap.set(c, a.id); }
  const t = { newSession: ['newSession', 'Nueva sesión'], splitRight: ['splitRight', 'Dividir lateral'], splitDown: ['splitDown', 'Dividir horizontal'], files: ['toggleFiles', 'Archivos'] };
  for (const [act, [id, base]] of Object.entries(t)) {
    const b = document.querySelector(`#top [data-act="${act}"]`), c = scEff(id);
    if (b) b.title = c ? `${base} (${scPretty(c)})` : base;
  }
}
let scSaveT;
function scSave() { clearTimeout(scSaveT); scSaveT = setTimeout(() => api('PUT', '/api/prefs', { shortcuts: scOverrides }).catch(() => {}), 300); }
function scSet(id, combo) {
  const def = SC_ACTIONS.find((a) => a.id === id).def;
  if (combo === def) delete scOverrides[id]; else scOverrides[id] = combo;
  scApply(); scSave();
}

// el atajo se ejecuta en captura: xterm no llega a ver la combinación
document.addEventListener('keydown', (e) => {
  if (scStop || e.isComposing || document.querySelector('dialog[open]')) return;
  const c = comboOf(e), id = c && scMap.get(c);
  if (!id) return;
  e.preventDefault(); e.stopPropagation();
  SC_ACTIONS.find((a) => a.id === id).run();
}, true);

// ---------- diálogo de configuración ----------
const scDlg = $('#scdlg'), scList = $('#sclist'), scMsg = $('#scmsg');
function scMessage(t, bad) { scMsg.textContent = t || ''; scMsg.classList.toggle('bad', !!bad); }
function scRender() {
  scList.textContent = '';
  let group = '';
  for (const a of SC_ACTIONS) {
    if (a.group !== group) { group = a.group; const h = document.createElement('h4'); h.textContent = group; scList.appendChild(h); }
    const row = document.createElement('div'); row.className = 'screw';
    const lab = document.createElement('span'); lab.textContent = a.label;
    const cur = scEff(a.id);
    const key = document.createElement('button'); key.type = 'button'; key.className = 'sckey' + (cur ? '' : ' none'); key.textContent = scPretty(cur);
    key.title = 'Cambiar'; key.onclick = () => scCapture(key, a.id);
    const clr = document.createElement('button'); clr.type = 'button'; clr.textContent = '✕'; clr.title = 'Quitar el atajo'; clr.disabled = !cur;
    clr.onclick = () => { scSet(a.id, ''); scMessage(''); scRender(); };
    const rst = document.createElement('button'); rst.type = 'button'; rst.textContent = '↺'; rst.title = a.def ? `Restablecer (${scPretty(a.def)})` : 'Restablecer (sin atajo)'; rst.disabled = !(a.id in scOverrides);
    rst.onclick = () => { delete scOverrides[a.id]; scApply(); scSave(); scMessage(''); scRender(); };
    row.append(lab, key, clr, rst); scList.appendChild(row);
  }
}
function scCapture(btn, id) {
  if (scStop) scStop();
  btn.textContent = 'Presioná la combinación…'; btn.classList.add('rec');
  scMessage('Esc cancela · Retroceso quita el atajo');
  const stop = () => { document.removeEventListener('keydown', onk, true); scStop = null; scRender(); };
  const onk = (e) => {
    e.preventDefault(); e.stopPropagation();
    const bare = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
    if (e.key === 'Escape' && bare) { scMessage(''); return stop(); }
    if ((e.key === 'Backspace' || e.key === 'Delete') && bare) { scSet(id, ''); scMessage(''); return stop(); }
    const c = comboOf(e); if (!c) return; // sólo modificadores: seguir esperando
    const bad = scInvalid(c); if (bad) return scMessage(bad, true);
    const clash = SC_ACTIONS.find((a) => a.id !== id && scEff(a.id) === c);
    if (clash) scSet(clash.id, '');
    scSet(id, c);
    const notes = [];
    if (clash) notes.push(`Se le quitó a «${clash.label}».`);
    if (scReserved(c)) notes.push(`Ojo: los navegadores reservan «${scPretty(c)}» y la página no puede interceptarla; probablemente no funcione en una pestaña normal.`);
    scMessage(notes.join(' '), notes.length > 0 && scReserved(c));
    stop();
  };
  scStop = stop; document.addEventListener('keydown', onk, true);
}
$('#scReset').onclick = () => { scOverrides = {}; scApply(); scSave(); scMessage('Se restablecieron todos los atajos.'); scRender(); };
$('#scClose').onclick = () => scDlg.close();
scDlg.addEventListener('close', () => { if (scStop) scStop(); });
function openShortcuts() { scMessage(''); scRender(); scDlg.showModal(); }
actions.shortcuts = openShortcuts;

// ---------- arranque ----------
scApply();
api('GET', '/api/prefs').then((p) => { scOverrides = (p && p.shortcuts) || {}; scApply(); }).catch(() => {});
