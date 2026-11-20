'use strict';
// Estado del equipo (CPU, memoria, discos, procesos) y lectura del registro de auditoría.
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const run = (cmd, args, timeout = 3000) => new Promise((resolve) =>
  execFile(cmd, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout))));

// CPU: porcentaje de uso entre dos lecturas de /proc/stat
let lastCpu = null;
function readCpu() {
  try {
    const l = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = l[3] + (l[4] || 0), total = l.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch { return null; }
}
async function cpuPercent() {
  const a = lastCpu || readCpu(); if (!a) return null;
  if (!lastCpu) await new Promise((r) => setTimeout(r, 250));
  const b = readCpu(); lastCpu = b;
  const dt = b.total - a.total; return dt > 0 ? Math.round((1 - (b.idle - a.idle) / dt) * 1000) / 10 : 0;
}

function memInfo() {
  const o = {};
  try { for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) { const m = /^(\w+):\s+(\d+)/.exec(line); if (m) o[m[1]] = +m[2] * 1024; } } catch {}
  return { total: o.MemTotal ?? os.totalmem(), avail: o.MemAvailable ?? os.freemem(), swapTotal: o.SwapTotal || 0, swapFree: o.SwapFree || 0 };
}
function temperature() {
  try {
    let max = null;
    for (const d of fs.readdirSync('/sys/class/thermal')) if (d.startsWith('thermal_zone')) {
      const t = +fs.readFileSync(`/sys/class/thermal/${d}/temp`, 'utf8'); if (t > 0 && (max === null || t > max)) max = t;
    }
    return max === null ? null : Math.round(max / 100) / 10;
  } catch { return null; }
}
const SKIP_FS = new Set(['tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'efivarfs', 'ramfs', 'proc', 'sysfs', 'cgroup2', 'fuse.portal', 'fuse.gvfsd-fuse', 'fuse.snapfuse']);
async function disks() {
  const out = await run('df', ['-PkT'], 4000), res = [], seen = new Set();
  for (const line of out.split('\n').slice(1)) {
    const p = line.trim().split(/\s+/); if (p.length < 7) continue;
    const [fsName, type, size, used, , , ...mount] = p, mnt = mount.join(' ');
    if (SKIP_FS.has(type) || mnt.startsWith('/snap') || mnt.startsWith('/var/lib/docker') || seen.has(fsName + mnt)) continue;
    seen.add(fsName + mnt);
    res.push({ fs: fsName, type, mount: mnt, size: +size * 1024, used: +used * 1024 });
  }
  return res;
}
async function procs(n = 8) {
  const out = await run('ps', ['-eo', 'pid=,user=,pcpu=,pmem=,etimes=,args=', '--sort=-pcpu'], 3000), res = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line); if (!m) continue;
    res.push({ pid: +m[1], user: m[2], cpu: +m[3], mem: +m[4], age: +m[5], cmd: m[6].slice(0, 160) });
    if (res.length >= n) break;
  }
  return res;
}
async function failedUnits() {
  const c = async (args) => (await run('systemctl', args, 3000)).split('\n').filter((l) => l.trim()).map((l) => l.replace(/^[●\s]+/, '').split(/\s+/)[0]);
  return { system: await c(['--failed', '--no-legend', '--plain']), user: await c(['--user', '--failed', '--no-legend', '--plain']) };
}
function osName() {
  try { const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(fs.readFileSync('/etc/os-release', 'utf8')); if (m) return m[1]; } catch {}
  return `${os.type()} ${os.release()}`;
}
async function status() {
  const [cpu, dsk, ps, failed] = await Promise.all([cpuPercent(), disks(), procs(), failedUnits()]);
  return { host: os.hostname(), os: osName(), kernel: os.release(), uptime: os.uptime(), load: os.loadavg(), cores: os.cpus().length,
    cpu, mem: memInfo(), temp: temperature(), disks: dsk, procs: ps, failed };
}

// ---- registro de auditoría ----
const CATS = {
  access: /^(login_|logout|attach|detach|ws_denied)/, cmd: /^cmd$/, files: /^fs_/, panes: /^pane_/, system: /^(proc_|tls_|2fa)/,
  alerts: /^(login_fail|login_blocked|login_2fa_fail|ws_denied)/,
};
function tailLines(file, maxBytes) {
  try {
    const st = fs.statSync(file), len = Math.min(st.size, maxBytes), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n'); if (st.size > len) lines.shift(); // primera línea cortada
    return lines;
  } catch { return []; }
}
function readAudit(file, { limit = 300, cat = '', q = '' } = {}) {
  limit = Math.max(1, Math.min(1000, limit | 0 || 300));
  const re = CATS[cat], needle = q.trim().toLowerCase();
  let lines = tailLines(file, 4 * 1024 * 1024);
  if (lines.length < 20000) lines = [...tailLines(file + '.1', 2 * 1024 * 1024), ...lines];
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const l = lines[i]; if (!l) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (re && !re.test(e.ev || '')) continue;
    if (needle && !l.toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return out;
}
module.exports = { status, readAudit };
