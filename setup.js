#!/usr/bin/env node
'use strict';
// Configuración de webterm.
//   node setup.js                 asistente: usuario, 2FA por correo, HTTPS y servicio
//   node setup.js user [nombre]   crea o cambia la contraseña de un usuario
//   node setup.js smtp            configura el servidor de correo (para el segundo factor)
//   node setup.js email [usuario] [--remove]   activa/quita el segundo factor por correo de un usuario
//   node setup.js tls [--name X] [--force]     genera el certificado HTTPS autofirmado
//   node setup.js service         instala/actualiza el servicio systemd de usuario
//       [--port N] [--host H] [--no-start]
//   node setup.js stop-terminals  cierra TODAS las terminales abiertas (el servicio no lo hace al reiniciarse)
//   node setup.js uninstall       desinstala el servicio (no borra data/)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawnSync } = require('child_process');
const mail = require('./lib/mail');

const DATA = process.env.WEBTERM_DATA || path.join(__dirname, 'data');
const USERS = path.join(DATA, 'users.json');
const SMTP = path.join(DATA, 'smtp.json');
const TLS_DIR = path.join(DATA, 'tls');
const UNIT_DIR = process.env.WEBTERM_UNIT_DIR || path.join(os.homedir(), '.config', 'systemd', 'user');
const UNIT = path.join(UNIT_DIR, 'webterm.service');

function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => process.stdout.write(s.includes(q) ? s : '*'.repeat(s.length));
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}
async function confirm(q, def = true) {
  const a = (await ask(`${q} ${def ? '[S/n]' : '[s/N]'} `)).trim().toLowerCase();
  return a ? /^(s|si|sí|y|yes)$/.test(a) : def;
}
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const systemctl = (...a) => sh('systemctl', ['--user', ...a]);

// ---------- usuarios ----------
async function setupUser(name) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const user = name || (await ask('Usuario: ')).trim();
  if (!/^[\w.-]{1,32}$/.test(user)) throw new Error('Usuario inválido (letras, números, . _ -; máx. 32).');
  const p1 = await ask('Contraseña (mín. 12 caracteres): ', true);
  if (p1.length < 12) throw new Error('La contraseña es demasiado corta.');
  if (p1 !== (await ask('Repetir contraseña: ', true))) throw new Error('Las contraseñas no coinciden.');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(p1, salt, 64, { N: 16384, r: 8, p: 1 });
  let users = {};
  try { users = JSON.parse(fs.readFileSync(USERS, 'utf8')); } catch {}
  users[user] = { ...users[user], salt: salt.toString('hex'), hash: hash.toString('hex') };
  fs.writeFileSync(USERS, JSON.stringify(users, null, 2), { mode: 0o600 }); fs.chmodSync(USERS, 0o600);
  console.log(`✔ Usuario "${user}" guardado.`);
  if (mail.loadSmtp(SMTP) && !users[user].email && await confirm('¿Activar el segundo factor por correo para este usuario?')) await setupEmail(user);
  return user;
}

// ---------- correo (SMTP) y segundo factor ----------
const readUsers = () => { try { return JSON.parse(fs.readFileSync(USERS, 'utf8')); } catch { return {}; } };
async function setupSmtp() {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const old = mail.loadSmtp(SMTP) || {};
  const q = async (label, def) => ((await ask(def ? `${label} [${def}]: ` : `${label}: `)).trim() || def || '');
  const host = await q('Servidor SMTP (p. ej. smtp.gmail.com)', old.host);
  if (!host) throw new Error('Falta el servidor.');
  console.log('Cifrado:  1) STARTTLS (puerto 587, lo más común)   2) SSL/TLS (puerto 465)   3) Ninguno (solo pruebas locales)');
  const mode = await q('Opción', old.secure ? '2' : old.ignoreTLS ? '3' : '1');
  const port = +(await q('Puerto', String(old.port || (mode === '2' ? 465 : mode === '3' ? 25 : 587))));
  const user = await q('Usuario SMTP (vacío = sin autenticación)', old.user);
  const pass = user ? (await ask('Contraseña SMTP (se guarda en data/smtp.json, permisos 600): ', true)) || old.pass || '' : '';
  const from = await q('Remitente (From)', old.from || user || `webterm@${os.hostname()}`);
  const selfSigned = await confirm('¿El servidor SMTP usa un certificado autofirmado?', old.rejectUnauthorized === false);
  const cfg = { host, port, secure: mode === '2', ignoreTLS: mode === '3', user, pass, from, rejectUnauthorized: !selfSigned };
  process.stdout.write('Probando la conexión… ');
  try { await mail.transport(cfg).verify(); console.log('✔ conecta y autentica.'); }
  catch (e) { console.log('✖\n  ' + e.message); if (!(await confirm('¿Guardar de todos modos?', false))) throw new Error('No se guardó la configuración SMTP.'); }
  fs.writeFileSync(SMTP, JSON.stringify(cfg, null, 2), { mode: 0o600 }); fs.chmodSync(SMTP, 0o600);
  console.log(`✔ Configuración guardada en ${SMTP}`);
  console.log('  (Gmail/Outlook con 2FA propio: usá una "contraseña de aplicación", no la contraseña de la cuenta.)');
}
async function setupEmail(name) {
  const cfg = mail.loadSmtp(SMTP);
  const users = readUsers();
  const user = name || (await ask('Usuario: ')).trim();
  if (!users[user]) throw new Error(`El usuario "${user}" no existe.`);
  if (hasFlag('--remove')) { delete users[user].email; fs.writeFileSync(USERS, JSON.stringify(users, null, 2), { mode: 0o600 }); fs.chmodSync(USERS, 0o600); console.log(`✔ "${user}" ya no usa segundo factor.`); return; }
  if (!cfg) throw new Error('Primero configurá el correo:  node setup.js smtp');
  const to = (await ask(`Correo de "${user}" para recibir los códigos${users[user].email ? ` [${users[user].email}]` : ''}: `)).trim() || users[user].email;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to || '')) throw new Error('Correo inválido.');
  process.stdout.write(`Enviando un correo de prueba a ${to}… `);
  try { await mail.sendMail(cfg, { to, subject: 'webterm: verificación del correo', text: 'Si leés esto, el segundo factor de webterm puede enviarte códigos a esta dirección.' }); console.log('✔ enviado.'); }
  catch (e) { throw new Error('No se pudo enviar: ' + e.message + '\n  No se activó el segundo factor (para no dejarte afuera).'); }
  if (!(await confirm('¿Te llegó el correo?'))) throw new Error('No se activó el segundo factor.');
  users[user].email = to;
  fs.writeFileSync(USERS, JSON.stringify(users, null, 2), { mode: 0o600 }); fs.chmodSync(USERS, 0o600);
  console.log(`✔ Segundo factor activado para "${user}". Al iniciar sesión se enviará un código a ${to}.`);
  console.log('  Si algún día falla el correo y quedás afuera:  node setup.js email ' + user + ' --remove');
}

// ---------- HTTPS autofirmado ----------
async function setupTls(interactive) {
  if (sh('openssl', ['version']).status !== 0) throw new Error('Hace falta el comando "openssl" (sudo apt install openssl).');
  const have = fs.existsSync(path.join(TLS_DIR, 'cert.pem'));
  if (have && !hasFlag('--force') && !(interactive && await confirm('Ya hay un certificado. ¿Generar uno nuevo?', false))) { console.log('Se mantiene el certificado existente (usá --force para regenerarlo).'); return; }
  const host = os.hostname();
  const extra = [];
  for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === '--name' && process.argv[i + 1]) extra.push(process.argv[i + 1]);
  if (interactive) extra.push(...(await ask('Nombres o IPs adicionales con los que vas a entrar (separados por coma, p. ej. un nombre DDNS; Enter = ninguno): ')).split(',').map((x) => x.trim()).filter(Boolean));
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => i.address);
  const isIp = (x) => /^\d+\.\d+\.\d+\.\d+$/.test(x);
  const names = [...new Set([host, `${host}.local`, 'localhost', ...extra.filter((x) => !isIp(x))])];
  const addrs = [...new Set(['127.0.0.1', ...ips, ...extra.filter(isIp)])];
  const san = [...names.map((n) => `DNS:${n}`), ...addrs.map((a) => `IP:${a}`)].join(',');
  fs.mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 });
  const f = (n) => path.join(TLS_DIR, n);
  const run = (args, input) => { const r = spawnSync('openssl', args, { encoding: 'utf8', input }); if (r.status !== 0) throw new Error('openssl falló: ' + (r.stderr || '').trim()); return r.stdout; };
  // 1) una autoridad certificadora propia (se instala una vez en cada dispositivo) y 2) el certificado del servidor, firmado por ella
  run(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '3650', '-keyout', f('ca-key.pem'), '-out', f('ca.pem'),
    '-subj', `/CN=webterm CA (${host})`, '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', f('key.pem'), '-out', f('server.csr'), '-subj', `/CN=${host}`]);
  fs.writeFileSync(f('server.ext'), `subjectAltName=${san}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
  run(['x509', '-req', '-in', f('server.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca-key.pem'), '-CAcreateserial', '-out', f('cert.pem'), '-days', '825', '-sha256', '-extfile', f('server.ext')]);
  for (const n of ['server.csr', 'server.ext', 'ca.srl']) fs.rmSync(f(n), { force: true });
  for (const n of ['key.pem', 'ca-key.pem']) fs.chmodSync(f(n), 0o600);
  const fp = run(['x509', '-in', f('cert.pem'), '-noout', '-fingerprint', '-sha256']).trim().replace('sha256 Fingerprint=', 'SHA-256 ');
  console.log(`✔ Certificado generado en ${TLS_DIR}`);
  console.log(`  Válido para: ${[...names, ...addrs].join(', ')}`);
  console.log(`  ${fp}`);
  console.log('  Reiniciá el servicio para activarlo (systemctl --user restart webterm) y entrá siempre por  https://');
  console.log('  Para no ver la advertencia del navegador, instalá la autoridad "ca.pem" una vez en cada dispositivo:');
  console.log('  abrí https://<este-equipo>:<puerto>/ca.pem (aceptá la advertencia esa única vez) o copiá data/tls/ca.pem. Ver README.');
}

// ---------- servicio ----------
const hasFlag = (f) => process.argv.includes(f);
function optionOf(flag, def) { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : def; }


function unitText(port, host) {
  const q = (s) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
  return `[Unit]
Description=webterm (terminal web)
After=network-online.target

[Service]
WorkingDirectory=${__dirname}
ExecStart=${q(process.execPath)} ${q(path.join(__dirname, 'server.js'))}
Environment=PORT=${port}
Environment=HOST=${host}
Environment=SHELL=${process.env.SHELL || '/bin/bash'}
Environment=LANG=${process.env.LANG || 'en_US.UTF-8'}
${process.env.WEBTERM_DATA ? `Environment=WEBTERM_DATA=${process.env.WEBTERM_DATA}\n` : ''}Restart=always
RestartSec=2
# Solo se detiene el servidor web: el demonio de terminales (lib/ptyd.js) sigue vivo y las shells sobreviven a los reinicios
KillMode=process

[Install]
WantedBy=default.target
`;
}

async function setupService(interactive) {
  if (process.platform !== 'linux' || sh('systemctl', ['--version']).status !== 0) {
    console.log('systemd no está disponible. Arrancá manualmente con:  node server.js  (o usá pm2/supervisor).');
    return;
  }
  if (!fs.existsSync(USERS) || !Object.keys(JSON.parse(fs.readFileSync(USERS, 'utf8') || '{}')).length)
    throw new Error('Primero creá un usuario:  node setup.js user');
  let port = optionOf('--port', '8022'), host = optionOf('--host', '0.0.0.0');
  if (interactive) {
    port = (await ask(`Puerto [${port}]: `)).trim() || port;
    host = (await ask(`Interfaz de escucha [${host}] (0.0.0.0 = todas, 127.0.0.1 = solo local): `)).trim() || host;
  }
  if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535) throw new Error('Puerto inválido.');

  fs.mkdirSync(UNIT_DIR, { recursive: true });
  fs.writeFileSync(UNIT, unitText(port, host));
  console.log(`✔ Unidad escrita en ${UNIT}`);
  if (hasFlag('--no-start')) return;

  const running = systemctl('is-active', '--quiet', 'webterm').status === 0;
  if (running && interactive &&
      !(await confirm('El servicio ya está corriendo. Reiniciarlo cierra las shells abiertas. ¿Reiniciar ahora?', false))) {
    systemctl('daemon-reload');
    console.log('Unidad actualizada. Aplicala cuando quieras con:  systemctl --user restart webterm');
    return;
  }
  const steps = [['daemon-reload'], ['enable', 'webterm'], [running ? 'restart' : 'start', 'webterm']];
  for (const s of steps) {
    const r = systemctl(...s);
    if (r.status !== 0) throw new Error(`systemctl --user ${s.join(' ')} falló: ${(r.stderr || '').trim()}`);
  }
  const lg = sh('loginctl', ['enable-linger', os.userInfo().username]);
  console.log(lg.status === 0
    ? '✔ Linger activado: arranca al bootear aunque no haya sesión abierta.'
    : '⚠ No pude activar linger (sin sesión abierta el servicio no arranca solo). Probá:  sudo loginctl enable-linger $USER');
  console.log(`✔ Servicio activo en el puerto ${port} (${host}).`);
  console.log('  Estado: systemctl --user status webterm    Logs: journalctl --user -u webterm -f');
}

async function stopTerminals() {
  const net = require('net'), crypto2 = require('crypto');
  const own = path.join(DATA, 'ptyd.sock');
  const sock = own.length <= 100 ? own : path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `webterm-${crypto2.createHash('sha1').update(DATA).digest('hex').slice(0, 10)}.sock`);
  await new Promise((resolve) => {
    const c = net.connect(sock);
    c.on('connect', () => { c.write(JSON.stringify({ op: 'quit' }) + '\n'); setTimeout(() => { c.destroy(); console.log('✔ Se cerraron todas las terminales.'); resolve(); }, 300); });
    c.on('error', () => { console.log('No hay terminales persistentes abiertas.'); resolve(); });
  });
}
function uninstall() {
  systemctl('disable', '--now', 'webterm');
  try { fs.unlinkSync(UNIT); } catch {}
  systemctl('daemon-reload');
  console.log('✔ Servicio desinstalado. Los datos (usuarios, layout, auditoría) siguen en data/.');
}

// ---------- main ----------
(async () => {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'user') await setupUser(arg && !arg.startsWith('--') ? arg : undefined);
    else if (cmd === 'smtp') await setupSmtp();
    else if (cmd === 'email') await setupEmail(arg && !arg.startsWith('--') ? arg : undefined);
    else if (cmd === 'tls') await setupTls(false);
    else if (cmd === 'service') await setupService(false);
    else if (cmd === 'stop-terminals') await stopTerminals();
    else if (cmd === 'uninstall') uninstall();
    else if (!cmd || cmd.startsWith('--')) {
      console.log('— Configuración de webterm —\n');
      if (await confirm('¿Configurar el correo (SMTP) para el segundo factor de autenticación?', false)) await setupSmtp();
      const user = await setupUser();
      if (mail.loadSmtp(SMTP) && !readUsers()[user]?.email) { /* setupUser ya ofreció activar el 2FA */ }
      if (await confirm('\n¿Generar un certificado HTTPS autofirmado?')) await setupTls(true);
      if (await confirm('\n¿Instalar como servicio en segundo plano (systemd)?')) await setupService(true);
      else console.log('\nPodés arrancarlo a mano con:  npm start');
    } else { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 8).join('\n').replace(/^\/\/ ?/gm, '')); }
  } catch (e) { console.error('✖ ' + e.message); process.exit(1); }
})();
