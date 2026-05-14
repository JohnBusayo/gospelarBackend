// services/mailer.js
// ─────────────────────────────────────────────────────────────────────────────
// Tiny Resend-backed transactional mailer.
//
// Failure model: send is best-effort. If RESEND_API_KEY is missing or the
// HTTP call fails, we log a warning and return — never throw — so that the
// caller's primary action (e.g. approving a church) never gets rolled back
// just because the email layer is misconfigured. The admin can still see
// the result in the dashboard and notify the pastor manually.
//
// Resend docs: https://resend.com/docs/api-reference/emails/send-email
// ─────────────────────────────────────────────────────────────────────────────

const RESEND_URL = 'https://api.resend.com/emails';

function getConfig() {
  return {
    apiKey: process.env.RESEND_API_KEY || '',
    // Default to the gospelar.com sender once the domain is verified in Resend.
    // Override via MAIL_FROM env var (e.g. set MAIL_FROM=onboarding@resend.dev
    // while you're still waiting on DNS verification — that sandbox sender
    // works without any DNS setup but only mails the Resend account owner).
    from:   process.env.MAIL_FROM      || 'Gospelar Sunday School <noreply@gospelar.com>',
  };
}

/**
 * Send a single email. Returns { ok, id?, error? }.
 *
 * @param {Object} args
 * @param {string|string[]} args.to   Recipient(s).
 * @param {string} args.subject
 * @param {string} args.html          HTML body (preferred).
 * @param {string} [args.text]        Plain-text fallback. Auto-derived from
 *                                    html if absent.
 * @param {string} [args.from]        Override sender; defaults to MAIL_FROM.
 */
async function sendMail({ to, subject, html, text, from }) {
  const cfg = getConfig();
  const finalFrom = from || cfg.from;
  if (!cfg.apiKey) {
    console.warn('[mailer] RESEND_API_KEY not set — skipping email to', to, '(' + subject + ')');
    return { ok: false, error: 'RESEND_API_KEY is not set on the server.', error_code: 'no_api_key', from: finalFrom };
  }
  if (!to || !subject || (!html && !text)) {
    console.warn('[mailer] missing to/subject/body — refusing to send');
    return { ok: false, error: 'Missing to/subject/body.', error_code: 'missing_fields', from: finalFrom };
  }
  // Resend requires either text or html; we prefer html and synthesise a
  // plain-text version when the caller didn't provide one.
  const textBody = text || htmlToText(html);

  try {
    const r = await fetch(RESEND_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    finalFrom,
        to:      Array.isArray(to) ? to : [to],
        subject,
        html,
        text:    textBody,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Surface every clue Resend gives us — domain not verified, recipient
      // restricted in sandbox mode, bad from address, etc. The full payload
      // is what the admin needs to fix it.
      const detail =
        data?.message
        || data?.error
        || (typeof data === 'string' ? data : null)
        || `HTTP ${r.status}`;
      console.warn(
        '[mailer] Resend error', r.status,
        '\n  from   :', finalFrom,
        '\n  to     :', Array.isArray(to) ? to.join(', ') : to,
        '\n  subject:', subject,
        '\n  body   :', JSON.stringify(data),
      );
      return {
        ok:          false,
        error:       detail,
        error_code:  data?.name || `http_${r.status}`,
        status:      r.status,
        provider:    'resend',
        provider_response: data,
        from:        finalFrom,
      };
    }
    console.log('[mailer] sent', { id: data.id, to, from: finalFrom, subject });
    return { ok: true, id: data.id, from: finalFrom };
  } catch (err) {
    console.warn('[mailer] network error:', err.message);
    return { ok: false, error: err.message, error_code: 'network_error', from: finalFrom };
  }
}

// Quick HTML→text fallback so Resend has something for clients that prefer it.
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// CHURCH APPROVAL TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

const BRAND      = 'Gospelar Sunday School';
const PRIMARY    = '#2563EB';
const PRIMARY_BG = '#EFF6FF';
const TEXT_DARK  = '#0F172A';
const TEXT_MUTED = '#64748B';
const BORDER     = '#E2E8F0';
// Public URL the email's <img> points at. Overridable via env so local dev
// can swap in a tunnelled URL if needed. The file is served by the
// gospelar-landing repo (public/logo.png → https://gospelar.com/logo.png).
const LOGO_URL   = process.env.MAIL_LOGO_URL || 'https://gospelar.com/logo.png';

// Shared shell — table-based layout for email-client compatibility.
function shell({ heading, body, ctaUrl, ctaText }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${TEXT_DARK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:32px 16px">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid ${BORDER};border-radius:16px;overflow:hidden">
      <tr><td style="padding:24px 28px;border-bottom:1px solid ${BORDER}">
        <table role="presentation" width="100%"><tr>
          <td style="font-size:20px;font-weight:800;letter-spacing:-0.3px">
            <img src="${LOGO_URL}" alt="" width="28" height="28" style="vertical-align:middle;display:inline-block;margin-right:10px;border-radius:6px;border:0;outline:none;text-decoration:none"/>
            <span style="vertical-align:middle">${BRAND}</span>
          </td>
          <td align="right" style="font-size:11px;color:${TEXT_MUTED};letter-spacing:1.2px;font-weight:700;text-transform:uppercase">Church Leader</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:28px">
        <h1 style="margin:0 0 14px;font-size:22px;font-weight:900;letter-spacing:-0.5px;line-height:1.25">${heading}</h1>
        <div style="font-size:14.5px;line-height:1.65;color:${TEXT_DARK}">${body}</div>
        ${ctaUrl ? `
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px"><tr>
            <td style="background:${PRIMARY};border-radius:10px"><a href="${ctaUrl}" style="display:inline-block;padding:13px 22px;color:#FFFFFF;font-weight:700;font-size:14px;text-decoration:none">${ctaText || 'Open Dashboard →'}</a></td>
          </tr></table>` : ''}
      </td></tr>
      <tr><td style="padding:18px 28px;background:#F8FAFC;border-top:1px solid ${BORDER};font-size:11.5px;color:${TEXT_MUTED};line-height:1.6">
        You received this email because someone applied to administer a church on ${BRAND}.
        If this wasn't you, ignore this message — no action is needed.
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
}

function approvalHtml({ church_name, contact_name, admin_email, admin_token, invite_code, dashboard_url }) {
  const greet = contact_name ? `Hello ${escapeHtml(contact_name)},` : 'Hello,';
  const body  = `
    <p style="margin:0 0 14px">${greet}</p>
    <p style="margin:0 0 14px">
      Your application to administer <strong>${escapeHtml(church_name)}</strong> on
      ${BRAND} has been <strong style="color:#10B981">approved</strong>. You can now sign in with the email address
      <strong>${escapeHtml(admin_email)}</strong> and the password you chose during signup.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;background:${PRIMARY_BG};border:1px solid #BFDBFE;border-radius:12px">
      <tr><td style="padding:16px 18px">
        <div style="font-size:10px;font-weight:800;letter-spacing:1.4px;color:${TEXT_MUTED};text-transform:uppercase;margin-bottom:6px">Teacher invite code</div>
        <div style="font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:18px;font-weight:800;color:${PRIMARY};letter-spacing:1px">${escapeHtml(invite_code)}</div>
        <div style="font-size:12px;color:${TEXT_MUTED};margin-top:6px">Share this with your teachers — they paste it during registration.</div>
      </td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:${PRIMARY_BG};border:1px solid #BFDBFE;border-radius:12px">
      <tr><td style="padding:16px 18px">
        <div style="font-size:10px;font-weight:800;letter-spacing:1.4px;color:${TEXT_MUTED};text-transform:uppercase;margin-bottom:6px">Admin token (treat like a password)</div>
        <div style="font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:13px;font-weight:700;color:${PRIMARY};word-break:break-all">${escapeHtml(admin_token)}</div>
        <div style="font-size:12px;color:${TEXT_MUTED};margin-top:6px">Used internally by the dashboard. Don't share publicly.</div>
      </td></tr>
    </table>
    <p style="margin:0;color:${TEXT_MUTED};font-size:13px">If you have any questions, reply to this email and a member of the Sunday School Department will help.</p>
  `;
  return shell({
    heading: '✓ Your church is approved',
    body,
    ctaUrl:  dashboard_url || null,
    ctaText: dashboard_url ? 'Sign in to the dashboard →' : null,
  });
}

function rejectionHtml({ church_name, contact_name, reason }) {
  const greet = contact_name ? `Hello ${escapeHtml(contact_name)},` : 'Hello,';
  const body  = `
    <p style="margin:0 0 14px">${greet}</p>
    <p style="margin:0 0 14px">
      Thank you for your interest in administering <strong>${escapeHtml(church_name)}</strong> on ${BRAND}.
      After reviewing your application, we are unable to grant access at this time.
    </p>
    ${reason ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;background:#FEF2F2;border:1px solid #FECACA;border-radius:12px">
        <tr><td style="padding:14px 16px">
          <div style="font-size:10px;font-weight:800;letter-spacing:1.4px;color:#991B1B;text-transform:uppercase;margin-bottom:6px">Reason</div>
          <div style="font-size:13.5px;color:#7F1D1D;line-height:1.5">${escapeHtml(reason)}</div>
        </td></tr>
      </table>` : ''}
    <p style="margin:0;color:${TEXT_MUTED};font-size:13px">
      If you believe this was decided in error, reply to this email and we'll re-review your application.
    </p>
  `;
  return shell({ heading: 'Application update', body });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

// ─────────────────────────────────────────────────────────────────────────────
// HIGH-LEVEL HELPERS used by routes
// ─────────────────────────────────────────────────────────────────────────────

async function sendApprovalEmail(church, dashboardUrl) {
  return sendMail({
    to:      church.admin_email,
    subject: `✓ ${church.name} is approved on ${BRAND}`,
    html:    approvalHtml({
      church_name:   church.name,
      contact_name:  church.contact_name,
      admin_email:   church.admin_email,
      admin_token:   church.admin_token,
      invite_code:   church.invite_code,
      dashboard_url: dashboardUrl,
    }),
  });
}

async function sendRejectionEmail(church, reason) {
  return sendMail({
    to:      church.admin_email,
    subject: `${BRAND} — application update`,
    html:    rejectionHtml({
      church_name:  church.name,
      contact_name: church.contact_name,
      reason,
    }),
  });
}

module.exports = { sendMail, sendApprovalEmail, sendRejectionEmail };
