// HMAC-signed tokens for the event payment flow.
//
// We sign two distinct token kinds:
//   • session — minted at /payments/initialize, holds the original request
//     shape (event id, ticket type, qty, expected amount, reference). The
//     verify endpoint reads it back to confirm the same caller is verifying
//     the same payment they kicked off, and that the amount the provider
//     charged matches what we quoted.
//   • proof   — minted at /payments/verify after the provider says paid.
//     The frontend hands it to /api/events/:id/register as proof that this
//     paid registration was actually paid for. The register handler verifies
//     it before accepting a paid registration.
//
// Both tokens are stateless — no DB row needed. Trade-off: a stolen token
// is valid until its `exp`, which is why both have short TTLs (30 min for
// session, 15 min for proof).

const crypto = require('crypto');

function getSecret() {
  return (
    process.env.EVENT_PAYMENT_SECRET
    || process.env.SESSION_SECRET
    || process.env.JWT_SECRET
    // Last-resort default so dev works without env setup. Anyone deploying
    // to prod without setting one of the above gets a console warning so
    // the misconfiguration is at least noisy.
    || 'dev-event-payment-secret-change-me'
  );
}

if (
  process.env.NODE_ENV === 'production'
  && !process.env.EVENT_PAYMENT_SECRET
  && !process.env.SESSION_SECRET
  && !process.env.JWT_SECRET
) {
  console.warn(
    '[eventPaymentToken] WARNING: no EVENT_PAYMENT_SECRET / SESSION_SECRET / JWT_SECRET set in production.',
  );
}

function sign(payload, ttlSec = 1800) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = Buffer.from(JSON.stringify({ ...payload, exp }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'missing' };
  const [body, sig] = token.split('.');
  if (!body || !sig) return { ok: false, error: 'malformed' };
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'bad_signature' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'bad_payload' };
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: 'expired' };
  }
  return { ok: true, payload };
}

module.exports = { sign, verify };
