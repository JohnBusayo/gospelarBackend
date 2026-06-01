// routes/payments.js
// Subscription + payment + Paystack webhook routes. Heavy lifting (provider
// init / verify / errors) lives in services/payments.js so this file just
// orchestrates DB writes around the verified results.

const express = require('express');
const crypto  = require('crypto');
const db = require('../db');
const { adminAuth } = require('../middleware/auth');
const {
  isValidEmail, addDays, parseBooks, addBookToList, booksIncludeBook,
  SUBSCRIPTION_DAYS, TRIAL_DAYS,
} = require('../utils/helpers');
const {
  VALID_CATS, VALID_PLANS, PROVIDERS,
  getPlanPricing, detectProvider,
  initPaystack, initFlutterwave, initStripe,
  verifyPaystack, verifyFlutterwave, verifyStripe,
} = require('../services/payments');
const { sendNow: sendNotification } = require('../services/notifications');
const axios = require('axios');

const router = express.Router();

// Format a kobo amount as ₦ for the email body. 50000 → "₦500".
const formatNaira = (kobo) => `₦${Math.round((Number(kobo) || 0) / 100).toLocaleString('en-NG')}`;
// Format an ISO/Date for human display. Falls back to "soon" when missing
// so the template never echoes "null" or "Invalid Date".
const formatExpiry = (d) => {
  if (!d) return null;
  try { return new Date(d).toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch { return null; }
};

// Fire a payment-success notification without blocking the HTTP response.
// We don't `await` so the API stays snappy even if Resend/Termii are slow;
// notification_log captures the outcome either way.
function notifyPaymentSuccess(email, planLabel, priceKobo, expiryDate) {
  sendNotification({
    kind: 'payment.success',
    channel: 'email',
    recipient: email,
    payload: {
      planLabel,
      amountLabel:  formatNaira(priceKobo),
      expiresLabel: formatExpiry(expiryDate),
    },
    metadata: { plan: planLabel, kobo: priceKobo },
  }).catch((e) => console.warn('[notify] payment.success email:', e.message));
}

router.get('/api/subscription/plans', async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT plan_id, price_kobo, COALESCE(price_usd_cents, 0) AS price_usd_cents,
              days, updated_at
         FROM subscription_plans
        ORDER BY price_kobo`
    );
    if (!r.rows.length) {
      return res.json([
        { plan_id: 'single', price_kobo: 50000,  price_usd_cents: 0, days: SUBSCRIPTION_DAYS },
        { plan_id: 'all',    price_kobo: 100000, price_usd_cents: 0, days: SUBSCRIPTION_DAYS },
      ]);
    }
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/subscription/plans:',
      e.code || '(no code)',
      e.message || '(no message)',
      e.stack ? '\n' + e.stack.split('\n').slice(0, 4).join('\n') : '');
    res.status(500).json({ error: 'Failed to load plans.' });
  }
});

// Admin pricing — accepts NGN price_kobo (required) and optional USD price
// for international Stripe checkout. plan_id restricted by regex (not allow-
// list) so newly-seeded book SKUs work without code changes.
router.put('/api/admin/subscription/plans/:planId', adminAuth, async (req, res) => {
  const planId = String(req.params.planId || '');
  if (!/^[a-z0-9_]{1,64}$/i.test(planId)) {
    return res.status(400).json({ error: 'plan_id must be 1-64 chars, lowercase letters, digits, or underscores.' });
  }
  const price_kobo = parseInt(req.body.price_kobo, 10);
  const days       = parseInt(req.body.days,       10);
  // Optional — admins editing just NGN shouldn't accidentally wipe a USD price.
  const hasUsd = req.body.price_usd_cents != null;
  const price_usd_cents = hasUsd ? parseInt(req.body.price_usd_cents, 10) : null;
  if (!Number.isFinite(price_kobo) || price_kobo < 100) {
    return res.status(400).json({ error: 'price_kobo must be an integer ≥ 100 (i.e. ₦1).' });
  }
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    return res.status(400).json({ error: 'days must be an integer between 1 and 3650.' });
  }
  if (hasUsd && (!Number.isFinite(price_usd_cents) || price_usd_cents < 0 || price_usd_cents > 10_000_000)) {
    return res.status(400).json({ error: 'price_usd_cents must be an integer between 0 and 10,000,000.' });
  }
  try {
    const setParts = ['price_kobo = EXCLUDED.price_kobo', 'days = EXCLUDED.days', 'updated_at = NOW()'];
    if (hasUsd) setParts.push('price_usd_cents = EXCLUDED.price_usd_cents');
    const r = await db.query(`
      INSERT INTO subscription_plans (plan_id, price_kobo, price_usd_cents, days, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (plan_id) DO UPDATE SET
        ${setParts.join(',\n        ')}
      RETURNING *
    `, [planId, price_kobo, hasUsd ? price_usd_cents : 0, days]);
    res.json(r.rows[0]);
  } catch (e) {
    console.error('PUT /api/admin/subscription/plans:', e.message);
    res.status(500).json({ error: 'Failed to update plan.' });
  }
});

router.post('/api/payments/initialize', async (req, res) => {
  const { email, plan = 'single', category = 'adult', book_id = null } = req.body || {};
  const rawProvider = String(req.body?.provider || 'paystack').toLowerCase();
  const provider = PROVIDERS.includes(rawProvider) ? rawProvider : 'paystack';

  if (!email)               return res.status(400).json({ status: 'error', code: 'missing_email',   message: 'email required.' });
  if (!isValidEmail(email)) return res.status(400).json({ status: 'error', code: 'invalid_email', message: 'Invalid email.' });

  // Per-book purchases use 'book_<slug>'; otherwise legacy single/all category.
  const safeBookId = book_id && /^[a-z0-9_]{3,64}$/i.test(String(book_id))
    ? String(book_id).toLowerCase() : null;
  const planId = safeBookId
    ? `book_${safeBookId}`
    : (plan === 'all' ? 'all' : 'single');
  const safeCategory = VALID_CATS.includes(category) ? category : 'adult';

  let pricing;
  try {
    pricing = await getPlanPricing(planId);
  } catch (e) {
    pricing = {
      price_kobo:      safeBookId ? 50000 : (planId === 'all' ? 100000 : 50000),
      price_usd_cents: 0,
      days:            safeBookId ? 365 : 300,
    };
  }

  // Reference embeds provider + planId so server logs are easy to grep.
  const reference = `Gospelar_${Date.now()}_${Math.random().toString(36).slice(2, 11)}_${provider}_${planId}`.slice(0, 100);

  const PUBLIC_BASE = process.env.PUBLIC_API_URL
    || `${req.protocol}://${req.get('host')}`;
  const callbackUrl = `${PUBLIC_BASE.replace(/\/$/, '')}/api/payments/callback`;

  const metadata = {
    plan_id:  planId,
    category: planId === 'all' || safeBookId ? null : safeCategory,
    book_id:  safeBookId,
    provider,
  };
  const callArgs = { email: email.toLowerCase(), pricing, planId, reference, metadata, callbackUrl };

  let result;
  if      (provider === 'flutterwave') result = await initFlutterwave(callArgs);
  else if (provider === 'stripe')      result = await initStripe(callArgs);
  else                                 result = await initPaystack({
    ...callArgs,
    metadata: {
      ...metadata,
      custom_fields: [
        { display_name: 'Plan',     variable_name: 'plan_id',  value: planId },
        { display_name: 'Category', variable_name: 'category', value: safeBookId ? '—' : safeCategory },
      ],
    },
  });

  if (!result.ok) {
    const httpCode = result.status === 401 ? 400 : 502;
    return res.status(httpCode).json({
      status: 'error',
      code:    result.code,
      message: result.message,
      detail:  result.detail || null,
      provider,
    });
  }

  res.json({
    status:            'success',
    provider,
    authorization_url: result.authorization_url,
    reference:         result.reference,
    amount_kobo:       pricing.price_kobo,
    amount_usd_cents:  pricing.price_usd_cents,
    plan_id:           planId,
    category:          safeBookId ? null : safeCategory,
    book_id:           safeBookId,
  });
});

// Paystack/Flutterwave/Stripe redirect the user's external browser here after
// payment (the in-app WebView flow has been removed to comply with Google
// Play's Payments policy — digital subscriptions must not be transacted from
// inside a native WebView). This endpoint serves a short HTML page that
// auto-redirects to the app's custom-scheme deep link, carrying the
// reference so the app can call POST /api/verify-payment and activate the
// subscription. The HTML "Return to app" button is the user-visible fallback
// when the browser blocks the JS redirect.
router.get('/api/payments/callback', (req, res) => {
  const ref = String(
    req.query.reference || req.query.trxref ||
    req.query.tx_ref    || req.query.session_id || ''
  );
  const cancelled = /^(1|true)$/i.test(String(req.query.cancelled || ''));
  const status    = cancelled ? 'cancelled' : (ref ? 'success' : 'failed');
  const params    = new URLSearchParams({ status });
  if (ref) params.set('ref', ref);
  const deepLink  = `gospelar://payment-success?${params.toString()}`;
  const deepLinkJson = JSON.stringify(deepLink);
  const heading = cancelled ? 'Payment cancelled'
                : (ref       ? 'Payment received'
                             : 'Payment did not complete');
  const subcopy = cancelled ? 'No charge was made. Returning you to the Gospelar app.'
                : (ref       ? 'Returning you to the Gospelar app to confirm your subscription…'
                             : 'We did not receive a reference from the payment provider. Open the app and try again.');
  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading}</title>
<meta http-equiv="refresh" content="0;url=${deepLink}">
<style>html,body{margin:0;height:100%;background:#0F172A;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;}
.b{text-align:center;max-width:340px;padding:24px;}
.s{width:64px;height:64px;border:5px solid rgba(255,255,255,.18);border-top-color:#10B981;border-radius:50%;animation:spin .9s linear infinite;margin:0 auto 18px;}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:18px;margin:0 0 8px;font-weight:800}
p{font-size:13px;color:rgba(255,255,255,.6);margin:0 0 18px;line-height:1.5}
a.btn{display:inline-block;padding:11px 22px;border-radius:12px;background:#1A56DB;color:#fff;text-decoration:none;font-weight:800;font-size:13.5px}</style>
</head><body><div class="b">
<div class="s"></div>
<h1>${heading}</h1>
<p>${subcopy}</p>
<a class="btn" href="${deepLink}">Return to app</a>
<script>setTimeout(function(){window.location.href=${deepLinkJson};},150);</script>
</div></body></html>`);
});

router.post('/api/verify-payment', async (req, res) => {
  const { reference, email, category = 'adult', book_id = null } = req.body;
  if (!reference || !email) return res.status(400).json({ status: 'error', message: 'reference and email required.' });
  if (!isValidEmail(email)) return res.status(400).json({ status: 'error', message: 'Invalid email.' });
  const userEmail    = email.toLowerCase();
  const safeCategory = VALID_CATS.includes(category) ? category : 'adult';
  const provider     = detectProvider(req);
  const safeBookId   = book_id && /^[a-z0-9_]{3,64}$/i.test(String(book_id))
    ? String(book_id).toLowerCase()
    : null;
  try {
    // Stripe needs the plan's price_kobo upfront so the verify helper can
    // record an NGN-baseline amount on rows that were actually paid in USD.
    let planForBase;
    if (provider === 'stripe') {
      const planId = safeBookId ? `book_${safeBookId}` : (safeCategory === 'all' ? 'all' : 'single');
      planForBase = await getPlanPricing(planId).catch(() => null);
    }

    let v;
    if      (provider === 'flutterwave') v = await verifyFlutterwave(reference);
    else if (provider === 'stripe')      v = await verifyStripe(reference, planForBase?.price_kobo || 0);
    else                                 v = await verifyPaystack(reference);

    if (!v.ok) {
      const httpCode = v.status === 401 ? 400 : (v.status === 404 ? 400 : 400);
      return res.status(httpCode).json({
        status:  'error',
        code:    v.code,
        message: v.message,
        gateway_response: v.gateway_response || null,
        provider,
      });
    }

    if (v.customer_email && v.customer_email !== userEmail) {
      return res.status(400).json({
        status: 'error', code: 'email_mismatch',
        message: `Payment email (${v.customer_email}) doesn't match the account email (${userEmail}).`,
      });
    }

    // paystack_ref column is reused as the opaque unique reference for any
    // provider — renaming it is a separate refactor.
    const dup = await db.query('SELECT * FROM subscribers WHERE paystack_ref=$1', [reference]);
    if (dup.rows.length) return res.json({ status: 'success', data: dup.rows[0] });
    // Adapt the uniform verify-helper result into the legacy Paystack-shaped
    // local var the INSERT logic below was originally written against.
    const txn = { amount: v.amount_kobo, customer: { email: v.customer_email }, status: 'success' };

    if (safeBookId) {
      // Per-book SKU. Bug history:
      //   • INSERT used to omit subscribed_category → DEFAULT 'adult' kicked
      //     in → book-only buyer accidentally got Sunday-School Adult access.
      //   • UPDATE used to overwrite plan_type → SS subscriber buying a book
      //     lost their SS plan.
      // Fix: explicit NULL category on fresh rows; preserve existing SS
      // plan_type; take later of the two expiries.
      const planId   = `book_${safeBookId}`;
      const plan     = await getPlanPricing(planId).catch(() => ({ price_kobo: 50000, days: 365 }));
      const now      = new Date(), exp = addDays(now, plan.days);
      const priceKobo = txn.amount || plan.price_kobo;
      const existing = await db.query('SELECT subscribed_books FROM subscribers WHERE email=$1', [userEmail]);
      const newBooks = addBookToList(existing.rows[0]?.subscribed_books, safeBookId);
      const r = await db.query(`
        INSERT INTO subscribers
          (email,is_active,subscription_date,expiry_date,paystack_ref,
           subscribed_books,price_kobo,plan_type,subscribed_category,is_trial)
        VALUES ($1,TRUE,$2,$3,$4,$5,$6,$7,NULL,FALSE)
        ON CONFLICT (email) DO UPDATE SET
          is_active         = TRUE,
          subscription_date = EXCLUDED.subscription_date,
          expiry_date       = GREATEST(subscribers.expiry_date, EXCLUDED.expiry_date),
          paystack_ref      = EXCLUDED.paystack_ref,
          subscribed_books  = CASE
                                -- preserve an 'all' (trial/all-access) grant; otherwise
                                -- append the newly-purchased book to the list.
                                WHEN POSITION('all' IN COALESCE(subscribers.subscribed_books,'')) > 0
                                  THEN subscribers.subscribed_books
                                ELSE EXCLUDED.subscribed_books
                              END,
          price_kobo        = EXCLUDED.price_kobo,
          plan_type         = CASE
                                WHEN subscribers.plan_type IN ('single','all')
                                  THEN subscribers.plan_type
                                ELSE EXCLUDED.plan_type
                              END,
          -- A real purchase converts a trial into a paid subscription.
          is_trial          = FALSE,
          updated_at        = NOW()
        RETURNING *
      `, [userEmail, now, exp, reference, newBooks, priceKobo, planId]);
      console.log('[Sub] Activated %s → book:%s plan:%s', userEmail, safeBookId, planId);
      notifyPaymentSuccess(userEmail, planId, priceKobo, r.rows[0].expiry_date);
      return res.json({
        status: 'success', success: true, expiry_date: r.rows[0].expiry_date,
        book_id: safeBookId, plan_type: r.rows[0].plan_type, price_kobo: priceKobo,
        subscribed_books: parseBooks(newBooks),
        subscribed_category: r.rows[0].subscribed_category, data: r.rows[0],
      });
    }

    // Category SKU (Sunday School) — original behavior.
    const planType = safeCategory === 'all' ? 'all' : 'single';
    const plan     = await getPlanPricing(planType);
    const now      = new Date(), exp = addDays(now, plan.days);
    const priceKobo = txn.amount || plan.price_kobo;
    // When converting a trial (subscribed_books='all') into a paid plan:
    //   • an 'all' category plan keeps all-books access (it's all-access);
    //   • a 'single' category plan must DROP the trial's 'all' wildcard so the
    //     buyer doesn't keep every book for free — they get only the SS
    //     category they paid for.
    const booksForPaid = planType === 'all' ? 'all' : '';
    const r = await db.query(`
      INSERT INTO subscribers
        (email,is_active,subscription_date,expiry_date,paystack_ref,subscribed_category,price_kobo,plan_type,subscribed_books,is_trial)
      VALUES ($1,TRUE,$2,$3,$4,$5,$6,$7,$8,FALSE)
      ON CONFLICT (email) DO UPDATE SET is_active=TRUE,
        subscription_date=EXCLUDED.subscription_date, expiry_date=EXCLUDED.expiry_date,
        paystack_ref=EXCLUDED.paystack_ref, subscribed_category=EXCLUDED.subscribed_category,
        price_kobo=EXCLUDED.price_kobo, plan_type=EXCLUDED.plan_type,
        subscribed_books = CASE
                             -- keep any real per-book purchases the user already
                             -- had, unless this is an all-access plan; only the
                             -- trial 'all' wildcard gets cleared for single plans.
                             WHEN $7 = 'all' THEN 'all'
                             WHEN POSITION('all' IN COALESCE(subscribers.subscribed_books,'')) > 0
                               THEN ''
                             ELSE subscribers.subscribed_books
                           END,
        is_trial=FALSE, updated_at=NOW()
      RETURNING *
    `, [userEmail, now, exp, reference, safeCategory, priceKobo, planType, booksForPaid]);
    console.log('[Sub] Activated %s → plan:%s cat:%s', userEmail, planType, safeCategory);
    notifyPaymentSuccess(userEmail, planType === 'all' ? 'All Categories' : `${safeCategory} (Single)`, priceKobo, r.rows[0].expiry_date);
    res.json({
      status: 'success', success: true, expiry_date: r.rows[0].expiry_date,
      subscribed_category: safeCategory, plan_type: planType, price_kobo: priceKobo,
      subscribed_books: parseBooks(r.rows[0].subscribed_books),
      data: r.rows[0],
    });
  } catch (e) {
    console.error('verify-payment:', e?.code || '(no code)', e?.message || '(no message)');
    res.status(500).json({
      status:  'error',
      code:    'verify_failed',
      message: 'Failed to verify payment. Please try again.',
      detail:  e?.message || null,
    });
  }
});

// Older clients still POST here for category purchases. Newer ones use
// /api/verify-payment which also handles per-book SKUs. We accept book_id
// here too for forward-compat.
router.post('/api/subscription/verify', async (req, res) => {
  const { reference, email, category = 'adult', book_id = null } = req.body;
  if (!reference || !email) return res.status(400).json({ success: false, message: 'Missing reference or email' });
  const safeBookId = book_id && /^[a-z0-9_]{3,64}$/i.test(String(book_id))
    ? String(book_id).toLowerCase()
    : null;
  try {
    const pRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY || ''}` } }
    );
    if (!pRes.data.status || pRes.data.data?.status !== 'success')
      return res.json({ success: false, message: 'Payment not confirmed by Paystack.' });

    if (safeBookId) {
      const planId   = `book_${safeBookId}`;
      const plan     = await getPlanPricing(planId).catch(() => ({ price_kobo: 50000, days: 365 }));
      const exp      = new Date(); exp.setDate(exp.getDate() + plan.days);
      const expiry   = exp.toISOString();
      const priceKobo = plan.price_kobo;
      const existing = await db.query('SELECT subscribed_books FROM subscribers WHERE email=$1', [email]);
      const newBooks = addBookToList(existing.rows[0]?.subscribed_books, safeBookId);
      await db.query(`
        INSERT INTO subscribers
          (email,is_active,expiry_date,paystack_ref,subscription_date,
           subscribed_books,plan_type,price_kobo,subscribed_category)
        VALUES ($1,TRUE,$2,$3,NOW(),$4,$5,$6,NULL)
        ON CONFLICT (email) DO UPDATE SET
          is_active        = TRUE,
          expiry_date      = GREATEST(subscribers.expiry_date, EXCLUDED.expiry_date),
          paystack_ref     = EXCLUDED.paystack_ref,
          subscription_date= NOW(),
          subscribed_books = EXCLUDED.subscribed_books,
          plan_type        = CASE
                               WHEN subscribers.plan_type IN ('single','all')
                                 THEN subscribers.plan_type
                               ELSE EXCLUDED.plan_type
                             END,
          price_kobo       = EXCLUDED.price_kobo,
          updated_at       = NOW()
      `, [email, expiry, reference, newBooks, planId, priceKobo]);
      console.log('✅ subscription/verify: %s → book:%s', email, safeBookId);
      notifyPaymentSuccess(email, planId, priceKobo, expiry);
      return res.json({
        success: true, expiry_date: expiry, plan_type: planId,
        book_id: safeBookId, subscribed_books: parseBooks(newBooks),
      });
    }

    const safeCategory = VALID_CATS.includes(category) ? category : 'adult';
    const planType     = safeCategory === 'all' ? 'all' : 'single';
    const plan         = await getPlanPricing(planType);
    const exp          = new Date(); exp.setDate(exp.getDate() + plan.days);
    const expiry       = exp.toISOString();
    const priceKobo    = plan.price_kobo;
    await db.query(`
      INSERT INTO subscribers
        (email,is_active,expiry_date,paystack_ref,subscription_date,subscribed_category,plan_type,price_kobo)
      VALUES ($1,TRUE,$2,$3,NOW(),$4,$5,$6)
      ON CONFLICT (email) DO UPDATE SET is_active=TRUE, expiry_date=$2, paystack_ref=$3,
        subscription_date=NOW(), subscribed_category=$4, plan_type=$5, price_kobo=$6, updated_at=NOW()
    `, [email, expiry, reference, safeCategory, planType, priceKobo]);
    console.log('✅ subscription/verify: %s → %s/%s', email, planType, safeCategory);
    notifyPaymentSuccess(email, planType === 'all' ? 'All Categories' : `${safeCategory} (Single)`, priceKobo, expiry);
    return res.json({ success: true, expiry_date: expiry, subscribed_category: safeCategory, plan_type: planType });
  } catch (e) {
    console.error('subscription/verify error:', e.message);
    if (e.response) return res.json({ success: false, message: `Paystack: ${e.response.data?.message || 'Verification failed'}` });
    return res.status(500).json({ success: false, message: 'Server error during verification.' });
  }
});

// ── Free one-month trial ─────────────────────────────────────────────────────
// Every account is eligible for ONE 30-day all-access trial, granted the first
// time the app calls this on launch. Idempotent and abuse-resistant:
//   • trial_started_at is set once and never cleared, so a reinstall or a
//     second device returns the existing trial instead of minting a new one.
//   • A user who already has (or had) a PAID plan is not downgraded or given a
//     trial — we only create a trial for brand-new emails with no row, or
//     re-affirm an existing un-expired trial.
// The trial uses plan_type='all' + subscribed_category='all' + subscribed_
// books='all' so it unlocks Sunday School AND every book for the month.
router.post('/api/subscription/start-trial', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, code: 'invalid_email', message: 'A valid email is required.' });
  }
  try {
    const existing = await db.query(
      `SELECT is_active, expiry_date, plan_type, subscribed_category, subscribed_books,
              is_trial, trial_started_at,
              (is_active=TRUE AND expiry_date IS NOT NULL AND expiry_date>NOW()) AS active
         FROM subscribers WHERE LOWER(email)=LOWER($1)`,
      [email],
    );
    const row = existing.rows[0];

    // Already used a trial before (even if now expired) → never grant a second.
    if (row?.trial_started_at) {
      return res.json({
        ok: true, granted: false, reason: 'already_used',
        is_trial: row.is_trial === true,
        active: row.active === true,
        expiry_date: row.expiry_date,
        days_remaining: row.expiry_date
          ? Math.max(0, Math.ceil((new Date(row.expiry_date) - new Date()) / 86400000))
          : 0,
      });
    }

    // Holds a real paid plan already → don't touch it; just report status.
    const isPaid = row && row.plan_type && !String(row.plan_type).startsWith('trial');
    if (row && row.active === true && isPaid && !row.is_trial) {
      return res.json({
        ok: true, granted: false, reason: 'already_subscribed',
        is_trial: false, active: true, expiry_date: row.expiry_date,
        days_remaining: row.expiry_date
          ? Math.max(0, Math.ceil((new Date(row.expiry_date) - new Date()) / 86400000))
          : null,
      });
    }

    const now = new Date();
    const exp = addDays(now, TRIAL_DAYS);
    const r = await db.query(`
      INSERT INTO subscribers
        (email, is_active, subscription_date, expiry_date, paystack_ref,
         subscribed_category, plan_type, subscribed_books, price_kobo,
         is_trial, trial_started_at)
      VALUES ($1, TRUE, $2, $3, $4, 'all', 'all', 'all', 0, TRUE, $2)
      ON CONFLICT (email) DO UPDATE SET
        is_active           = TRUE,
        subscription_date   = EXCLUDED.subscription_date,
        expiry_date         = EXCLUDED.expiry_date,
        paystack_ref        = EXCLUDED.paystack_ref,
        subscribed_category = 'all',
        plan_type           = 'all',
        subscribed_books    = 'all',
        price_kobo          = 0,
        is_trial            = TRUE,
        trial_started_at    = EXCLUDED.subscription_date,
        updated_at          = NOW()
      RETURNING expiry_date
    `, [email, now, exp, `TRIAL_${now.getTime()}`]);

    console.log('[Trial] Granted 30-day all-access trial to %s (until %s)', email, exp.toISOString());
    return res.json({
      ok: true, granted: true, reason: 'granted',
      is_trial: true, active: true,
      expiry_date: r.rows[0].expiry_date,
      days_remaining: TRIAL_DAYS,
    });
  } catch (e) {
    console.error('start-trial:', e.code || '(no code)', e.message);
    return res.status(500).json({ ok: false, code: 'server_error', message: 'Could not start trial.' });
  }
});

router.get('/api/subscription/status/:email', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT is_active, expiry_date, subscribed_category, plan_type, price_kobo,
             subscribed_books, is_trial, trial_started_at,
             (is_active=TRUE AND expiry_date IS NOT NULL AND expiry_date>NOW()) AS active
      FROM subscribers WHERE LOWER(email)=LOWER($1)
    `, [req.params.email]);
    if (!r.rows.length) return res.json({ active: false, expiry_date: null, subscribed_books: [], is_trial: false });
    const sub = r.rows[0];
    let days_remaining = null;
    if (sub.expiry_date) {
      days_remaining = Math.max(0, Math.ceil((new Date(sub.expiry_date) - new Date()) / 86400000));
    }
    return res.json({
      active: sub.active === true, expiry_date: sub.expiry_date, days_remaining,
      subscribed_category: sub.subscribed_category || 'adult',
      plan_type: sub.plan_type || 'single', price_kobo: sub.price_kobo || 50000,
      subscribed_books: parseBooks(sub.subscribed_books),
      // Surface trial state so the app can show "X days left of your free month"
      // and the dashboard can badge trial rows distinctly from paid ones.
      is_trial: sub.active === true && sub.is_trial === true,
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

router.get('/api/subscription/can-access/:email/:categoryId', async (req, res) => {
  const { email, categoryId } = req.params;
  if (!email || !categoryId) return res.status(400).json({ canAccess: false, reason: 'missing_params' });
  try {
    const r = await db.query(`
      SELECT is_active, expiry_date, subscribed_category, plan_type,
             (is_active=TRUE AND expiry_date IS NOT NULL AND expiry_date>NOW()) AS active
      FROM subscribers WHERE LOWER(email)=LOWER($1)
    `, [email]);
    if (!r.rows.length) return res.json({ canAccess: false, reason: 'no_subscription' });
    const sub = r.rows[0];
    if (!sub.active) return res.json({ canAccess: false, reason: 'expired' });
    if (sub.plan_type === 'all' || sub.subscribed_category === 'all')
      return res.json({ canAccess: true, reason: 'all_access', subscribed_category: sub.subscribed_category });
    const allowed = sub.subscribed_category === categoryId;
    return res.json({
      canAccess: allowed, reason: allowed ? 'category_match' : 'wrong_category',
      subscribed_category: sub.subscribed_category,
    });
  } catch (e) { res.status(500).json({ canAccess: false, reason: 'server_error' }); }
});

router.get('/api/subscription/can-access-book/:email/:bookId', async (req, res) => {
  const { email, bookId } = req.params;
  if (!email || !bookId) return res.status(400).json({ canAccess: false, reason: 'missing_params' });
  try {
    const r = await db.query(`
      SELECT is_active, expiry_date, subscribed_books,
             (is_active=TRUE AND expiry_date IS NOT NULL AND expiry_date>NOW()) AS active
      FROM subscribers WHERE LOWER(email)=LOWER($1)
    `, [email]);
    if (!r.rows.length) return res.json({ canAccess: false, reason: 'no_subscription' });
    const sub = r.rows[0];
    if (!sub.active) return res.json({ canAccess: false, reason: 'expired' });
    const books = parseBooks(sub.subscribed_books);
    // 'all' wildcard (free trial / all-access grants) unlocks every book.
    const owned = booksIncludeBook(sub.subscribed_books, bookId);
    return res.json({
      canAccess: owned,
      reason: owned ? (books.includes('all') ? 'all_access' : 'book_owned') : 'not_purchased',
      subscribed_books: books,
    });
  } catch (e) { res.status(500).json({ canAccess: false, reason: 'server_error' }); }
});

router.get('/api/check-status/:email', async (req, res) => {
  const email = req.params.email?.toLowerCase().trim();
  if (!email || !isValidEmail(email)) return res.status(400).json({ canAccess: false, reason: 'Invalid email.' });
  try {
    const r = await db.query('SELECT * FROM subscribers WHERE email=$1', [email]);
    if (!r.rows.length) return res.json({ canAccess: false, reason: 'No subscription found.' });
    const user = r.rows[0], now = new Date(), exp = new Date(user.expiry_date);
    if (!user.is_active || now > exp) {
      db.query('UPDATE subscribers SET is_active=FALSE WHERE email=$1', [email]).catch(() => {});
      return res.json({ canAccess: false, reason: 'Subscription expired.', expiredAt: user.expiry_date });
    }
    res.json({ canAccess: true, email: user.email, expiryDate: user.expiry_date, daysLeft: Math.ceil((exp - now) / 86400000) });
  } catch (e) { res.status(500).json({ canAccess: false, reason: 'Server error.' }); }
});

router.get('/api/subscribers', adminAuth, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT id,email,is_active,subscription_date,expiry_date,
             subscribed_category,plan_type,price_kobo,paystack_ref,
             subscribed_books, is_trial, trial_started_at, created_at,updated_at
      FROM subscribers ORDER BY created_at DESC
    `);
    res.json({
      count: r.rows.length,
      subscribers: r.rows.map((s) => ({ ...s, subscribed_books: parseBooks(s.subscribed_books) })),
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.delete('/api/revoke/:email', adminAuth, async (req, res) => {
  const email = req.params.email?.toLowerCase().trim();
  try {
    await db.query('UPDATE subscribers SET is_active=FALSE WHERE email=$1', [email]);
    res.json({ message: `Revoked for ${email}.` });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.post('/api/admin/grant-access', adminAuth, async (req, res) => {
  const { email, days, reference, expiry_date, subscribed_category, plan_type } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    const safeCategory = VALID_CATS.includes(subscribed_category) ? subscribed_category : 'adult';
    const safePlan     = VALID_PLANS.includes(plan_type) ? plan_type : 'single';
    const plan         = await getPlanPricing(safePlan);
    const expiry = expiry_date || (() => {
      const d = new Date(); d.setDate(d.getDate() + (days || plan.days)); return d.toISOString();
    })();
    const priceKobo = plan.price_kobo;
    await db.query(`
      INSERT INTO subscribers
        (email,is_active,subscription_date,expiry_date,paystack_ref,subscribed_category,plan_type,price_kobo)
      VALUES ($1,TRUE,NOW(),$2,$3,$4,$5,$6)
      ON CONFLICT (email) DO UPDATE SET is_active=TRUE, expiry_date=$2, paystack_ref=$3,
        subscribed_category=$4, plan_type=$5, price_kobo=$6, subscription_date=NOW(), updated_at=NOW()
    `, [email, expiry, reference || 'ADMIN_GRANT', safeCategory, safePlan, priceKobo]);
    console.log('[Admin] Access granted to %s | cat:%s | plan:%s | until %s', email, safeCategory, safePlan, expiry);
    res.json({ success: true, email, expiry_date: expiry, subscribed_category: safeCategory, plan_type: safePlan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Webhook needs raw body for HMAC signature verification, so we register
// express.raw as the route-level middleware. Note: the global express.json
// middleware will already have parsed the body for application/json content,
// so raw verification only works if this route is mounted BEFORE the global
// JSON parser, OR if Paystack uses a different content-type. Keeping the
// existing inline raw middleware to preserve behavior.
router.post('/api/webhook/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
  if (hash !== req.headers['x-paystack-signature']) return res.status(400).json({ message: 'Invalid signature.' });
  const event = JSON.parse(req.body);
  if (event.event === 'charge.success') {
    const { reference, customer, status } = event.data;
    if (status !== 'success') return res.sendStatus(200);
    const email = customer.email.toLowerCase(), now = new Date(), exp = addDays(now, SUBSCRIPTION_DAYS);
    try {
      await db.query(
        `INSERT INTO subscribers (email,is_active,subscription_date,expiry_date,paystack_ref)
         VALUES ($1,TRUE,$2,$3,$4)
         ON CONFLICT (email) DO UPDATE SET is_active=TRUE,
           subscription_date=EXCLUDED.subscription_date,
           expiry_date=EXCLUDED.expiry_date, paystack_ref=EXCLUDED.paystack_ref`,
        [email, now, exp, reference]
      );
    } catch (e) { console.error('webhook DB error:', e.message); }
  }
  res.sendStatus(200);
});

module.exports = router;
