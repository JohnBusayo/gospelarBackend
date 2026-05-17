// routes/auth.js
// User auth — register/login/validate-session/change-password/delete-account.
// Single-session enforcement: each successful login overwrites session_token,
// older devices get evicted. Pass force=true to override the "already logged
// in elsewhere" guard.
//
// Also exposes two passwordless sign-in paths used by the registration site:
//   POST /api/auth/google              — verify a Google ID token, upsert user
//   POST /api/auth/magic-link/send     — email a one-tap signed link
//   GET  /api/auth/magic-link/verify   — consume the link, issue a session

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { isValidEmail } = require('../utils/helpers');
const { sendMail } = require('../services/mailer');
const { sign: signToken, verify: verifyToken } = require('../services/downloadTokens');

const router = express.Router();

router.post('/api/auth/register', async (req, res) => {
  const { email, password, full_name, role = 'student', church_code } = req.body;
  const safeRole = ['student', 'teacher'].includes(role) ? role : 'student';
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  // Teachers MUST provide a valid church invite code so their data flows to
  // the right church admin. Students don't need one.
  let churchId = null;
  if (safeRole === 'teacher') {
    const code = (church_code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Teachers must provide a church invite code.' });
    const c = await db.query('SELECT id FROM churches WHERE invite_code = $1', [code]);
    if (!c.rows.length) return res.status(400).json({ error: 'Unknown church code. Ask your church admin for the correct code.' });
    churchId = c.rows[0].id;
  }

  try {
    const existing = await db.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'Account already exists.' });
    const hash = await bcrypt.hash(password, 12);

    // Teachers start as 'pending' — the church admin must approve them.
    // Students get the default 'approved' status.
    const approvalStatus = safeRole === 'teacher' ? 'pending' : 'approved';

    const r = await db.query(
      `INSERT INTO users (email,password_hash,full_name,role,church_id,approval_status)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id,email,full_name,role,church_id,approval_status`,
      [email.toLowerCase(), hash, full_name || null, safeRole, churchId, approvalStatus]
    );
    await db.query(
      `INSERT INTO user_profiles (email,display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [email.toLowerCase(), full_name || null]
    );
    const user = r.rows[0];

    // Pending teachers get a 201 with a pending flag — no token issued.
    if (user.approval_status === 'pending') {
      return res.status(201).json({
        message: 'Application submitted. Your church admin will review and approve your account before you can sign in.',
        user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, church_id: user.church_id },
        approval_status: 'pending',
        pending: true,
      });
    }

    const token = Buffer.from(`${user.email}:${Date.now()}:${Math.random()}`).toString('base64');
    res.status(201).json({
      message: 'Account created!',
      user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, church_id: user.church_id },
      token,
    });
  } catch (e) { console.error('register:', e.message); res.status(500).json({ error: 'Registration failed.' }); }
});

router.post('/api/auth/login', async (req, res) => {
  const { email, password, force = false } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  try {
    const r = await db.query(
      `SELECT id,email,password_hash,full_name,role,session_token,session_at,
              COALESCE(approval_status,'approved') AS approval_status,
              rejected_reason
         FROM users WHERE email=$1`,
      [email.toLowerCase()]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'No account found with this email.' });
    const user  = r.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password.' });

    // Teacher approval gate — block pending/rejected before issuing a token.
    if (user.role === 'teacher' && user.approval_status !== 'approved') {
      const status  = user.approval_status;
      const message = status === 'pending'
        ? 'Your teacher account is awaiting approval from your church admin. You will be able to sign in once approved.'
        : (user.rejected_reason
            ? `Your teacher account application was declined: ${user.rejected_reason}`
            : 'Your teacher account application was declined. Contact your church admin.');
      return res.status(403).json({ error: status, message });
    }
    // Single-session: refuse if another device has signed in within 30 days,
    // unless caller explicitly says force=true (will evict the other device).
    if (user.session_token && user.session_at) {
      const ageDays = (Date.now() - new Date(user.session_at).getTime()) / 86400000;
      if (ageDays < 30 && !force) {
        return res.status(409).json({
          error: 'already_logged_in',
          message: 'This account is already logged in on another device. Do you want to log that device out?',
        });
      }
    }
    const token = Buffer.from(`${user.email}:${Date.now()}:${Math.random()}`).toString('base64');
    await db.query('UPDATE users SET session_token=$1, session_at=NOW() WHERE email=$2', [token, user.email]);
    const prof = await db.query('SELECT * FROM user_profiles WHERE email=$1', [user.email]);
    console.log('[Auth] Login: %s (force=%s)', user.email, force);
    res.json({
      message: 'Login successful!',
      user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role || 'student' },
      profile: prof.rows[0] || null, token,
    });
  } catch (e) { console.error('login:', e.message); res.status(500).json({ error: 'Login failed.' }); }
});

router.post('/api/auth/validate-session', async (req, res) => {
  const { email, token } = req.body;
  if (!email || !token) return res.status(400).json({ valid: false, reason: 'missing' });
  try {
    const r = await db.query('SELECT session_token FROM users WHERE LOWER(email)=LOWER($1)', [email]);
    if (!r.rows.length) return res.json({ valid: false, reason: 'user_not_found' });
    const stored = r.rows[0].session_token;
    if (!stored) return res.json({ valid: false, reason: 'no_token' });
    const valid = stored === token;
    res.json({ valid, reason: valid ? null : 'session_replaced' });
  } catch (e) { res.status(500).json({ valid: false, reason: 'error' }); }
});

router.post('/api/auth/change-password', async (req, res) => {
  const { email, current_password, new_password } = req.body;
  if (!email || !current_password || !new_password) return res.status(400).json({ error: 'All fields required.' });
  if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  try {
    const r = await db.query('SELECT password_hash FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found.' });
    if (!await bcrypt.compare(current_password, r.rows[0].password_hash))
      return res.status(401).json({ error: 'Current password incorrect.' });
    const hash = await bcrypt.hash(new_password, 12);
    await db.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE email=$2', [hash, email.toLowerCase()]);
    res.json({ message: 'Password changed.' });
  } catch (e) { res.status(500).json({ error: 'Could not change password.' }); }
});

router.delete('/api/auth/account', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required.' });
  try {
    const r = await db.query('SELECT password_hash FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found.' });
    if (!await bcrypt.compare(password, r.rows[0].password_hash))
      return res.status(401).json({ error: 'Incorrect password.' });
    await db.query('DELETE FROM users WHERE email=$1', [email.toLowerCase()]);
    await db.query('DELETE FROM user_profiles WHERE email=$1', [email.toLowerCase()]);
    await db.query('DELETE FROM user_scores WHERE email=$1', [email.toLowerCase()]);
    res.json({ message: 'Account deleted.' });
  } catch (e) { res.status(500).json({ error: 'Could not delete account.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Passwordless sign-in
// ─────────────────────────────────────────────────────────────────────────────

// Shared session minter — used by both Google and magic-link paths so the
// frontend always gets the same shape back as /api/auth/login. Issues a
// random session_token, persists it on `users.session_token`, and returns
// the user + token tuple. `provider` is just for logging today, but a future
// users.auth_provider column can read it without changing this signature.
async function issueSession(user, provider) {
  const token = Buffer.from(`${user.email}:${Date.now()}:${Math.random()}`).toString('base64');
  await db.query(
    'UPDATE users SET session_token=$1, session_at=NOW() WHERE email=$2',
    [token, user.email],
  );
  const prof = await db.query('SELECT * FROM user_profiles WHERE email=$1', [user.email]);
  console.log('[Auth] Passwordless login: %s (provider=%s)', user.email, provider);
  return {
    user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role || 'student' },
    profile: prof.rows[0] || null,
    token,
  };
}

// Upsert a user by email — used when neither Google nor magic-link callers
// have created an account yet. `students` is the default role; we don't ask
// for a password because these flows are passwordless. password_hash gets a
// random unguessable string so the existing email/password login path can't
// be used against this account without going through a password reset.
async function upsertPasswordlessUser({ email, full_name }) {
  const lower = String(email).toLowerCase();
  const existing = await db.query(
    'SELECT id, email, full_name, role FROM users WHERE email=$1',
    [lower],
  );
  if (existing.rows.length) {
    // Refresh full_name on every sign-in so display names stay current with
    // Google profile changes, but only when we actually have one to write.
    if (full_name) {
      await db.query('UPDATE users SET full_name=$2 WHERE email=$1', [lower, full_name]);
    }
    return existing.rows[0];
  }
  // Random unguessable placeholder so password login can't be brute-forced
  // against a Google-only account.
  const placeholder = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  const r = await db.query(
    `INSERT INTO users (email,password_hash,full_name,role,approval_status)
     VALUES ($1,$2,$3,'student','approved')
     RETURNING id, email, full_name, role`,
    [lower, placeholder, full_name || null],
  );
  await db.query(
    `INSERT INTO user_profiles (email,display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [lower, full_name || null],
  );
  return r.rows[0];
}

// POST /api/auth/google
// Body: { id_token } — the credential string returned by Google Identity
// Services on the client. We verify by hitting Google's tokeninfo endpoint
// (no key, no SDK), check that `aud` matches our configured client id, then
// upsert the user and issue a session in the same shape as /api/auth/login.
router.post('/api/auth/google', async (req, res) => {
  const idToken = String(req.body?.id_token || req.body?.credential || '').trim();
  if (!idToken) return res.status(400).json({ error: 'id_token is required.' });

  let claims;
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!r.ok) return res.status(401).json({ error: 'Google rejected that sign-in.' });
    claims = await r.json();
  } catch (e) {
    console.error('google verify:', e.message);
    return res.status(502).json({ error: 'Could not reach Google to verify sign-in.' });
  }

  // aud check — the token has to have been minted for OUR Google client id.
  // Without this, anyone with any Google ID token from any site could sign
  // in as that email. GOOGLE_CLIENT_ID is comma-separated to support having
  // separate web vs mobile client ids on the same backend.
  const allowed = String(process.env.GOOGLE_CLIENT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) {
    return res.status(500).json({ error: 'Server is missing GOOGLE_CLIENT_ID configuration.' });
  }
  if (!allowed.includes(claims.aud)) {
    console.warn('[Auth] google aud mismatch: got %s, allowed %j', claims.aud, allowed);
    return res.status(401).json({ error: 'Sign-in token was not issued for this app.' });
  }

  if (!claims.email) return res.status(400).json({ error: 'Google response had no email.' });
  if (claims.email_verified === 'false' || claims.email_verified === false) {
    return res.status(403).json({ error: 'Your Google email is not verified.' });
  }

  try {
    const user = await upsertPasswordlessUser({
      email: claims.email,
      full_name: claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || null,
    });
    const out = await issueSession(user, 'google');
    res.json({ message: 'Signed in with Google.', ...out });
  } catch (e) {
    console.error('google upsert:', e.message);
    res.status(500).json({ error: 'Could not complete Google sign-in.' });
  }
});

// POST /api/auth/magic-link/send
// Body: { email, redirect? }
// Mails the user a one-tap sign-in link valid for 15 minutes. Token is an
// HMAC-signed payload (see services/downloadTokens.js) so no extra schema
// is needed — the verify endpoint pulls the email out of the signature.
router.post('/api/auth/magic-link/send', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const redirect = String(req.body?.redirect || '/dashboard').slice(0, 500);
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });

  const token = signToken({ kind: 'magic-link', email, redirect }, { ttlSeconds: 15 * 60 });
  const origin = String(process.env.PUBLIC_APP_URL || req.headers.origin || '').replace(/\/$/, '');
  // We send the user to the FRONTEND verify route (not the API) so the SPA
  // can show a "signing you in…" screen and stash the session in the right
  // storage. The frontend forwards the token to /api/auth/magic-link/verify.
  const link = `${origin || ''}/auth/magic?token=${encodeURIComponent(token)}`;

  try {
    await sendMail({
      to: email,
      subject: 'Your Gospelar sign-in link',
      html: magicLinkHtml(link),
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('magic-link send:', e.message);
    res.status(500).json({ ok: false, error: 'Could not send sign-in email.' });
  }
});

// Plain inline template — avoids growing services/notifications.js for a
// single one-shot kind. Mirrors the shellEmail look-and-feel by hand.
function magicLinkHtml(link) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0F172A">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:32px 16px"><tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
<tr><td style="padding:24px 28px;border-bottom:1px solid #E2E8F0;font-size:14px;font-weight:800">Gospelar</td></tr>
<tr><td style="padding:28px">
  <h1 style="margin:0 0 14px;font-size:22px;font-weight:900">Tap to sign in</h1>
  <p style="margin:0 0 18px;font-size:14.5px;line-height:1.6">
    Click the button below to sign in. The link expires in 15 minutes and can only be used once.
  </p>
  <table cellpadding="0" cellspacing="0"><tr><td style="background:#2563EB;border-radius:10px">
    <a href="${link}" style="display:inline-block;padding:13px 22px;color:#fff;font-weight:700;font-size:14px;text-decoration:none">Sign in to Gospelar →</a>
  </td></tr></table>
  <p style="margin:18px 0 0;font-size:12px;color:#64748B;line-height:1.55">
    If you didn't ask to sign in, just ignore this email — no account was created or signed in.
  </p>
</td></tr></table></td></tr></table></body></html>`;
}

// GET /api/auth/magic-link/verify?token=...
// Verifies the token, upserts the user, issues a session. Returns the same
// shape as POST /api/auth/login so AuthContext on the frontend can stash it.
router.get('/api/auth/magic-link/verify', async (req, res) => {
  const token = String(req.query?.token || '').trim();
  const v = verifyToken(token);
  if (!v.ok || v.payload?.kind !== 'magic-link' || !v.payload.email) {
    return res.status(400).json({ error: `Sign-in link is no longer valid (${v.error || 'wrong kind'}).` });
  }
  try {
    const user = await upsertPasswordlessUser({ email: v.payload.email });
    const out = await issueSession(user, 'magic-link');
    res.json({ message: 'Signed in.', redirect: v.payload.redirect || '/dashboard', ...out });
  } catch (e) {
    console.error('magic-link verify:', e.message);
    res.status(500).json({ error: 'Could not complete sign-in.' });
  }
});

module.exports = router;
