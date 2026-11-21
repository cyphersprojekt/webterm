'use strict';
// Explorador: selección múltiple (copiar, cortar, pegar, bajar .zip, borrar), búsqueda, orden y editor de texto.
F.sort = localStorage.getItem('fsort') || 'name'; F.filter = ''; F.sel = null; F.clip = null;
const SORTS = { name: 'Nombre', date: 'Fecha', size: 'Tamaño' };
const CMP = { name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }), date: (a, b) => b.mtime - a.mtime, size: (a, b) => b.size - a.size };
const fsel = $('#fsel'), fsearch = $('#fsearch');
const TEXT_RE = /\.(txt|md|markdown|json|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|py|js|mjs|ts|jsx|tsx|css|scss|html?|xml|csv|tsv|log|sql|c|h|cpp|hpp|go|rs|java|rb|php|service|timer|socket|rules|gitignore|dockerfile|properties|lua|pl|vue|svelte)$/i;
const isTextish = (e) => !e.dir && !e.broken && e.size <= 1024 * 1024 && (TEXT_RE.test(e.name) || !/\./.test(e.name.replace(/^\./, '')));

function fRows() {
  const q = F.filter.toLowerCase();
  return F.entries.filter((e) => (F.hidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)))
    .sort((a, b) => (b.dir - a.dir) || CMP[F.sort](a, b));
}
const EDIT_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 14h6M9 17h4"/></svg>';
function fRowDecor(e, full, row) {
  if (!F.sel) return;
  const c = document.createElement('span'); c.className = 'fchk'; row.prepend(c);
  row.classList.toggle('sel', F.sel.has(e.name));
}
function fRowExtras(e, full, btn) {
  if (F.sel) return;
  if (isTextish(e)) btn('Ver / editar el contenido', EDIT_ICON, () => fedit(full, e));
}
function fToggle(e, row) {
  if (F.sel.has(e.name)) F.sel.delete(e.name); else F.sel.add(e.name);
  row.classList.toggle('sel', F.sel.has(e.name)); updSel();
}
function updSel() {
  $('#fselcount').textContent = F.sel ? `${F.sel.size} elegidos` : '';
  fsel.querySelectorAll('button:not([data-fa=selcancel]):not([data-fa=selall])').forEach((b) => (b.disabled = !F.sel || !F.sel.size));
}
function setSel(on) {
  F.sel = on ? new Set() : null; fsel.hidden = !on; F.el.classList.toggle('selecting', on);
  $('[data-fa=select]').classList.toggle('on', on); updSel(); frender();
}
function updClip() {
  const b = $('#fpaste'); b.hidden = !F.clip;
  if (F.clip) b.textContent = `Pegar aquí (${F.clip.names.length}${F.clip.op === 'move' ? ', mover' : ''})`;
}
const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
const origLoad = fload;
fload = async function (p) { // eslint-disable-line no-func-assign
  if (F.sel) { F.sel = null; fsel.hidden = true; F.el.classList.remove('selecting'); $('[data-fa=select]').classList.remove('on'); }
  fsearch.value = ''; F.filter = '';
  return origLoad(p);
};

// ---------- acciones de la barra ----------
F.el.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-fa]'); if (!b) return; const a = b.dataset.fa;
  if (a === 'select') setSel(!F.sel);
  else if (a === 'selcancel') setSel(false);
  else if (a === 'selall') { fRows().forEach((e) => F.sel.add(e.name)); frender(); updSel(); }
  else if (a === 'sort') { const k = Object.keys(SORTS); F.sort = k[(k.indexOf(F.sort) + 1) % k.length]; localStorage.setItem('fsort', F.sort); b.textContent = 'Orden: ' + SORTS[F.sort]; frender(); }
  else if (a === 'selcopy' || a === 'selcut') {
    F.clip = { op: a === 'selcut' ? 'move' : 'copy', dir: F.cur, names: [...F.sel] }; setSel(false); updClip();
    fmsg(`${F.clip.names.length} elemento(s) ${F.clip.op === 'move' ? 'listos para mover' : 'copiados'}. Andá a la carpeta destino y tocá "Pegar aquí".`);
  } else if (a === 'paste') {
    if (!F.clip) return; const c = F.clip;
    try {
      const r = await fapi('POST', '/api/fs/paste', { op: c.op, dir: F.cur, paths: c.names.map((n) => joinPath(c.dir, n)) });
      if (c.op === 'move' && !r.errors.length) F.clip = null; updClip();
      fmsg(r.errors.length ? `Listo ${r.done}; con errores: ${r.errors.join(' · ')}` : `${r.done} elemento(s) ${c.op === 'move' ? 'movidos' : 'copiados'}.`);
      origLoad(F.cur);
    } catch (e) { fmsg(e.message); }
  } else if (a === 'seldl') {
    const q = [...F.sel].map((n) => 'n=' + encodeURIComponent(n)).join('&');
    const l = document.createElement('a'); l.href = `/api/fs/zip?dir=${encodeURIComponent(F.cur)}&${q}`; l.download = ''; document.body.appendChild(l); l.click(); l.remove(); setSel(false);
  } else if (a === 'seldel') {
    const names = [...F.sel];
    const r = await fdlg({ title: `Borrar ${names.length} elemento(s)`, text: 'Se borrarán definitivamente, con todo su contenido. No se puede deshacer.', buttons: [BTN_CANCEL, { label: 'Borrar', action: 'ok', cls: 'danger' }] });
    if (r?.action !== 'ok') return; const errs = [];
    for (const n of names) { try { await fapi('POST', '/api/fs/delete', { path: joinPath(F.cur, n) }); } catch (e) { errs.push(`${n}: ${e.message}`); } }
    setSel(false); if (errs.length) fmsg(errs.join(' · ')); origLoad(F.cur);
  }
});

// ---------- búsqueda ----------
let searchT = 0;
fsearch.addEventListener('input', () => { F.filter = fsearch.value; clearTimeout(searchT); if (!fsearch.value) { origLoad(F.cur); return; } frender(); });
fsearch.addEventListener('keydown', async (e) => {
  e.stopPropagation(); if (e.key !== 'Enter' || !fsearch.value.trim()) return;
  try {
    const d = await fapi('GET', `/api/fs/search?dir=${encodeURIComponent(F.cur)}&q=${encodeURIComponent(fsearch.value)}`);
    F.list.textContent = '';
    if (!d.results.length) { const x = document.createElement('div'); x.className = 'fempty'; x.textContent = 'Sin resultados'; F.list.appendChild(x); return; }
    for (const r of d.results) {
      const row = document.createElement('div'); row.className = 'frow ' + (r.dir ? 'dir' : 'file');
      row.insertAdjacentHTML('beforeend', r.dir ? FI.dir : FI.file);
      const nm = document.createElement('div'); nm.className = 'fname'; const b = document.createElement('b'); b.textContent = r.name;
      const sm = document.createElement('small'); sm.textContent = r.path.slice(F.cur.length).replace(/^\//, '') ; nm.append(b, sm); row.appendChild(nm);
      row.onclick = async () => { const dir = r.dir ? r.path : r.path.replace(/\/[^/]*$/, '') || '/'; fnav(dir); await sleep2(500);
        const hit = [...document.querySelectorAll('#flist .frow')].find((x) => x.querySelector('b')?.textContent === r.name);
        if (hit) { hit.scrollIntoView({ block: 'center' }); hit.classList.add('flash'); setTimeout(() => hit.classList.remove('flash'), 1800); } };
      F.list.appendChild(row);
    }
    if (d.partial) fmsg('Hay más resultados: afiná la búsqueda.');
  } catch (er) { fmsg(er.message); }
});

// ---------- editor de texto ----------
const ed = document.createElement('dialog'); ed.id = 'edlg';
ed.innerHTML = '<div class="edhead"><b></b><span class="edst"></span></div><textarea spellcheck="false" autocapitalize="none" autocorrect="off" wrap="off"></textarea><div class="fbtns"><button type="button" data-e="close">Cerrar</button><button type="button" data-e="save" class="primary">Guardar</button></div>';
document.body.appendChild(ed);
const edTa = ed.querySelector('textarea'), edSt = ed.querySelector('.edst');
let edCur = null, edDirty = false;
async function fedit(full, e) {
  try {
    const d = await fapi('GET', '/api/fs/text?path=' + encodeURIComponent(full));
    edCur = { full, mtime: d.mtime }; edTa.value = d.content; edDirty = false; ed.querySelector('b').textContent = e.name; edSt.textContent = '';
    ed.showModal(); edTa.focus(); edTa.setSelectionRange(0, 0); edTa.scrollTop = 0;
  } catch (er) { fmsg(er.message); }
}
async function edSave() {
  try {
    const r = await fapi('PUT', '/api/fs/text', { path: edCur.full, content: edTa.value, mtime: edCur.mtime });
    edCur.mtime = r.mtime; edDirty = false; edSt.textContent = 'Guardado'; edSt.classList.remove('bad'); return true;
  } catch (er) { edSt.textContent = er.message; edSt.classList.add('bad'); return false; }
}
edTa.addEventListener('input', () => { edDirty = true; edSt.textContent = 'Sin guardar'; edSt.classList.remove('bad'); });
edTa.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Tab') { e.preventDefault(); const s = edTa.selectionStart; edTa.setRangeText('  ', s, edTa.selectionEnd, 'end'); edTa.dispatchEvent(new Event('input')); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); edSave(); }
});
ed.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-e]'); if (!b) return;
  if (b.dataset.e === 'save') edSave();
  else if (!edDirty || (await fdlg({ title: 'Cambios sin guardar', text: 'Si cerrás, se pierden.', buttons: [BTN_CANCEL, { label: 'Cerrar sin guardar', action: 'ok', cls: 'danger' }] }))?.action === 'ok') { ed.close(); origLoad(F.cur); }
});
ed.addEventListener('cancel', (e) => { if (edDirty) e.preventDefault(); }); // Esc no debe perder cambios por accidente
$('#fsort').textContent = 'Orden: ' + SORTS[F.sort];
