document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const fd = new FormData(e.target);
  try {
    const r = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: fd.get('user'), password: fd.get('password') }),
    });
    if (r.ok) return (location.href = '/');
    err.textContent = (await r.json()).error || 'Error';
  } catch { err.textContent = 'Sin conexión con el servidor.'; }
});
