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

// Per-template visual themes for the ticket + badge. Each entry carries:
//   primary    — dominant solid colour for the ticket main panel, badge body
//   secondary  — accent for the stub, gradients, hover bits
//   accent     — small punchy colour used for the "TICKET" / event-type
//                eyebrow text + price chip ring (matches the orange swooshes
//                in the reference image)
//   label      — short, all-caps event-type word ("WEDDING", "CONFERENCE")
//                shown as the eyebrow above the event title on the ticket
//   tagline    — italic script-style line above the title (mirrors the
//                "Future Forward" handwriting in the reference)
//   pillBg     — semi-transparent overlay used for date/time pills on the
//                main panel (matches primary at 18% opacity)
// Keys match templateId on events. Anything missing falls back to default.
const TEMPLATE_THEMES = {
  wedding:                 { primary: '#7C2D5A', secondary: '#DB2777', accent: '#F59E0B', label: 'WEDDING',     tagline: 'You are invited' },
  'baby-dedication':       { primary: '#9A3412', secondary: '#FB7185', accent: '#FBBF24', label: 'DEDICATION',  tagline: 'A joyful celebration' },
  'graduation-ordination': { primary: '#5B21B6', secondary: '#D946EF', accent: '#FBBF24', label: 'GRADUATION',  tagline: 'Commissioning day' },
  'workers-meeting':       { primary: '#065F46', secondary: '#10B981', accent: '#FBBF24', label: 'TRAINING',    tagline: 'Equipping leaders' },
  'children-church':       { primary: '#0369A1', secondary: '#6366F1', accent: '#FBBF24', label: 'CHILDREN',    tagline: 'A special program' },
  'church-retreat':        { primary: '#065F46', secondary: '#0F766E', accent: '#FBBF24', label: 'RETREAT',     tagline: 'Worship & rest' },
  convention:              { primary: '#0F172A', secondary: '#1656c2', accent: '#FBBF24', label: 'CONFERENCE',  tagline: 'Future Forward' },
  'youth-program':         { primary: '#9F1239', secondary: '#F97316', accent: '#FBBF24', label: 'YOUTH',       tagline: 'For the next generation' },
  'mens-fellowship':       { primary: '#064E3B', secondary: '#059669', accent: '#FBBF24', label: 'BROTHERS',    tagline: 'Breakfast & the word' },
  default:                 { primary: '#0b3a8a', secondary: '#1656c2', accent: '#FBBF24', label: 'TICKET',      tagline: 'You are invited' },
};
function themeFor(templateId) {
  return TEMPLATE_THEMES[templateId] || TEMPLATE_THEMES.default;
}

// Builds the body for the ticket.confirmation email. The actual ticket QR
// and the printable badge live ONLY in the attached PDFs (and the download
// buttons below) — the email body itself focuses on the event so the
// recipient gets all the context they need without having to open the
// attachment. Layout (top → bottom):
//
//   1. HERO CARD — theme-coloured gradient panel with a "YOU'RE IN!"
//      eyebrow, the big event title, an optional tagline, and a single
//      "date · location" meta line.
//   2. INTRO — "Hi {firstName}," + a short thanks line that points the
//      recipient at the attached PDFs (no QR or ticket code inline).
//   3. DOWNLOAD BUTTONS — Ticket PDF / Badge PDF / Form PDF. These same
//      files are attached to the email; the buttons are a fallback for
//      inboxes that hide attachments.
//   4. EVENT DETAILS PANEL — label/value rows: WHEN / ENDS / WHERE /
//      RSVP BY (with a 'View map' link on Where when a location is set),
//      plus the event summary as a free-text block.
//   5. YOUR BOOKING PANEL — attendee-specific allocations (ticket type,
//      accommodation, room, seat, group, price). Skipped if the event
//      is free / unallocated.
//   6. ORGANIZER — reply-to line so the recipient knows who to contact.
//   7. SIGN-OFF — "Grace and peace,".
//
// Note: the email body carries NO images at all — no event banner, and no
// base64 (data:) images, since an inlined image can exceed Gmail's ~102KB
// clip limit and trigger "[Message clipped] View entire message", hiding
// the content below it.
//
// All measurements are inline so email clients without head-style support
// (Outlook desktop, Gmail's classic renderer) still get the layout.
function ticketAndBadgeBodyHtml(p, firstName) {
  const theme    = themeFor(p.templateId);
  const whenLine = fmtWhen(p.eventStartsAt);
  const endsLine = fmtWhen(p.eventEndsAt);
  const deadlineLine = fmtWhen(p.eventRegistrationDeadline);
  // Hero card uses the same primary→secondary gradient the ticket+badge
  // used to use, so the email still reads as "themed for this event".
  const heroBg  = `linear-gradient(135deg, ${theme.primary} 0%, ${theme.secondary} 50%, ${theme.secondary} 100%)`;
  // Short metadata line under the hero title: "Sat, 23 May 2026, 15:30 · Lagos"
  const metaParts = [whenLine, p.eventLocation].filter(Boolean);
  const metaLine  = metaParts.join('  ·  ');

  // ── HERO CARD — "YOU'RE IN!" banner ─────────────────────────────────
  // Wide gradient panel with celebratory eyebrow + event title + meta line.
  // Linear-gradient backgrounds degrade to solid theme.primary in Outlook
  // desktop, which still reads as branded.
  const heroHtml = `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;border-spacing:0;margin:0 0 18px;border-radius:18px;overflow:hidden;background:${theme.primary}">
      <tr>
        <td style="padding:26px 28px;background:${heroBg};color:#FFFFFF">
          <div style="font-size:11px;font-weight:800;letter-spacing:0.24em;text-transform:uppercase;color:rgba(255,255,255,0.85)">
            You're in!
          </div>
          <div style="margin-top:10px;font-size:24px;font-weight:900;letter-spacing:-0.4px;line-height:1.18;color:#FFFFFF">
            ${esc(p.eventTitle || 'Event')}
          </div>
          ${p.eventTagline ? `
            <div style="margin-top:6px;font-size:13.5px;font-style:italic;color:rgba(255,255,255,0.92);letter-spacing:0.01em">
              ${esc(p.eventTagline)}
            </div>` : ''}
          ${metaLine ? `
            <div style="margin-top:8px;font-size:13px;color:rgba(255,255,255,0.92);letter-spacing:0.01em">
              ${esc(metaLine)}
            </div>` : ''}
        </td>
      </tr>
    </table>
  `;

  // ── EVENT DETAILS PANEL ────────────────────────────────────────────
  // Surface-card with label/value rows. Skips empty rows. The summary
  // (long-form description) sits below the rows as wrapped paragraph text.
  const summaryParaHtml = p.eventSummary ? `
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid #E2E8F0;font-size:14px;line-height:1.65;color:#334155;white-space:pre-wrap">
      ${esc(p.eventSummary)}
    </div>
  ` : '';

  // Wrap the location text with a Google Maps link so attendees can route to
  // the venue in one tap. We use maps.google.com/?q= because it works on
  // both Android (Maps) and iOS (Maps) without a custom URL scheme.
  const locationCell = p.eventLocation
    ? `<span>${esc(p.eventLocation)}</span>
       <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.eventLocation)}"
          style="display:inline-block;margin-left:8px;font-size:11.5px;font-weight:700;color:#2563EB;text-decoration:none">
         View map →
       </a>`
    : '';

  const detailsRows = [
    detailRow('When',     esc(whenLine || '')),
    endsLine     ? detailRow('Ends',    esc(endsLine)) : '',
    locationCell ? detailRow('Where',   locationCell) : '',
    deadlineLine ? detailRow('RSVP by', esc(deadlineLine)) : '',
  ].filter(Boolean).join('');

  const detailsPanelHtml = (detailsRows || summaryParaHtml) ? `
    <div style="margin:0 0 18px;padding:18px 20px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:14px">
      <div style="font-size:11px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#64748B;margin-bottom:10px">
        Event details
      </div>
      ${detailsRows ? `
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">
          ${detailsRows}
        </table>` : ''}
      ${summaryParaHtml}
    </div>
  ` : '';

  // ── YOUR BOOKING ───────────────────────────────────────────────────
  // Attendee-specific allocations sourced from the ticket row: which
  // ticket type they bought, the accommodation / room / seat they were
  // assigned, and (for group registrations) the group they belong to.
  // We intentionally exclude the ticket CODE here — that lives in the
  // attached ticket PDF, matching the agreed split that "ticket and
  // badge" visuals stay in the PDFs while the email body focuses on
  // event context. A free, unallocated event renders no panel.
  const priceLabel = (() => {
    const cents = Number(p.priceCents || 0);
    if (!cents) return '';
    return '₦' + Math.round(cents / 100).toLocaleString('en-NG');
  })();

  const bookingRows = [
    detailRow('Name',          esc(p.attendeeName || '')),
    p.attendeeEmail   ? detailRow('Email',         esc(p.attendeeEmail))                  : '',
    p.ticketTypeName  ? detailRow('Ticket type',   esc(p.ticketTypeName))                 : '',
    p.accommodationName
      ? detailRow('Accommodation', esc(p.accommodationName))
      : '',
    p.roomLabel       ? detailRow('Room',          esc(p.roomLabel))                      : '',
    p.seatLabel       ? detailRow('Seat',          esc(p.seatLabel))                      : '',
    p.groupName
      ? detailRow('Group',
          `${esc(p.groupName)}${p.groupType ? ` <span style="color:#64748B">(${esc(p.groupType)})</span>` : ''}`)
      : '',
    priceLabel        ? detailRow('Paid',          `<span style="font-weight:700;color:#0F172A">${esc(priceLabel)}</span>`) : '',
  ].filter(Boolean).join('');

  // Hide the whole panel for events where the only attendee data we have
  // is the name — those have nothing booking-specific to surface.
  const hasBookingExtras =
    p.attendeeEmail || p.ticketTypeName || p.accommodationName ||
    p.roomLabel || p.seatLabel || p.groupName || priceLabel;

  const bookingPanelHtml = (bookingRows && hasBookingExtras) ? `
    <div style="margin:0 0 22px;padding:18px 20px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:14px">
      <div style="font-size:11px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#64748B;margin-bottom:10px">
        Your booking
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">
        ${bookingRows}
      </table>
      <p style="margin:12px 0 0;font-size:11.5px;color:#64748B;line-height:1.55">
        Your ticket code and QR are in the attached ticket PDF.
      </p>
    </div>
  ` : '';

  // ── ORGANIZER ──────────────────────────────────────────────────────
  // Best-effort reply-to line. Falls back to "reply to this email" copy
  // when the event row has no creator_email on it.
  const organizerHtml = p.organizerEmail ? `
    <p style="margin:18px 0 8px;font-size:14px;color:#334155;line-height:1.6">
      Questions? Reach the organizer at
      <a href="mailto:${esc(p.organizerEmail)}" style="color:#2563EB;font-weight:700;text-decoration:none">${esc(p.organizerEmail)}</a>.
    </p>
  ` : `
    <p style="margin:18px 0 8px;font-size:14px;color:#334155;line-height:1.6">
      Questions? Reply to this email and we'll route it to the organizer.
    </p>
  `;

  return `
    ${heroHtml}

    <p style="margin:6px 0 10px;font-size:15px;line-height:1.55;color:#0F172A">
      Hi ${esc(firstName)},
    </p>
    <p style="margin:0 0 22px;font-size:14.5px;line-height:1.6;color:#334155">
      Thanks for registering for <strong style="color:#0F172A">${esc(p.eventTitle || 'this event')}</strong>.
      Your ticket and printable badge are attached as PDFs — bring either one
      (printed or on your phone) to check-in. The details below cover what to
      expect on the day.
    </p>

    ${downloadButtonsHtml(downloadUrls(p))}

    ${detailsPanelHtml}
    ${bookingPanelHtml}

    ${organizerHtml}
    <p style="margin:0;font-size:14px;color:#334155;line-height:1.6">
      Grace and peace,<br/><strong style="color:#0F172A">The Gospelar team</strong>
    </p>
  `;
}

// Builds the body for the GROUP confirmation email — a single message sent to
// the group's contact when a family / church group / department registers
// together. Where ticketAndBadgeBodyHtml focuses on one person, this leads
// with a roster of every member (name · title · gender · age bracket · status)
// and a single shared "Contact & emergency" panel, because in group mode the
// registration form collects identity per member but contact/emergency/other
// just once for the whole group. Layout (top → bottom):
//
//   1. HERO — themed gradient panel with the group name + event title + meta.
//   2. INTRO — "Hi {group} team," + a thanks line pointing at the attached PDFs.
//   3. EVENT DETAILS — WHEN / ENDS / WHERE / RSVP BY + summary (same as solo).
//   4. MEMBERS — numbered table: each member's name, identity line, ticket code.
//   5. CONTACT & EMERGENCY — the once-entered shared phone/email, emergency
//      contact, and any "other information" note.
//   6. ORGANIZER + SIGN-OFF.
//
// Like the solo body it embeds NO base64 images, so the message never trips
// Gmail's ~102KB clip. Per-member ticket + badge PDFs ride along as attachments.
function groupBodyHtml(p) {
  const theme        = themeFor(p.templateId);
  const whenLine     = fmtWhen(p.eventStartsAt);
  const endsLine     = fmtWhen(p.eventEndsAt);
  const deadlineLine = fmtWhen(p.eventRegistrationDeadline);
  const heroBg       = `linear-gradient(135deg, ${theme.primary} 0%, ${theme.secondary} 50%, ${theme.secondary} 100%)`;
  const members      = Array.isArray(p.members) ? p.members : [];
  const metaLine     = [whenLine, p.eventLocation].filter(Boolean).join('  ·  ');
  const groupTitle   = p.groupName || 'Your group';

  // ── HERO ──────────────────────────────────────────────────────────────
  const heroHtml = `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;border-spacing:0;margin:0 0 18px;border-radius:18px;overflow:hidden;background:${theme.primary}">
      <tr>
        <td style="padding:26px 28px;background:${heroBg};color:#FFFFFF">
          <div style="font-size:11px;font-weight:800;letter-spacing:0.24em;text-transform:uppercase;color:rgba(255,255,255,0.85)">
            Your group is in! · ${members.length} ${members.length === 1 ? 'member' : 'members'}
          </div>
          <div style="margin-top:10px;font-size:24px;font-weight:900;letter-spacing:-0.4px;line-height:1.18;color:#FFFFFF">
            ${esc(groupTitle)}
          </div>
          <div style="margin-top:6px;font-size:14px;font-weight:700;color:rgba(255,255,255,0.95)">
            ${esc(p.eventTitle || 'Event')}
          </div>
          ${metaLine ? `
            <div style="margin-top:6px;font-size:13px;color:rgba(255,255,255,0.92)">
              ${esc(metaLine)}
            </div>` : ''}
        </td>
      </tr>
    </table>
  `;

  // ── EVENT DETAILS ───────────────────────────────────────────────────────
  const summaryParaHtml = p.eventSummary ? `
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid #E2E8F0;font-size:14px;line-height:1.65;color:#334155;white-space:pre-wrap">
      ${esc(p.eventSummary)}
    </div>
  ` : '';
  const locationCell = p.eventLocation
    ? `<span>${esc(p.eventLocation)}</span>
       <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.eventLocation)}"
          style="display:inline-block;margin-left:8px;font-size:11.5px;font-weight:700;color:#2563EB;text-decoration:none">View map →</a>`
    : '';
  const detailsRows = [
    detailRow('When',     esc(whenLine || '')),
    endsLine     ? detailRow('Ends',    esc(endsLine)) : '',
    locationCell ? detailRow('Where',   locationCell) : '',
    deadlineLine ? detailRow('RSVP by', esc(deadlineLine)) : '',
  ].filter(Boolean).join('');
  const detailsPanelHtml = (detailsRows || summaryParaHtml) ? `
    <div style="margin:0 0 18px;padding:18px 20px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:14px">
      <div style="font-size:11px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#64748B;margin-bottom:10px">Event details</div>
      ${detailsRows ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">${detailsRows}</table>` : ''}
      ${summaryParaHtml}
    </div>
  ` : '';

  // ── MEMBERS ROSTER ───────────────────────────────────────────────────────
  const memberRows = members.map((m, i) => {
    const fullName = [m.title, m.name].filter(Boolean).join(' ') || `Member ${i + 1}`;
    const identity = [m.sex, m.ageBracket, m.status].filter(Boolean).join('  ·  ');
    const codeCell = [
      m.ticketCode ? `<span style="font-family:ui-monospace,Menlo,Consolas,monospace">${esc(m.ticketCode)}</span>` : '',
      m.seatLabel  ? `<span style="color:#64748B"> · Seat ${esc(m.seatLabel)}</span>` : '',
    ].filter(Boolean).join('');
    return `
      <tr>
        <td style="padding:10px 8px;vertical-align:top;border-top:1px solid #EEF2F7;font-size:13px;font-weight:800;color:#94A3B8;width:28px">${i + 1}</td>
        <td style="padding:10px 8px;vertical-align:top;border-top:1px solid #EEF2F7">
          <div style="font-size:14px;font-weight:700;color:#0F172A">${esc(fullName)}</div>
          ${identity ? `<div style="font-size:12px;color:#64748B;margin-top:2px">${esc(identity)}</div>` : ''}
        </td>
        <td style="padding:10px 8px;vertical-align:top;border-top:1px solid #EEF2F7;text-align:right;font-size:12px;color:#0F172A;white-space:nowrap">${codeCell}</td>
      </tr>`;
  }).join('');
  const membersPanelHtml = members.length ? `
    <div style="margin:0 0 18px;padding:18px 20px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:14px">
      <div style="font-size:11px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#64748B;margin-bottom:6px">Group members (${members.length})</div>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">
        ${memberRows}
      </table>
      <p style="margin:12px 0 0;font-size:11.5px;color:#64748B;line-height:1.55">Each member's ticket and printable badge are attached to this email as PDFs.</p>
    </div>
  ` : '';

  // ── SHARED CONTACT & EMERGENCY ────────────────────────────────────────────
  const emergencyLine = [p.emergency?.name, p.emergency?.phone].filter(Boolean).map(esc).join('  ·  ');
  const contactRows = [
    detailRow('Contact phone', esc(p.contact?.phone || '')),
    detailRow('Contact email', esc(p.contact?.email || '')),
    emergencyLine ? detailRow('Emergency', emergencyLine) : '',
  ].filter(Boolean).join('');
  const otherInfoHtml = p.otherInfo ? `
    <div style="margin-top:${contactRows ? '14px' : '0'};padding-top:${contactRows ? '14px' : '0'};${contactRows ? 'border-top:1px solid #E2E8F0;' : ''}font-size:14px;line-height:1.6;color:#334155;white-space:pre-wrap">
      <span style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748B;display:block;margin-bottom:4px">Other information</span>
      ${esc(p.otherInfo)}
    </div>
  ` : '';
  const sharedPanelHtml = (contactRows || otherInfoHtml) ? `
    <div style="margin:0 0 22px;padding:18px 20px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:14px">
      <div style="font-size:11px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#64748B;margin-bottom:10px">Group contact &amp; emergency</div>
      ${contactRows ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">${contactRows}</table>` : ''}
      ${otherInfoHtml}
    </div>
  ` : '';

  // ── ORGANIZER ──────────────────────────────────────────────────────────
  const organizerHtml = p.organizerEmail ? `
    <p style="margin:18px 0 8px;font-size:14px;color:#334155;line-height:1.6">
      Questions? Reach the organizer at
      <a href="mailto:${esc(p.organizerEmail)}" style="color:#2563EB;font-weight:700;text-decoration:none">${esc(p.organizerEmail)}</a>.
    </p>
  ` : `
    <p style="margin:18px 0 8px;font-size:14px;color:#334155;line-height:1.6">
      Questions? Reply to this email and we'll route it to the organizer.
    </p>
  `;

  return `
    ${heroHtml}

    <p style="margin:6px 0 10px;font-size:15px;line-height:1.55;color:#0F172A">
      Hi ${esc(groupTitle)} team,
    </p>
    <p style="margin:0 0 22px;font-size:14.5px;line-height:1.6;color:#334155">
      Thanks for registering your group for <strong style="color:#0F172A">${esc(p.eventTitle || 'this event')}</strong>.
      All ${members.length} ${members.length === 1 ? 'member is' : 'members are'} confirmed below, and each
      member's ticket and printable badge are attached as PDFs — bring either one (printed or on a phone) to check-in.
    </p>

    ${detailsPanelHtml}
    ${membersPanelHtml}
    ${sharedPanelHtml}

    ${organizerHtml}
    <p style="margin:0;font-size:14px;color:#334155;line-height:1.6">
      Grace and peace,<br/><strong style="color:#0F172A">The Gospelar team</strong>
    </p>
  `;
}


const TEMPLATES = {
  // Event registration confirmation — fires once per attendee right after
  // a successful POST /register. The email focuses on event context; the
  // scannable QR, ticket, and badge live in the attached PDFs so an attendee
  // can show them at the door without first opening the web ticket.
  // Payload: { eventTitle, attendeeName, ticketCode, eventStartsAt?,
  //   eventLocation?, ticketUrl?, ticketTypeName?, accommodationName?,
  //   roomLabel?, seatLabel?, groupName? }
  'ticket.confirmation': (p) => {
    const firstName = String(p.attendeeName || '').trim().split(/\s+/)[0] || 'there';
    const bodyHtml = ticketAndBadgeBodyHtml(p, firstName);

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

  // Group registration confirmation — ONE email to the group's contact when a
  // family / church group / department registers together. Lists every member
  // and the shared contact/emergency info. Payload:
  //   { eventTitle, eventStartsAt?, eventLocation?, eventSummary?, ...event,
  //     groupName, groupType, templateId?,
  //     contact: { phone, email }, emergency: { name, phone }, otherInfo?,
  //     members: [{ name, title, sex, ageBracket, status, ticketCode, seatLabel,
  //                 role?, attendeeProfile? }] }
  // Per-member ticket + badge PDFs are attached in sendNow().
  'group.confirmation': (p) => {
    const count = Array.isArray(p.members) ? p.members.length : 0;
    return {
      subject: `Your group is registered — ${p.groupName || 'group'} · ${p.eventTitle || 'event'}`,
      html: shellEmail(
        `Your group is registered for ${esc(p.eventTitle || 'the event')}`,
        groupBodyHtml(p),
        p.ticketUrl || null,
        p.ticketUrl ? 'Open a ticket online →' : null,
      ),
      sms: `${BRAND}: ${p.groupName || 'Your group'} (${count} ${count === 1 ? 'member' : 'members'}) is registered for ${p.eventTitle}. Tickets are in the email we sent ${p.contact?.email || 'you'}.`,
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

  // Bank-transfer registration rejected by the event creator. Payload:
  //   { eventTitle, eventId, reason, amountCents?, ticketTypeId? }
  // We include a back-link to the share-link page so the attendee can
  // re-attempt with a fresh transfer screenshot.
  'registration.rejected': (p) => {
    const origin   = (process.env.PUBLIC_APP_URL || 'https://gospelar.app').replace(/\/$/, '');
    const tryAgainUrl = p.eventId ? `${origin}/r/${encodeURIComponent(p.eventId)}` : null;
    const amount = (p.amountCents && p.amountCents > 0)
      ? `₦${(p.amountCents / 100).toLocaleString()}`
      : '';
    return {
      subject: `Update on your registration for ${p.eventTitle || 'the event'}`,
      html: shellEmail(
        `Your registration for ${esc(p.eventTitle || 'the event')} couldn't be confirmed`,
        `
        <p style="margin:0 0 14px;font-size:14.5px">Hi there,</p>
        <p style="margin:0 0 14px;font-size:14.5px">
          Thanks for submitting your registration${amount ? ` for ${esc(amount)}` : ''} to
          <strong>${esc(p.eventTitle || 'this event')}</strong>. After reviewing the
          transfer screenshot, the organizer wasn't able to verify it.
        </p>
        <div style="border-left:3px solid #DB2777;background:#FFF1F2;padding:12px 16px;border-radius:0 8px 8px 0;margin:0 0 18px">
          <div style="font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#9F1239;margin-bottom:6px">Reason from the organizer</div>
          <div style="font-size:14px;color:#0F172A;white-space:pre-wrap">${esc(p.reason || 'No reason provided.')}</div>
        </div>
        <p style="margin:0 0 14px;font-size:14.5px">
          If you've since completed (or re-attempted) the transfer, you can submit
          a fresh registration with the new proof. Your previous one stays on
          file with the organizer.
        </p>
        <p style="margin:0;font-size:14px;color:#334155">Grace and peace,<br/><strong>The Gospelar team</strong></p>
        `,
        tryAgainUrl, tryAgainUrl ? 'Re-submit your registration →' : null,
      ),
      sms: `${BRAND}: Your registration for ${p.eventTitle} couldn't be verified. Reason: ${(p.reason || '').slice(0, 120)}`,
    };
  },
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
    } else if (kind === 'group.confirmation' && Array.isArray(payload?.members) && payload.members.length) {
      // One email, many tickets — attach each member's ticket + badge PDF.
      // (Form PDFs are skipped here to keep the attachment count manageable
      // for large groups; the per-member data still lives on each ticket.)
      // Each member payload inherits the shared event fields, then overlays
      // the member's own attendee fields so the PDF renderers see the same
      // shape they get for a single ticket.confirmation send.
      try {
        const atts = [];
        for (const m of payload.members) {
          if (!m?.ticketCode) continue;
          const memberPayload = {
            ...payload,
            members:         undefined,
            ticketCode:      m.ticketCode,
            attendeeName:    m.name || '',
            attendeeProfile: m.attendeeProfile || null,
            attendeePhoto:   (m.attendeeProfile && m.attendeeProfile.photo) || null,
            seatLabel:       m.seatLabel || null,
            role:            m.role || 'attendee',
            ticketUrl:       m.ticketUrl || payload.ticketUrl || null,
          };
          const [ticketPdf, badgePdf] = await Promise.all([
            buildTicketPdf(memberPayload),
            buildBadgePdf(memberPayload),
          ]);
          atts.push({ filename: `ticket-${m.ticketCode}.pdf`, content: ticketPdf });
          atts.push({ filename: `badge-${m.ticketCode}.pdf`,  content: badgePdf  });
        }
        attachments = atts.length ? atts : null;
      } catch (e) {
        console.warn('[notifications] group PDF generation failed -', e.message);
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
