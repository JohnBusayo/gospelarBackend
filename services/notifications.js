// services/notifications.js
// Single dispatcher for every outbound message — email through Resend
// (services/mailer.js) and SMS through Termii (services/sms.js). Every
// send is mirrored into notification_log so the admin dashboard can audit
// what went out and the scheduler worker can dedupe.
//
// Public API:
//   sendNow({ kind, channel, recipient, payload, dedupeKey, metadata })
//     → { ok, id?, error?, error_code? }; idempotent if dedupeKey is set.
//   schedule({ kind, channel, recipient, payload, runAt, dedupeKey })
//     → row in notification_schedule; picked up by the worker.
//   sendOrEnqueueReminder(...)   convenience for event reminders.
//   broadcast({ kind, recipients, payload })   fan-out with per-recipient logging.
//   startScheduler()             call once at boot — polls every 60s.
//
// Templates: emails ship inline (small set, mirrors mailer.js style). SMS
// bodies are short plain strings; long messages auto-truncate at the Termii
// 918-char limit in services/sms.js.

const db = require('../db');
const { sendMail }       = require('./mailer');
const { sendSms }        = require('./sms');

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// kind ↦ { subject, html, sms } generator. Each gets called with the route's
// payload object and returns the channel-specific shape. Email-only kinds can
// return { sms: null } to suppress SMS even if the recipient opted in.
// ─────────────────────────────────────────────────────────────────────────────
const BRAND = 'Gospelar';

function shellEmail(heading, bodyHtml, ctaUrl, ctaText) {
  // Shared shell mirroring mailer.js shape but trimmed for transactional use.
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0F172A">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
<tr><td style="padding:24px 28px;border-bottom:1px solid #E2E8F0;font-size:14px;font-weight:800;letter-spacing:-0.3px">${BRAND}</td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 14px;font-size:22px;font-weight:900;letter-spacing:-0.5px;line-height:1.25">${heading}</h1>
<div style="font-size:14.5px;line-height:1.65">${bodyHtml}</div>
${ctaUrl ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px"><tr>
<td style="background:#2563EB;border-radius:10px"><a href="${ctaUrl}" style="display:inline-block;padding:13px 22px;color:#fff;font-weight:700;font-size:14px;text-decoration:none">${ctaText || 'Open →'}</a></td>
</tr></table>` : ''}
</td></tr>
<tr><td style="padding:18px 28px;background:#F8FAFC;border-top:1px solid #E2E8F0;font-size:11.5px;color:#64748B;line-height:1.6">
You received this email because you registered on ${BRAND}. To stop reminders, update your notification preferences in your profile.
</td></tr>
</table>
</td></tr>
</table></body></html>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const TEMPLATES = {
  // Event registration confirmation — fires once per attendee right after
  // a successful POST /register. Payload: { eventTitle, attendeeName,
  // ticketCode, eventStartsAt?, eventLocation?, ticketUrl? }
  'ticket.confirmation': (p) => ({
    subject: `You're registered — ${p.eventTitle || 'event'}`,
    html: shellEmail(
      `✓ You're registered for ${esc(p.eventTitle)}`,
      `<p style="margin:0 0 14px">Hi ${esc(p.attendeeName || 'there')},</p>
       <p style="margin:0 0 14px">Your registration is confirmed. Your ticket code is
       <strong style="font-family:ui-monospace,Menlo,monospace">${esc(p.ticketCode)}</strong>.</p>
       ${p.eventStartsAt ? `<p style="margin:0 0 14px">📅 ${esc(p.eventStartsAt)}</p>` : ''}
       ${p.eventLocation  ? `<p style="margin:0 0 14px">📍 ${esc(p.eventLocation)}</p>` : ''}
       <p style="margin:0">Save this email — show the ticket code on arrival for check-in.</p>`,
      p.ticketUrl, 'View ticket →',
    ),
    sms: `${BRAND}: You're registered for ${p.eventTitle}. Ticket: ${p.ticketCode}. Show this code at check-in.`,
  }),

  // T-7, T-1day, T-1hour reminders. Payload: same as confirmation plus { whenLabel }.
  'event.reminder': (p) => ({
    subject: `Reminder: ${p.eventTitle} — ${p.whenLabel || 'soon'}`,
    html: shellEmail(
      `${esc(p.eventTitle)} — ${esc(p.whenLabel || 'coming up')}`,
      `<p style="margin:0 0 14px">Hi ${esc(p.attendeeName || 'there')},</p>
       <p style="margin:0 0 14px">Quick reminder that <strong>${esc(p.eventTitle)}</strong>
       is ${esc(p.whenLabel || 'coming up')}.</p>
       ${p.eventStartsAt ? `<p style="margin:0 0 14px">📅 ${esc(p.eventStartsAt)}</p>` : ''}
       ${p.eventLocation  ? `<p style="margin:0 0 14px">📍 ${esc(p.eventLocation)}</p>` : ''}
       <p style="margin:0">Your ticket code: <strong>${esc(p.ticketCode)}</strong></p>`,
      p.ticketUrl, 'View ticket →',
    ),
    sms: `${BRAND}: ${p.eventTitle} ${p.whenLabel || ''}. Ticket: ${p.ticketCode}.`,
  }),

  // Subscription / per-book payment success. Payload: { planLabel, amountLabel,
  // expiresLabel, email }.
  'payment.success': (p) => ({
    subject: `Payment confirmed — ${p.planLabel || 'your subscription'}`,
    html: shellEmail(
      `✓ Payment confirmed`,
      `<p style="margin:0 0 14px">Hi,</p>
       <p style="margin:0 0 14px">Your payment of <strong>${esc(p.amountLabel || '—')}</strong>
       for <strong>${esc(p.planLabel || 'your subscription')}</strong> went through.
       ${p.expiresLabel ? `Access runs until ${esc(p.expiresLabel)}.` : ''}</p>
       <p style="margin:0">Open the app and your subscription will activate automatically.</p>`,
      null, null,
    ),
    sms: `${BRAND}: Payment of ${p.amountLabel || ''} confirmed for ${p.planLabel || 'your plan'}.${p.expiresLabel ? ` Active until ${p.expiresLabel}.` : ''}`,
  }),

  // Admin-composed broadcast. Payload: { subject, body, ctaUrl?, ctaText? }
  'announcement': (p) => ({
    subject: p.subject || `${BRAND} — announcement`,
    html: shellEmail(
      esc(p.subject || 'Announcement'),
      // Allow line breaks in the admin's body text. No HTML tags survive
      // (we esc()) so admins can't accidentally inject markup.
      esc(p.body || '').split('\n').map((line) => `<p style="margin:0 0 12px">${line || '&nbsp;'}</p>`).join(''),
      p.ctaUrl, p.ctaText,
    ),
    // Truncate aggressively for SMS — Termii charges per segment.
    sms: `${BRAND}: ${(p.subject ? p.subject + ' — ' : '')}${(p.body || '').replace(/\s+/g, ' ').trim().slice(0, 200)}`,
  }),
};

function render(kind, payload) {
  const tpl = TEMPLATES[kind];
  if (!tpl) throw new Error(`Unknown notification kind: ${kind}`);
  return tpl(payload || {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Core dispatch
// ─────────────────────────────────────────────────────────────────────────────

// Returns { ok, id?, error?, dedupeHit? }. If a row with the same dedupe_key
// already exists in notification_log, returns { ok:true, dedupeHit:true }
// without re-sending — keeps reminders idempotent across worker restarts.
async function sendNow({ kind, channel, recipient, payload, dedupeKey, metadata }) {
  if (!kind || !channel || !recipient) {
    return { ok: false, error: 'kind, channel, recipient are required.' };
  }
  if (channel !== 'email' && channel !== 'sms') {
    return { ok: false, error: `Unsupported channel: ${channel}` };
  }

  // Dedupe check — handled here rather than via the unique index alone so we
  // can return a clear { dedupeHit: true } without burning a provider call.
  if (dedupeKey) {
    const dup = await db.query(
      `SELECT id FROM notification_log WHERE dedupe_key = $1 AND status = 'sent' LIMIT 1`,
      [dedupeKey],
    );
    if (dup.rows.length) {
      return { ok: true, dedupeHit: true, id: dup.rows[0].id };
    }
  }

  let rendered;
  try { rendered = render(kind, payload); }
  catch (e) { return { ok: false, error: e.message, error_code: 'unknown_kind' }; }

  let result;
  if (channel === 'email') {
    result = await sendMail({
      to:      recipient,
      subject: rendered.subject,
      html:    rendered.html,
    });
  } else {
    if (!rendered.sms) {
      return { ok: false, error: 'This notification kind has no SMS body.', error_code: 'no_sms_body' };
    }
    result = await sendSms({ to: recipient, body: rendered.sms });
  }

  try {
    await db.query(
      `INSERT INTO notification_log
         (kind, channel, recipient, subject, dedupe_key, status,
          provider, provider_id, error, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        kind,
        channel,
        String(recipient).toLowerCase(),
        rendered.subject || null,
        dedupeKey || null,
        result.ok ? 'sent' : 'failed',
        result.provider || (channel === 'email' ? 'resend' : 'termii'),
        result.id || null,
        result.ok ? null : (result.error || 'unknown error'),
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  } catch (e) {
    // 23505 = unique violation on dedupe_key — means a parallel writer beat
    // us to it. Treat as a dedupe hit, no error to caller.
    if (e.code === '23505') return { ok: true, dedupeHit: true };
    console.error('notifications.log:', e.code, e.message);
  }

  return result;
}

// Persist a future send. The worker polls notification_schedule every 60s
// and dispatches due rows by calling sendNow with the stored payload.
async function schedule({ kind, channel, recipient, payload, runAt, dedupeKey }) {
  if (!kind || !channel || !recipient || !runAt) {
    return { ok: false, error: 'kind, channel, recipient, runAt are required.' };
  }
  try {
    const r = await db.query(
      `INSERT INTO notification_schedule (kind, channel, recipient, payload, dedupe_key, run_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6)
       RETURNING id, run_at`,
      [kind, channel, recipient, JSON.stringify(payload || {}), dedupeKey || null, runAt],
    );
    return { ok: true, id: r.rows[0].id, run_at: r.rows[0].run_at };
  } catch (e) {
    console.error('notifications.schedule:', e.code, e.message);
    return { ok: false, error: e.message };
  }
}

// Fan out to a list of (email, phone?, name?) recipients. Per-recipient
// failures are recorded in the log but don't abort the broadcast. Returns
// per-recipient outcomes so the admin UI can show which sends went through.
async function broadcast({ kind, recipients, payload, channels }) {
  const wantEmail = (channels || ['email', 'sms']).includes('email');
  const wantSms   = (channels || ['email', 'sms']).includes('sms');
  const out = [];
  for (const r of recipients || []) {
    const recipientPayload = { ...(payload || {}), attendeeName: r.name || payload?.attendeeName };
    if (wantEmail && r.email) {
      const res = await sendNow({
        kind, channel: 'email', recipient: r.email, payload: recipientPayload,
        metadata: { broadcast: true, ...(r.metadata || {}) },
      });
      out.push({ email: r.email, channel: 'email', ok: res.ok, error: res.error || null });
    }
    if (wantSms && r.phone) {
      const res = await sendNow({
        kind, channel: 'sms', recipient: r.phone, payload: recipientPayload,
        metadata: { broadcast: true, ...(r.metadata || {}) },
      });
      out.push({ phone: r.phone, channel: 'sms', ok: res.ok, error: res.error || null });
    }
  }
  return { sent: out.filter((x) => x.ok).length, failed: out.filter((x) => !x.ok).length, results: out };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reminder worker — picks up due rows once a minute. Disable with
// NOTIFICATIONS_SCHEDULER=off (useful for tests / one-off scripts).
// ─────────────────────────────────────────────────────────────────────────────
async function runScheduler() {
  if (process.env.NOTIFICATIONS_SCHEDULER === 'off') return;
  let due;
  try {
    const r = await db.query(
      `SELECT id, kind, channel, recipient, payload, dedupe_key
         FROM notification_schedule
        WHERE dispatched_at IS NULL AND run_at <= NOW()
        ORDER BY run_at ASC
        LIMIT 25`,
    );
    due = r.rows;
  } catch (e) {
    console.error('notifScheduler (select):', e.code, e.message);
    return;
  }
  for (const row of due) {
    // Claim first so two replicas don't double-send the same row. The unique
    // dedupe_key index in notification_log is the final guard.
    try {
      const claim = await db.query(
        `UPDATE notification_schedule
            SET dispatched_at = NOW(), attempts = attempts + 1
          WHERE id = $1 AND dispatched_at IS NULL
          RETURNING id`,
        [row.id],
      );
      if (!claim.rows.length) continue;   // another worker beat us
    } catch (e) {
      console.error('notifScheduler (claim):', row.id, e.message);
      continue;
    }
    try {
      const r = await sendNow({
        kind:       row.kind,
        channel:    row.channel,
        recipient:  row.recipient,
        payload:    row.payload || {},
        dedupeKey:  row.dedupe_key,
      });
      if (!r.ok && !r.dedupeHit) {
        await db.query(
          `UPDATE notification_schedule SET last_error = $2 WHERE id = $1`,
          [row.id, r.error || 'unknown'],
        );
      }
    } catch (e) {
      console.error('notifScheduler (dispatch):', row.id, e.message);
      await db.query(
        `UPDATE notification_schedule SET last_error = $2 WHERE id = $1`,
        [row.id, e.message || 'threw'],
      ).catch(() => {});
    }
  }
}

function startScheduler() {
  setInterval(runScheduler, 60_000);
}

module.exports = {
  sendNow,
  schedule,
  broadcast,
  startScheduler,
  // exported for testing / direct admin probes
  render,
  runScheduler,
};
