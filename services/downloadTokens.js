// services/downloadTokens.js
//
// Sign / verify short-lived download tokens for the per-attendee ticket
// asset URLs we embed in confirmation emails. The flow:
//
//   1. When we send a ticket.confirmation, we mint a token from the same
//      payload the PDFs were rendered from (sign({ payload, exp })).
//   2. The email body has three buttons — Download ticket / badge / form —
//      each pointing at /api/notifications/download/<kind>.pdf?token=<t>.
//   3. The download route verifies the token, re-renders the PDF on demand
//      from the embedded payload, and streams it back as an attachment.
//
// Tokens are HMAC-SHA256(secret, base64url(payload)+'.'+exp), encoded as
// `<base64url-payload>.<exp>.<base64url-sig>`. JSON-only payloads — same
// shape as ticketPayload() output, so the renderers don't need to branch.
// Default expiry is 365 days; tickets stay useful for the whole event
// window plus a generous grace period for late attendees.

const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year
const ALGO = 'sha256';

// Secret resolution. Priority:
//   1. DOWNLOAD_SIGNING_KEY (preferred — dedicated key per role).
//   2. SESSION_SECRET (already used elsewhere in the backend, so a single
//      shared secret keeps prod setup simple in tiny deployments).
//   3. A hard-coded dev fallback so local `npm run dev` works without env
//      gymnastics. Logged at startup so it's obvious in prod logs if the
//      operator forgot to set a real secret.
function resolveSecret() {
  const k = process.env.DOWNLOAD_SIGNING_KEY || process.env.SESSION_SECRET;
  if (k && k.length >= 16) return k;
  console.warn('[downloadTokens] No DOWNLOAD_SIGNING_KEY/SESSION_SECRET set — using dev fallback. DO NOT use in production.');
  return 'gospelar-dev-only-download-key-change-me-please';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? 0 : 4 - (str.length % 4);
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(b64, 'base64');
}

// timingSafeEqual on equal-length buffers only. crypto throws otherwise.
function safeEqual(a, b) {
  const ab = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function sign(payload, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds | 0);
  const body = b64url(JSON.stringify(payload || {}));
  const head = `${body}.${exp}`;
  const sig  = crypto.createHmac(ALGO, resolveSecret()).update(head).digest();
  return `${body}.${exp}.${b64url(sig)}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'missing token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed token' };
  const [body, expStr, sigB64] = parts;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return { ok: false, error: 'bad expiry' };
  if (exp < Math.floor(Date.now() / 1000)) return { ok: false, error: 'expired' };

  const expected = crypto.createHmac(ALGO, resolveSecret()).update(`${body}.${expStr}`).digest();
  let provided;
  try { provided = b64urlDecode(sigB64); }
  catch { return { ok: false, error: 'bad signature encoding' }; }
  if (!safeEqual(expected, provided)) return { ok: false, error: 'bad signature' };

  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); }
  catch { return { ok: false, error: 'bad payload' }; }

  return { ok: true, payload, exp };
}

module.exports = { sign, verify };
