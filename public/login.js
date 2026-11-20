const $ = (id) => document.getElementById(id);
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let token = null, cdTimer = null;

// Estado de carga: bloquea el formulario (evita enviar dos veces, y con ello dos correos) y muestra qué está pasando.
// Si tarda más de un momento es porque el servidor está hablando con el correo: se avisa.
async function withLoading(form, btn, text, slowText, fn) {
  const label = btn.textContent, fields = [...form.querySelectorAll('input, button')], prev = fields.map((f) => f.disabled);
  fields.forEach((f) => (f.disabled = true));
  btn.classList.add('loading'); btn.textContent = text; form.setAttribute('aria-busy', 'true');
  const slow = slowText && setTimeout(() => { btn.textContent = slowText; }, 1500);
  try { return await fn(); }
  finally {
    clearTimeout(slow); btn.classList.remove('loading'); btn.textContent = label; form.removeAttribute('aria-busy');
    fields.forEach((f, i) => (f.disabled = prev[i]));
  }
}

function showStep(n) {
  $('f').hidden = n !== 1; $('f2').hidden = n !== 2;
  (n === 1 ? $('f').user : $('f2').code).focus();
}
function cooldown(btn, secs) {
  clearInterval(cdTimer); let left = secs; btn.disabled = true;
  const tick = () => { btn.textContent = left > 0 ? `Reenviar código (${left}s)` : 'Reenviar código'; if (left-- <= 0) { clearInterval(cdTimer); btn.disabled = false; } };
  tick(); cdTimer = setInterval(tick, 1000);
}

$('f').addEventListener('submit', (e) => {
  e.preventDefault();
  const err = $('err'); err.textContent = '';
  const fd = new FormData(e.target);
  return withLoading(e.target, e.target.querySelector('button[type=submit]'), 'Verificando…', 'Enviando el código…', async () => {
    try {
      const r = await post('/login', { user: fd.get('user'), password: fd.get('password') });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.need2fa) {
        token = j.token; $('hint2').textContent = `Te enviamos un código de 6 dígitos a ${j.hint}. Vence en 10 minutos.`;
        $('err2').textContent = ''; $('f2').code.value = ''; cooldown($('resend'), 30); showStep(2); return;
      }
      if (r.ok) { location.replace('/'); return new Promise(() => {}); } // se queda cargando hasta que cambie la página
      err.textContent = j.error || 'Error';
    } catch { err.textContent = 'Sin conexión con el servidor.'; }
  });
});

$('f2').addEventListener('submit', (e) => {
  e.preventDefault();
  const err = $('err2'); err.textContent = '';
  return withLoading(e.target, e.target.querySelector('button[type=submit]'), 'Verificando…', null, async () => {
    try {
      const r = await post('/login/verify', { token, code: $('f2').code.value.trim() });
      if (r.ok) { location.replace('/'); return new Promise(() => {}); }
      const j = await r.json().catch(() => ({}));
      err.textContent = j.error || 'Error';
      if (j.expired) { $('f').password.value = ''; setTimeout(() => showStep(1), 1800); }
      else { $('f2').code.value = ''; setTimeout(() => $('f2').code.focus(), 0); }
    } catch { err.textContent = 'Sin conexión con el servidor.'; }
  });
});

$('resend').addEventListener('click', async () => {
  const err = $('err2'); err.textContent = '';
  const sent = await withLoading($('f2'), $('resend'), 'Enviando…', null, async () => {
    try {
      const r = await post('/login/resend', { token }); const j = await r.json().catch(() => ({}));
      if (r.ok) { err.textContent = 'Código reenviado.'; return true; }
      err.textContent = j.error || 'Error'; if (j.expired) setTimeout(() => showStep(1), 1800);
    } catch { err.textContent = 'Sin conexión con el servidor.'; }
    return false;
  });
  if (sent) cooldown($('resend'), 30); // después de restaurar el botón, para que no se pise la espera
});
$('back').addEventListener('click', () => { token = null; $('f').password.value = ''; showStep(1); });
