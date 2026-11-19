#!/usr/bin/env node
'use strict';
// Configuración de webterm.
//   node setup.js                 asistente: crea usuario e instala el servicio
//   node setup.js user [nombre]   crea o cambia la contraseña de un usuario
//   node setup.js service         instala/actualiza el servicio systemd de usuario
//       [--port N] [--host H] [--no-start]
//   node setup.js uninstall       desinstala el servicio (no borra data/)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawnSync } = require('child_process');

const DATA = process.env.WEBTERM_DATA || path.join(__dirname, 'data');
const USERS = path.join(DATA, 'users.json');
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
  users[user] = { salt: salt.toString('hex'), hash: hash.toString('hex') };
  fs.writeFileSync(USERS, JSON.stringify(users, null, 2), { mode: 0o600 });
  console.log(`✔ Usuario "${user}" guardado.`);
}

// ---------- servicio ----------
function optionOf(flag, def) { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : def; }
const hasFlag = (f) => process.argv.includes(f);

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
    else if (cmd === 'service') await setupService(false);
    else if (cmd === 'uninstall') uninstall();
    else if (!cmd || cmd.startsWith('--')) {
      console.log('— Configuración de webterm —\n');
      await setupUser();
      if (await confirm('\n¿Instalar como servicio en segundo plano (systemd)?')) await setupService(true);
      else console.log('\nPodés arrancarlo a mano con:  npm start');
    } else { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 8).join('\n').replace(/^\/\/ ?/gm, '')); }
  } catch (e) { console.error('✖ ' + e.message); process.exit(1); }
})();
