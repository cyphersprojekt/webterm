'use strict';
// Miniaturas de imágenes (sharp), PDF (pdftoppm) y video (ffmpeg), con caché en disco.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

let sharp = null; try { sharp = require('sharp'); sharp.concurrency(1); } catch { /* opcional */ }
const have = (c) => spawnSync('which', [c]).status === 0;
const HAS_PDF = have('pdftoppm'), HAS_VIDEO = have('ffmpeg');

const IMG = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.tif', '.tiff', '.svg']);
const VID = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v']);
const kindOf = (file) => {
  const e = path.extname(file).toLowerCase();
  if (IMG.has(e)) return sharp ? 'image' : null;
  if (e === '.pdf') return HAS_PDF && sharp ? 'pdf' : null;
  if (VID.has(e)) return HAS_VIDEO && sharp ? 'video' : null;
  return null;
};
const isImage = (file) => IMG.has(path.extname(file).toLowerCase());
const SIZE = 144, MAX_BYTES = 200 * 1024 * 1024;

function capture(cmd, args, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }); const chunks = []; let n = 0;
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (d) => { n += d.length; if (n > 30 * 1024 * 1024) p.kill('SIGKILL'); else chunks.push(d); });
    p.on('error', reject);
    p.on('close', () => { clearTimeout(t); const b = Buffer.concat(chunks); b.length ? resolve(b) : reject(new Error('sin salida')); });
  });
}
let active = 0; const waiting = [];
const slot = () => new Promise((r) => { const go = () => { active++; r(); }; active < 3 ? go() : waiting.push(go); });
const release = () => { active--; waiting.shift()?.(); };

async function thumbFor(dir, file, st) {
  const kind = kindOf(file); if (!kind || !st.isFile() || st.size > MAX_BYTES) return null;
  const key = crypto.createHash('sha1').update(`${file}|${st.mtimeMs}|${st.size}`).digest('hex');
  const out = path.join(dir, key + '.webp');
  if (fs.existsSync(out)) return out;
  await slot();
  try {
    if (fs.existsSync(out)) return out;
    let input = file;
    if (kind === 'pdf') input = await capture('pdftoppm', ['-jpeg', '-f', '1', '-l', '1', '-scale-to', String(SIZE * 2), file]);
    else if (kind === 'video') input = await capture('ffmpeg', ['-v', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', `scale=${SIZE * 2}:-1`, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-']);
    const tmp = out + '.' + process.pid + '.tmp';
    await sharp(input, { limitInputPixels: 2e8, failOn: 'none' }).rotate().resize(SIZE, SIZE, { fit: 'cover', position: 'attention' }).webp({ quality: 72 }).toFile(tmp);
    fs.renameSync(tmp, out);
    return out;
  } finally { release(); }
}
function cleanup(dir, days = 30) {
  try { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (Date.now() - fs.statSync(p).mtimeMs > days * 864e5) fs.rmSync(p, { force: true }); } } catch {}
}
module.exports = { thumbFor, kindOf, isImage, caps: { image: !!sharp, pdf: HAS_PDF && !!sharp, video: HAS_VIDEO && !!sharp }, cleanup };
