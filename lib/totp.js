'use strict';
// Códigos de un solo uso por tiempo (TOTP, RFC 6238): compatibles con Google Authenticator, Authy, Aegis, etc.
const crypto = require('crypto');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; }
function b32decode(s) { let bits = ''; for (const c of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
const newSecret = () => b32encode(crypto.randomBytes(20));
function hotp(secret, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest(), o = h[19] & 15;
  return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1000000).padStart(6, '0');
}
// devuelve el "paso" de 30 s que coincidió (para impedir reusar el mismo código) o null; tolera ±1 paso por desfase de reloj
function verify(secret, code, now = Date.now()) {
  const step = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) { const a = Buffer.from(hotp(secret, step + d)), b = Buffer.from(String(code)); if (a.length === b.length && crypto.timingSafeEqual(a, b)) return step + d; }
  return null;
}
const uri = (user, secret) => `otpauth://totp/webterm:${encodeURIComponent(user)}?secret=${secret}&issuer=webterm&algorithm=SHA1&digits=6&period=30`;
module.exports = { newSecret, verify, hotp, uri };
