// services/sms.js
// Termii-backed SMS sender. Termii is a Nigerian SMS gateway with cheap
// rates on local routes and DND-bypass for transactional messages, so it's
// a better fit than Twilio for a church platform mostly sending to NG
// numbers. Drop-in alternative: swap the request body for Twilio's shape.
//
// Failure model: same as mailer — best-effort. Returns { ok, id?, error?, error_code? }
// rather than throwing, so a failed SMS never rolls back the primary
// operation that scheduled it.
//
// Required env:
//   TERMII_API_KEY      — get from https://accounts.termii.com
//   TERMII_SENDER_ID    — optional, defaults to 'Gospelar'. Must be approved
//                         by Termii before delivery to NG networks (otherwise
//                         it falls back to a generic numeric sender).
//   SMS_PROVIDER        — optional. 'off' to disable all SMS sends globally
//                         (useful in dev / when the API key isn't ready yet).

const axios = require('axios');

const TERMII_URL = 'https://api.ng.termii.com/api/sms/send';

function getConfig() {
  return {
    apiKey:   process.env.TERMII_API_KEY || '',
    senderId: process.env.TERMII_SENDER_ID || 'Gospelar',
    disabled: process.env.SMS_PROVIDER === 'off',
  };
}

// Normalise to E.164-ish: digits only, prefix with +234 for 11-digit NG
// numbers that start with 0, leave +-prefixed numbers alone, leave 13+
// digit numbers alone. Termii also accepts the local 0-prefixed format
// for NG, but normalising up front lets us send to international numbers
// without a code change.
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.startsWith('+')) return s.replace(/[^\d+]/g, '');
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  // NG local format (e.g. 08012345678) → +2348012345678
  if (digits.length === 11 && digits.startsWith('0')) return '+234' + digits.slice(1);
  // Already country-coded NG (e.g. 2348012345678) → +234…
  if (digits.length === 13 && digits.startsWith('234')) return '+' + digits;
  // Anything else → assume already international, prepend +
  return '+' + digits;
}

/**
 * Send a single SMS. Returns { ok, id?, error?, error_code? }.
 * @param {Object} args
 * @param {string} args.to        Recipient phone — accepts NG-local or international.
 * @param {string} args.body      Message text (Termii caps at 918 chars across 6 segments).
 * @param {string} [args.from]    Override sender id (must be approved by Termii).
 */
async function sendSms({ to, body, from }) {
  const cfg = getConfig();
  const finalFrom = from || cfg.senderId;

  if (cfg.disabled) {
    return { ok: false, error: 'SMS_PROVIDER=off — sending disabled.', error_code: 'disabled', from: finalFrom };
  }
  if (!cfg.apiKey) {
    console.warn('[sms] TERMII_API_KEY not set — skipping SMS to', to);
    return { ok: false, error: 'TERMII_API_KEY is not set on the server.', error_code: 'no_api_key', from: finalFrom };
  }
  if (!to || !body) {
    return { ok: false, error: 'Missing to/body.', error_code: 'missing_fields', from: finalFrom };
  }

  const phone = normalizePhone(to);
  if (!phone) {
    return { ok: false, error: 'Invalid recipient phone.', error_code: 'bad_phone', from: finalFrom };
  }

  try {
    const r = await axios.post(TERMII_URL, {
      api_key: cfg.apiKey,
      to:      phone.replace('+', ''),    // Termii wants digits only
      from:    finalFrom,
      sms:     String(body).slice(0, 918),
      type:    'plain',
      channel: 'generic',                  // 'generic' = standard route; 'dnd' bypasses DND for OTPs
    }, { timeout: 15_000 });

    const data = r.data || {};
    // Termii returns 200 even for some errors; the source of truth is data.code
    // (== 'ok' on success) or data.message_id presence.
    if (data.message_id) {
      console.log('[sms] sent', { id: data.message_id, to: phone, from: finalFrom });
      return { ok: true, id: data.message_id, from: finalFrom, provider: 'termii' };
    }
    const err = data.message || data.error || 'Termii returned no message_id.';
    console.warn('[sms] Termii error', '\n  to:', phone, '\n  body:', JSON.stringify(data));
    return {
      ok: false,
      error: err,
      error_code: data.code || 'termii_no_id',
      provider: 'termii',
      provider_response: data,
      from: finalFrom,
    };
  } catch (e) {
    const status = e.response?.status || 0;
    const detail = e.response?.data?.message || e.response?.data || e.message;
    console.warn('[sms] network/auth error', status, typeof detail === 'string' ? detail : JSON.stringify(detail));
    return {
      ok: false,
      error: typeof detail === 'string' ? detail : (detail?.message || e.message),
      error_code: status === 401 ? 'unauthorized' : 'network_error',
      status,
      provider: 'termii',
      from: finalFrom,
    };
  }
}

module.exports = { sendSms, normalizePhone };
