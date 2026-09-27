// Små hjælpefunktioner uden afhængigheder.

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Tilfældigt base62-ID. 24 tegn ≈ 143 bit – umuligt at gætte. */
export function randomId(len = 24) {
  const out = []; const buf = new Uint8Array(len * 2);
  crypto.getRandomValues(buf);
  for (const b of buf) { if (b < 248) out.push(B62[b % 62]); if (out.length === len) break; }
  return out.length === len ? out.join('') : randomId(len);
}

/** 32 tilfældige bytes som hex (hemmelig opretter-nøgle). */
export function randomToken() {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 som lowercase hex. Bruger WebCrypto, med ren-JS-fallback (http på LAN har ikke crypto.subtle). */
export async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  if (globalThis.crypto?.subtle) {
    const h = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  return sha256Fallback(data);
}

function sha256Fallback(bytes) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const l = bytes.length, padLen = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(padLen);
  m.set(bytes); m[l] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(padLen - 4, l * 8); dv.setUint32(padLen - 8, Math.floor(l / 0x20000000));
  const w = new Uint32Array(64), r = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < padLen; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = r(w[i-15], 7) ^ r(w[i-15], 18) ^ (w[i-15] >>> 3), s1 = r(w[i-2], 17) ^ r(w[i-2], 19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
export const _sha256Fallback = s => sha256Fallback(new TextEncoder().encode(s));

/** Normalisér telefonnummer til cifre (evt. med +landekode). */
export function cleanPhone(p) {
  const s = String(p || '').replace(/[^\d+]/g, '');
  return s.replace(/(?!^)\+/g, '');
}
/** Dansk nummer uden +45 til MobilePay (8 cifre), ellers cifrene. */
export function mobilepayPhone(p) {
  let s = cleanPhone(p).replace(/^\+/, '');
  if (s.length === 10 && s.startsWith('45')) s = s.slice(2);
  if (s.length === 12 && s.startsWith('0045')) s = s.slice(4);
  return s;
}
/** "12345678" → "12 34 56 78" */
export function prettyPhone(p) {
  const s = cleanPhone(p);
  const m = s.match(/^(\+45)?(\d{8})$/);
  if (m) return (m[1] ? '+45 ' : '') + m[2].replace(/(\d{2})(?=\d)/g, '$1 ');
  return s;
}
export function isValidPhone(p) { return /^\+?\d{8,15}$/.test(cleanPhone(p)); }
