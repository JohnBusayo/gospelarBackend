// routes/notifications.js
// HTTP surface for the notification system:
//   PUT  /api/profile/:email/notifications     — opt in/out of SMS, reminders
//   GET  /api/admin/notifications              — recent sent log
//   POST /api/admin/notifications/test         — fire a one-off email or SMS
//   POST /api/admin/notifications/broadcast    — fan-out to a recipient list
//
// The two existing routes that "send a notification" stay where they are
// (ticket email lives in routes/payments-ish flows when events ship; church
// approval emails live in routes/churchAdmin.js). They go through
// services/notifications.js so every send is in the audit log.

const express = require('express');
const db = require('../db');
const { adminAuth }    = require('../middleware/auth');
const { isValidEmail } = require('../utils/helpers');
const { sendNow, schedule, broadcast } = require('../services/notifications');
const { normalizePhone }               = require('../services/sms');
const { verify: verifyDownloadToken }  = require('../services/downloadTokens');
const { buildTicketPdf, buildBadgePdf, buildFormPdf } = require('../services/ticketPdf');

const router = express.Router();

// Build a `ticket.confirmation`/`event.reminder` payload from a frontend-
// supplied Ticket object. Keeps the route handlers tiny — they just hand
// over the `ticket` body and let this helper map field names. The full
// shape lets the email template render a self-contained visual ticket
// (banner + QR + details) rather than just a code + link.
//
// We also carry the full `attendeeProfile` blob through unchanged so the
// filled-form PDF (services/ticketPdf.js → buildFormPdf) has every field
// the registration form collected. Existing renderers ignore it; the form
// PDF is the only consumer today.
function ticketPayload(ticket, extra = {}) {
  return {
    eventTitle:        ticket.eventTitle || '',
    attendeeName:      ticket.attendeeName || '',
    attendeeEmail:     ticket.attendeeEmail || '',
    attendeePhone:     ticket.attendeePhone || ticket.attendeeProfile?.phone || null,
    // Photo travels two paths today: top-level (older clients, local fallback)
    // or nested in attendeeProfile.photo (canonical for backend-issued tickets,
    // since we keep the registration form fields in event_tickets.attendee_profile).
    attendeePhoto:     ticket.attendeePhoto || ticket.attendeeProfile?.photo || null,
    attendeeProfile:   ticket.attendeeProfile || null,
    ticketCode:        ticket.code || '',
    role:              ticket.role || 'attendee',
    eventStartsAt:     ticket.eventStartsAt || extra.eventStartsAt || null,
    eventLocation:     ticket.eventLocation || extra.eventLocation || null,
    ticketUrl:         ticket.ticketUrl     || extra.ticketUrl     || null,
    ticketTypeName:    ticket.ticketTypeName || null,
    accommodationName: ticket.accommodationName || null,
    roomLabel:         ticket.roomLabel || null,
    seatLabel:         ticket.seatLabel || null,
    groupName:         ticket.groupName || null,
    groupType:         ticket.groupType || null,
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Download endpoints — embedded in confirmation emails as buttons. Tokens
// are HMAC-signed copies of the ticket payload; the route regenerates the
// requested PDF on demand and streams it. No DB lookup needed, no auth — the
// token itself proves the request originated from a real email we sent.
// ─────────────────────────────────────────────────────────────────────────────

// Map kind → (filename prefix, PDF builder). The route accepts only the
// three known kinds so a tampered URL can't request an arbitrary builder.
const DOWNLOAD_KINDS = {
  ticket: { build: buildTicketPdf, prefix: 'ticket' },
  badge:  { build: buildBadgePdf,  prefix: 'badge'  },
  form:   { build: buildFormPdf,   prefix: 'form'   },
};

router.get('/api/notifications/download/:kind.pdf', async (req, res) => {
  const kind = String(req.params.kind || '').toLowerCase();
  const handler = DOWNLOAD_KINDS[kind];
  if (!handler) return res.status(404).send('Not found.');

  const token = String(req.query.token || '').trim();
  const v = verifyDownloadToken(token);
  if (!v.ok) {
    return res.status(403).send(`Link is no longer valid (${v.error}).`);
  }

  let pdf;
  try {
    pdf = await handler.build(v.payload || {});
  } catch (e) {
    console.error('[notifications.download] render failed:', kind, e.message);
    return res.status(500).send('Could not render that file.');
  }

  const code = (v.payload?.ticketCode || 'ticket').replace(/[^A-Za-z0-9_-]+/g, '');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${handler.prefix}-${code}.pdf"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(pdf);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ticket-flow endpoints (called by the registration frontend)
// The backend doesn't yet own the events/tickets tables — the frontend hands
// over a self-contained `ticket` object so we can dispatch without a lookup.
// When the events tables ship, swap `req.body.ticket` for a DB read.
// ─────────────────────────────────────────────────────────────────────────────

// Format an ISO date for the email body. Falls back gracefully on bad input.
function fmtEventStart(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return null; }
}

// POST /api/notifications/email-ticket  body: { to, ticket }
// `to` lets the registrar CC a copy to the primary registrant whose email
// differs from the attendee on the ticket. The dedupe key bakes in `to`
// so the registrant copy and the attendee copy don't collide.
router.post('/api/notifications/email-ticket', async (req, res) => {
  const to     = String(req.body?.to || '').trim().toLowerCase();
  const ticket = req.body?.ticket || {};
  if (!isValidEmail(to))   return res.status(400).json({ ok: false, error: 'Invalid recipient email.' });
  if (!ticket.code)        return res.status(400).json({ ok: false, error: 'ticket.code is required.' });

  const ownerEmail = String(ticket.attendeeEmail || '').toLowerCase();
  const isCopy     = ownerEmail && ownerEmail !== to;

  const r = await sendNow({
    kind: 'ticket.confirmation',
    channel: 'email',
    recipient: to,
    payload: ticketPayload(ticket),
    // Distinct dedupe key per recipient so the attendee and the registrant
    // (when CC'd) each get exactly one copy. `isCopy` flag in the suffix
    // documents the second send for log readers.
    dedupeKey: `ticket:${ticket.code}:email:confirmation:${to}`,
    metadata: {
      ticketCode: ticket.code,
      eventId:    ticket.eventId || null,
      groupId:    ticket.groupId || null,
      ...(isCopy ? { registrantCopy: true, attendeeEmail: ownerEmail } : {}),
    },
  });
  res.json({ ok: r.ok, id: r.id || null, error: r.error || null, dedupeHit: r.dedupeHit || false });
});

// POST /api/notifications/sms-ticket  body: { to, ticket }
router.post('/api/notifications/sms-ticket', async (req, res) => {
  const to     = String(req.body?.to || '').trim();
  const ticket = req.body?.ticket || {};
  if (!normalizePhone(to)) return res.status(400).json({ ok: false, error: 'Invalid recipient phone.' });
  if (!ticket.code)        return res.status(400).json({ ok: false, error: 'ticket.code is required.' });

  const r = await sendNow({
    kind: 'ticket.confirmation',
    channel: 'sms',
    recipient: to,
    payload: ticketPayload(ticket),
    dedupeKey: `ticket:${ticket.code}:sms:confirmation`,
    metadata: { ticketCode: ticket.code, eventId: ticket.eventId || null, groupId: ticket.groupId || null },
  });
  res.json({ ok: r.ok, id: r.id || null, error: r.error || null, dedupeHit: r.dedupeHit || false });
});

// POST /api/notifications/schedule-reminder
// body: { ticket, sendAt, kind?, channels? }
// kind defaults to 'event.reminder'. channels defaults to ['email'].
router.post('/api/notifications/schedule-reminder', async (req, res) => {
  const ticket   = req.body?.ticket || {};
  const sendAt   = req.body?.sendAt;
  const kind     = String(req.body?.kind || 'event.reminder');
  const channels = Array.isArray(req.body?.channels) && req.body.channels.length
    ? req.body.channels.map((c) => String(c).toLowerCase()).filter((c) => ['email', 'sms'].includes(c))
    : ['email'];

  if (!ticket.code)            return res.status(400).json({ ok: false, error: 'ticket.code is required.' });
  if (!sendAt)                 return res.status(400).json({ ok: false, error: 'sendAt (ISO) is required.' });
  const when = new Date(sendAt);
  if (Number.isNaN(when.getTime())) return res.status(400).json({ ok: false, error: 'sendAt is not a valid date.' });

  const out = [];
  for (const channel of channels) {
    const recipient = channel === 'email' ? ticket.attendeeEmail : ticket.attendeePhone;
    if (!recipient) { out.push({ channel, ok: false, error: 'No recipient on ticket.' }); continue; }
    const r = await schedule({
      kind, channel, recipient,
      payload: ticketPayload(ticket, {
        whenLabel:     req.body?.whenLabel     || null,
        eventStartsAt: fmtEventStart(ticket.eventStartsAt),
      }),
      runAt: when,
      dedupeKey: `${channel}:${kind}:${ticket.code}`,
    });
    out.push({ channel, ok: r.ok, id: r.id || null, error: r.error || null });
  }
  res.json({ ok: out.every((x) => x.ok), scheduled: out });
});

// POST /api/admin/notifications/announce
// body: { eventId?, subject, message, recipients, channels? }
// Thin alias over /broadcast that takes a human-shaped `message` field.
router.post('/api/admin/notifications/announce', adminAuth, async (req, res) => {
  const subject    = req.body?.subject || null;
  const body       = req.body?.message || req.body?.body || '';
  const channels   = Array.isArray(req.body?.channels) && req.body.channels.length
    ? req.body.channels.map((c) => String(c).toLowerCase()).filter((c) => ['email', 'sms'].includes(c))
    : ['email', 'sms'];
  const recipients = Array.isArray(req.body?.recipients) ? req.body.recipients : [];

  if (!body && !subject) return res.status(400).json({ error: 'Provide at least subject or message.' });
  if (!recipients.length) return res.status(400).json({ error: 'recipients[] is required.' });

  const result = await broadcast({
    kind: 'announcement',
    recipients,
    payload: { subject, body, eventId: req.body?.eventId || null },
    channels,
  });
  res.json(result);
});

// User opt-in/out. SMS defaults off, reminders defaults on. Phone is
// validated (must normalise) but stored unchanged so the user sees what
// they typed when they come back. Sending always goes through normalize-
// Phone() in sms.js so the wire format is consistent.
router.put('/api/profile/:email/notifications', async (req, res) => {
  const email = decodeURIComponent(req.params.email || '').toLowerCase().trim();
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email.' });

  const phone = req.body?.phone != null ? String(req.body.phone).trim() || null : undefined;
  const smsOptIn       = req.body?.sms_opt_in;
  const remindersOptIn = req.body?.reminders_opt_in;

  if (phone) {
    if (!normalizePhone(phone)) return res.status(400).json({ error: 'Phone number is not recognisable.' });
  }
  try {
    // Make sure a profile row exists, then patch.
    await db.query(
      `INSERT INTO user_profiles (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      [email],
    );
    const r = await db.query(
      `UPDATE user_profiles SET
         phone            = COALESCE($2, phone),
         sms_opt_in       = COALESCE($3, sms_opt_in),
         reminders_opt_in = COALESCE($4, reminders_opt_in),
         updated_at       = NOW()
       WHERE email = $1
       RETURNING email, phone, sms_opt_in, reminders_opt_in`,
      [
        email,
        phone === undefined ? null : phone,
        typeof smsOptIn === 'boolean' ? smsOptIn : null,
        typeof remindersOptIn === 'boolean' ? remindersOptIn : null,
      ],
    );
    res.json({ profile: r.rows[0] });
  } catch (e) {
    console.error('PUT /api/profile/:email/notifications:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update notification preferences.' });
  }
});

// Admin reads recent sends. ?limit=, ?kind=, ?channel=, ?status=, ?recipient=
// All filters are optional and combine with AND.
router.get('/api/admin/notifications', adminAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const params = [];
  const where  = [];
  if (req.query.kind)      { params.push(String(req.query.kind));        where.push(`kind = $${params.length}`); }
  if (req.query.channel)   { params.push(String(req.query.channel));     where.push(`channel = $${params.length}`); }
  if (req.query.status)    { params.push(String(req.query.status));      where.push(`status = $${params.length}`); }
  if (req.query.recipient) {
    params.push(String(req.query.recipient).toLowerCase());
    where.push(`LOWER(recipient) = $${params.length}`);
  }
  params.push(limit);
  try {
    const r = await db.query(
      `SELECT id, kind, channel, recipient, subject, status, provider, provider_id,
              error, metadata, sent_at
         FROM notification_log
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY id DESC
         LIMIT $${params.length}`,
      params,
    );
    res.json({ count: r.rows.length, items: r.rows });
  } catch (e) {
    console.error('GET /api/admin/notifications:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load notification log.' });
  }
});

// One-off test send. Body: { channel:'email'|'sms', to, kind?, payload? }.
// `kind` defaults to a built-in test template (sent inline) so admins can
// verify the pipeline without hand-rolling a payload. Returns 200 even on
// failure — the body's { ok:false, error } is the diagnostic, matching
// /api/admin/mail-test's contract.
router.post('/api/admin/notifications/test', adminAuth, async (req, res) => {
  const channel = String(req.body?.channel || 'email').toLowerCase();
  const to      = String(req.body?.to || '').trim();
  const kind    = String(req.body?.kind || 'announcement');
  const payload = req.body?.payload || {
    subject: 'Gospelar notification health check',
    body:    `If you're reading this, the ${channel.toUpperCase()} pipeline is delivering. Sent at ${new Date().toISOString()}.`,
  };

  if (!to) return res.status(400).json({ ok: false, error: 'Recipient (to) is required.' });
  if (channel === 'email' && !isValidEmail(to)) {
    return res.status(400).json({ ok: false, error: 'Invalid recipient email.' });
  }
  if (channel === 'sms' && !normalizePhone(to)) {
    return res.status(400).json({ ok: false, error: 'Invalid recipient phone.' });
  }

  const result = await sendNow({ kind, channel, recipient: to, payload, metadata: { test: true } });
  res.json({
    ok:    result.ok,
    id:    result.id || null,
    error: result.error || null,
    error_code: result.error_code || null,
    channel, to, kind,
  });
});

// Admin-composed broadcast. Body: { kind?, channels?, subject, body, recipients?, audience? }
//   recipients: explicit list [{ email, phone?, name? }]
//   audience:   'all_subscribers' | 'all_users' | 'church:<id>' (resolves to a list)
// channels defaults to ['email','sms']. Recipients without a phone are
// skipped for SMS; SMS-opted-out profiles are filtered when audience-mode.
router.post('/api/admin/notifications/broadcast', adminAuth, async (req, res) => {
  const kind     = String(req.body?.kind || 'announcement');
  const channels = Array.isArray(req.body?.channels) && req.body.channels.length
    ? req.body.channels.map((c) => String(c).toLowerCase()).filter((c) => ['email', 'sms'].includes(c))
    : ['email', 'sms'];
  const payload = {
    subject: req.body?.subject || null,
    body:    req.body?.body    || '',
    ctaUrl:  req.body?.ctaUrl  || null,
    ctaText: req.body?.ctaText || null,
    ...(req.body?.payload || {}),
  };

  if (!payload.body && !payload.subject) {
    return res.status(400).json({ error: 'Provide at least a subject or body.' });
  }

  let recipients = Array.isArray(req.body?.recipients) ? req.body.recipients : null;

  // Audience expansion when no explicit recipients given.
  if (!recipients) {
    const audience = String(req.body?.audience || '').toLowerCase();
    try {
      let rows = [];
      if (audience === 'all_users') {
        const r = await db.query(`
          SELECT u.email,
                 COALESCE(up.phone, NULL)     AS phone,
                 COALESCE(up.display_name, u.full_name) AS name,
                 COALESCE(up.sms_opt_in, FALSE) AS sms_opt_in
            FROM users u
            LEFT JOIN user_profiles up ON up.email = u.email
        `);
        rows = r.rows;
      } else if (audience === 'all_subscribers') {
        const r = await db.query(`
          SELECT s.email,
                 up.phone,
                 COALESCE(up.display_name, NULL) AS name,
                 COALESCE(up.sms_opt_in, FALSE)  AS sms_opt_in
            FROM subscribers s
            LEFT JOIN user_profiles up ON up.email = s.email
           WHERE s.is_active = TRUE
             AND (s.expiry_date IS NULL OR s.expiry_date > NOW())
        `);
        rows = r.rows;
      } else if (audience.startsWith('church:')) {
        const cid = parseInt(audience.split(':')[1], 10);
        if (!Number.isFinite(cid)) return res.status(400).json({ error: 'Invalid church audience id.' });
        const r = await db.query(`
          SELECT u.email,
                 up.phone,
                 COALESCE(up.display_name, u.full_name) AS name,
                 COALESCE(up.sms_opt_in, FALSE) AS sms_opt_in
            FROM users u
            LEFT JOIN user_profiles up ON up.email = u.email
           WHERE u.church_id = $1
        `, [cid]);
        rows = r.rows;
      } else {
        return res.status(400).json({ error: 'Provide recipients[] or a valid audience.' });
      }
      // Strip SMS phone for opted-out users (email still goes through).
      recipients = rows.map((row) => ({
        email: row.email,
        phone: row.sms_opt_in ? row.phone : null,
        name:  row.name || null,
      })).filter((r) => r.email || r.phone);
    } catch (e) {
      console.error('broadcast audience expansion:', e.code, e.message);
      return res.status(500).json({ error: 'Failed to resolve audience.' });
    }
  }

  if (!recipients.length) return res.json({ sent: 0, failed: 0, results: [], note: 'No recipients matched.' });

  const result = await broadcast({ kind, recipients, payload, channels });
  res.json(result);
});

module.exports = router;
