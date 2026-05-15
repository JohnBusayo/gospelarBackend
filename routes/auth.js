// routes/auth.js
// User auth — register/login/validate-session/change-password/delete-account.
// Single-session enforcement: each successful login overwrites session_token,
// older devices get evicted. Pass force=true to override the "already logged
// in elsewhere" guard.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { isValidEmail } = require('../utils/helpers');

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

module.exports = router;
