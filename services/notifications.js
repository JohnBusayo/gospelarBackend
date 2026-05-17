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
const { buildBadgePdf, buildTicketPdf, buildFormPdf } = require('./ticketPdf');
const { sign: signDownloadToken } = require('./downloadTokens');

// Origin used to build absolute download URLs in the email body. Falls back
// to the brand domain so links still work when PUBLIC_APP_URL isn't set.
function publicOrigin() {
  return (process.env.PUBLIC_APP_URL || 'https://gospelar.app').replace(/\/$/, '');
}

// Build the three Download-X button URLs for a confirmation email. Each
// carries a signed token containing the same payload we render PDFs from,
// so the download endpoint regenerates the file without touching the DB.
function downloadUrls(payload) {
  if (!payload?.ticketCode) return null;
  const token = signDownloadToken(payload, { ttlSeconds: 60 * 60 * 24 * 365 });
  const origin = publicOrigin();
  const t = encodeURIComponent(token);
  return {
    ticket: `${origin}/api/notifications/download/ticket.pdf?token=${t}`,
    badge:  `${origin}/api/notifications/download/badge.pdf?token=${t}`,
    form:   `${origin}/api/notifications/download/form.pdf?token=${t}`,
  };
}

// Three-button row rendered into the confirmation email body. Email clients
// vary wildly in CSS support — nested tables are the only reliable way to
// keep three pill buttons on one row (and stack them in narrow viewports
// like the iOS preview pane). Returns '' when downloads are unavailable.
function downloadButtonsHtml(urls) {
  if (!urls) return '';
  const btn = (href, label) => `
    <td align="center" valign="middle" style="padding:4px">
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0">
        <tr><td style="background:#0F172A;border-radius:10px">
          <a href="${href}" style="display:inline-block;padding:11px 18px;color:#FFFFFF;font-weight:700;font-size:13px;letter-spacing:0.02em;text-decoration:none;white-space:nowrap">${label}</a>
        </td></tr>
      </table>
    </td>`;
  return `
    <div style="margin:6px 0 22px">
      <div style="font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#64748B;margin-bottom:8px">Download your copy</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
        ${btn(urls.ticket, '⬇ Ticket PDF')}
        ${btn(urls.badge,  '⬇ Badge PDF')}
        ${btn(urls.form,   '⬇ Form PDF')}
      </tr></table>
      <div style="font-size:11.5px;color:#64748B;margin-top:8px;line-height:1.55">
        These same files are attached to this email — tap an attachment to save it directly, or use the buttons above if your inbox hides attachments.
      </div>
    </div>
  `;
}

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

// Hosted QR generator — same service the web ticket uses. We encode the
// check-in URL so a scanner at the door opens the staff flow directly.
// PUBLIC_APP_URL gives a sensible origin when the ticket payload didn't
// include a full ticketUrl (older clients, programmatic test sends, etc).
function ticketQrSrc(payload) {
  const origin = (process.env.PUBLIC_APP_URL || 'https://gospelar.app').replace(/\/$/, '');
  const target = `${origin}/check-in?code=${encodeURIComponent(payload.ticketCode || '')}`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(target)}`;
}

// Format an ISO datetime for the human-friendly "When" line. Leaves
// pre-formatted strings (e.g. from event.reminder) untouched.
function fmtWhen(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-NG', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// One <tr> in the right-hand details table. Skipped when value is empty
// so the email doesn't grow useless rows for unfilled fields.
function detailRow(label, value) {
  if (value == null || value === '') return '';
  return `<tr>
    <td style="padding:6px 12px 6px 0;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748B;white-space:nowrap;vertical-align:top">${esc(label)}</td>
    <td style="padding:6px 0;font-size:14px;color:#0F172A">${value}</td>
  </tr>`;
}

// Role colour palette — mirrors TICKET_ROLES in the frontend's mockData.js
// so the digital tag (web) and the email tag stay visually consistent.
// Each entry is a {from,to} colour pair used to build a linear-gradient.
const ROLE_GRADIENTS = {
  attendee: { from: '#0EA5E9', to: '#4F46E5', label: 'Attendee' },  // sky → indigo
  staff:    { from: '#10B981', to: '#0F766E', label: 'Staff'    },  // emerald → teal
  speaker:  { from: '#F59E0B', to: '#E11D48', label: 'Speaker'  },  // amber → rose
};

function roleColours(role) {
  return ROLE_GRADIENTS[String(role || 'attendee').toLowerCase()] || ROLE_GRADIENTS.attendee;
}

// HTML version of the TicketTag React component — same visual idea (role-
// coloured stripe + avatar + name + code + role pill) using nested tables so
// Gmail/Outlook lay it out cleanly. Rendered as the hero of the email so the
// recipient sees what they need before scrolling.
// Build the avatar cell — photo when the payload carries one (data URL or
// raw base64), gradient initials block otherwise. Email clients clip <img>
// with border-radius unevenly, so we wrap in a rounded background and let
// the photo fill the square.
function avatarHtml({ photo, name, gradient }) {
  const initials = String(name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => (w[0] || '').toUpperCase()).join('') || '?';
  if (photo) {
    const src = String(photo).startsWith('data:')
      ? photo
      : `data:image/jpeg;base64,${photo}`;
    return `<img src="${src}" alt="" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:10px;object-fit:cover;border:1px solid #E2E8F0" />`;
  }
  return `<div style="width:48px;height:48px;border-radius:10px;background:${gradient};color:#FFFFFF;font-weight:800;font-size:18px;line-height:48px;text-align:center;letter-spacing:0.5px">${esc(initials)}</div>`;
}

function ticketTagHtml(p) {
  const role     = roleColours(p.role);
  const gradient = `linear-gradient(135deg, ${role.from} 0%, ${role.to} 100%)`;

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;border-spacing:0;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:14px;overflow:hidden;margin:0 0 18px">
      <tr>
        <td width="8" style="background:${gradient};padding:0;width:8px;line-height:0;font-size:0">&nbsp;</td>
        <td style="padding:14px 16px">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">
            <tr>
              <td valign="middle" width="56" style="padding-right:12px">
                ${avatarHtml({ photo: p.attendeePhoto, name: p.attendeeName, gradient })}
              </td>
              <td valign="middle">
                <div style="font-size:10px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#64748B;line-height:1.2">
                  <span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${gradient};color:#FFFFFF;letter-spacing:0.14em">${esc(role.label)}</span>
                  ${p.eventTitle ? `<span style="color:#94A3B8;margin-left:8px">${esc(p.eventTitle)}</span>` : ''}
                </div>
                <div style="font-weight:800;font-size:15px;color:#0F172A;margin-top:4px;letter-spacing:-0.2px">${esc(p.attendeeName || 'Attendee')}</div>
                <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#475569;margin-top:2px">${esc(p.ticketCode)}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

const TEMPLATES = {
  // Event registration confirmation — fires once per attendee right after
  // a successful POST /register. The email is the ticket: it includes a
  // scannable QR, the banner, and the full ticket details so an attendee
  // can show it at the door without first opening the web ticket.
  // Payload: { eventTitle, attendeeName, ticketCode, eventStartsAt?,
  //   eventLocation?, ticketUrl?, ticketTypeName?, accommodationName?,
  //   roomLabel?, seatLabel?, groupName? }
  'ticket.confirmation': (p) => {
    const firstName = String(p.attendeeName || '').trim().split(/\s+/)[0] || 'there';
    const qrUrl     = ticketQrSrc(p);
    const whenLine  = fmtWhen(p.eventStartsAt);
    const rowsHtml  = [
      detailRow('Event', esc(p.eventTitle || '—')),
      detailRow('When',  whenLine ? esc(whenLine) : null),
      detailRow('Where', p.eventLocation ? esc(p.eventLocation) : null),
      detailRow('Ticket', p.ticketTypeName ? esc(p.ticketTypeName) : null),
      detailRow('Room',  p.accommodationName ? esc(p.accommodationName) : null),
      detailRow('Assigned', p.roomLabel ? esc(p.roomLabel) : null),
      detailRow('Seat',  p.seatLabel ? `<strong style="font-weight:700">${esc(p.seatLabel)}</strong>` : null),
      detailRow('Group', p.groupName ? esc(p.groupName) : null),
      detailRow('Code',  `<span style="font-family:ui-monospace,Menlo,monospace;font-weight:700">${esc(p.ticketCode)}</span>`),
    ].join('');

    // The visual ticket sits inside shellEmail's body slot. We use a single
    // wide table so Gmail/Outlook lay out the QR + details cleanly — flex
    // and grid both fall apart in email clients, but nested tables work.
    const bodyHtml = `
      <div style="border-radius:12px;overflow:hidden;background:linear-gradient(135deg,#2563EB 0%,#DB2777 100%);color:#FFFFFF;padding:22px 24px;margin:0 0 18px">
        <div style="font-size:11px;font-weight:800;letter-spacing:0.22em;text-transform:uppercase;opacity:0.9">You're in!</div>
        <div style="margin-top:6px;font-size:20px;font-weight:900;letter-spacing:-0.3px;line-height:1.25">${esc(p.eventTitle || 'Event')}</div>
        ${whenLine || p.eventLocation ? `<div style="margin-top:8px;font-size:13px;opacity:0.92">${[whenLine ? esc(whenLine) : '', p.eventLocation ? esc(p.eventLocation) : ''].filter(Boolean).join(' &nbsp;·&nbsp; ')}</div>` : ''}
      </div>

      ${/* Quick-flash digital tag — the lightweight version of the ticket
            shown at the top of the on-screen ticket page. Mirrors the React
            TicketTag.jsx so the email and the web feel like one product. */
        ticketTagHtml(p)}

      ${/* Inline download buttons — give recipients on email clients that
            collapse attachments (Outlook web, some Gmail mobile widgets) a
            visible path to grab the ticket / badge / form without coming
            back to the website. Same files as the attachments below. */
        downloadButtonsHtml(downloadUrls(p))}

      <p style="margin:0 0 12px;font-size:14.5px">Hi ${esc(firstName)},</p>
      <p style="margin:0 0 18px;font-size:14.5px">
        Thanks for registering for <strong>${esc(p.eventTitle || 'this event')}</strong>.
        Your ticket is below — show this QR code at check-in, or read out the code
        <span style="font-family:ui-monospace,Menlo,monospace;font-weight:700">${esc(p.ticketCode)}</span>.
      </p>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin:0 0 22px">
        <tr>
          <td valign="top" style="padding:0 16px 0 0;width:200px">
            <img src="${qrUrl}" alt="QR code for ticket ${esc(p.ticketCode)}" width="180" height="180" style="display:block;width:180px;height:180px;border:1px solid #E2E8F0;border-radius:12px;background:#FFFFFF" />
          </td>
          <td valign="top">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">${rowsHtml}</table>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 10px;font-size:14px;color:#334155">
        Need to make changes? Reply to this email and we'll help.
      </p>
      <p style="margin:0;font-size:14px;color:#334155">
        Grace and peace,<br/><strong>The Gospelar team</strong>
      </p>
    `;

    return {
      subject: `You're registered — ${p.eventTitle || 'event'}`,
      html: shellEmail(
        `Your ticket for ${esc(p.eventTitle || 'the event')}`,
        bodyHtml,
        p.ticketUrl, 'Open ticket online →',
      ),
      sms: `${BRAND}: You're registered for ${p.eventTitle}. Ticket: ${p.ticketCode}. Show this code at check-in.`,
    };
  },

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
    // Ticket confirmations carry three PDF attachments: the full ticket
    // page, the printable CR80 badge, and the filled registration form.
    // Generated lazily so other kinds (reminders, announcements) don't pay
    // the PDF cost. Failures here are non-fatal — the email still sends
    // with the inline HTML ticket and download buttons; we just skip
    // attachments.
    let attachments = null;
    if (kind === 'ticket.confirmation' && payload?.ticketCode) {
      try {
        const [ticketPdf, badgePdf, formPdf] = await Promise.all([
          buildTicketPdf(payload),
          buildBadgePdf(payload),
          buildFormPdf(payload),
        ]);
        attachments = [
          { filename: `ticket-${payload.ticketCode}.pdf`, content: ticketPdf },
          { filename: `badge-${payload.ticketCode}.pdf`,  content: badgePdf  },
          { filename: `form-${payload.ticketCode}.pdf`,   content: formPdf   },
        ];
      } catch (e) {
        console.warn('[notifications] PDF generation failed for', payload.ticketCode, '-', e.message);
      }
    }
    result = await sendMail({
      to:      recipient,
      subject: rendered.subject,
      html:    rendered.html,
      attachments,
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
