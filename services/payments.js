// services/payments.js
// Three providers, uniform shape:
//   init*    → { ok, authorization_url, reference, raw }   on success
//              { ok:false, code, message, status?, raw? }  on failure
//   verify*  → { ok, amount_kobo, customer_email, currency, raw }  on success
//              { ok:false, code, message }                          on failure
//
// The `reference` we return from init is what the frontend hands back to
// the verify endpoint. Stripe uses its session id; FW uses tx_ref; PS uses
// the reference we generated. detectProvider() picks the right verifier.

const axios = require('axios');
const db    = require('../db');
const { SUBSCRIPTION_DAYS } = require('../utils/helpers');

const VALID_CATS  = ['children', 'intermediate', 'youth', 'adult', 'all'];
const VALID_PLANS = ['single', 'all'];
const PROVIDERS   = ['paystack', 'flutterwave', 'stripe'];

// Resolve plan price/days from DB; falls back to legacy hardcoded values if
// the table is missing/empty (so a partly-migrated env still works).
async function getPlanPricing(planId) {
  try {
    const r = await db.query(
      'SELECT plan_id, price_kobo, COALESCE(price_usd_cents, 0) AS price_usd_cents, days FROM subscription_plans WHERE plan_id=$1',
      [planId]
    );
    if (r.rows[0]) return r.rows[0];
  } catch (e) { /* table may not exist on first run — fall through */ }
  return planId === 'all'
    ? { plan_id: 'all',    price_kobo: 100000, price_usd_cents: 0, days: SUBSCRIPTION_DAYS }
    : { plan_id: 'single', price_kobo: 50000,  price_usd_cents: 0, days: SUBSCRIPTION_DAYS };
}

function paymentErrorOut(provider, e) {
  const status = e?.response?.status || 500;
  const upstream = e?.response?.data?.message || e?.response?.data?.error?.message || e?.response?.data || e.message;
  console.error(`[${provider}]`, status, typeof upstream === 'string' ? upstream : JSON.stringify(upstream));
  return {
    ok: false,
    code: status === 401 ? `${provider}_auth` : `${provider}_init_failed`,
    message: status === 401
      ? `Payment provider rejected credentials. Check ${provider.toUpperCase()}_SECRET_KEY.`
      : `Failed to initialize ${provider} payment. Please try again.`,
    status,
    detail: typeof upstream === 'string' ? upstream : JSON.stringify(upstream),
  };
}

async function initPaystack({ email, pricing, planId, reference, metadata, callbackUrl }) {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return { ok: false, code: 'paystack_key_missing', message: 'Paystack key not configured on server.' };
  }
  try {
    const r = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email, amount: pricing.price_kobo, currency: 'NGN',
        reference, callback_url: callbackUrl, metadata,
      },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } },
    );
    const d = r.data?.data;
    if (!d?.authorization_url) {
      return { ok: false, code: 'paystack_no_url', message: 'Paystack did not return an authorization URL.', raw: r.data };
    }
    return { ok: true, authorization_url: d.authorization_url, reference: d.reference, raw: d };
  } catch (e) {
    return paymentErrorOut('paystack', e);
  }
}

async function initFlutterwave({ email, pricing, planId, reference, metadata, callbackUrl }) {
  if (!process.env.FLUTTERWAVE_SECRET_KEY) {
    return { ok: false, code: 'flutterwave_key_missing', message: 'Flutterwave key not configured on server.' };
  }
  try {
    const r = await axios.post(
      'https://api.flutterwave.com/v3/payments',
      {
        tx_ref:       reference,
        amount:       pricing.price_kobo / 100,
        currency:     'NGN',
        redirect_url: callbackUrl,
        customer:     { email },
        customizations: { title: 'Gospelar', description: `Subscription: ${planId}` },
        meta:         metadata,
      },
      { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`, 'Content-Type': 'application/json' } },
    );
    const link = r.data?.data?.link;
    if (!link) {
      return { ok: false, code: 'flutterwave_no_url', message: 'Flutterwave did not return a payment link.', raw: r.data };
    }
    return { ok: true, authorization_url: link, reference, raw: r.data?.data };
  } catch (e) {
    return paymentErrorOut('flutterwave', e);
  }
}

async function initStripe({ email, pricing, planId, reference, metadata, callbackUrl }) {
  if (!process.env.STRIPE_SECRET_KEY) {
    return { ok: false, code: 'stripe_key_missing', message: 'Stripe key not configured on server.' };
  }
  if (!pricing.price_usd_cents || pricing.price_usd_cents < 50) {
    return {
      ok: false, code: 'stripe_no_usd_price',
      message: `No USD price configured for "${planId}". Set price_usd_cents in the admin Pricing page (must be ≥ 50¢).`,
    };
  }
  try {
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('customer_email', email);
    params.append('success_url', `${callbackUrl}?provider=stripe&session_id={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url',  `${callbackUrl}?provider=stripe&cancelled=1`);
    params.append('line_items[0][quantity]', '1');
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][unit_amount]', String(pricing.price_usd_cents));
    params.append('line_items[0][price_data][product_data][name]', `Gospelar — ${planId}`);
    params.append('client_reference_id', reference);
    Object.entries(metadata || {}).forEach(([k, v]) => {
      if (v != null) params.append(`metadata[${k}]`, String(v));
    });

    const r = await axios.post(
      'https://api.stripe.com/v1/checkout/sessions',
      params.toString(),
      {
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );
    const session = r.data;
    if (!session?.url) {
      return { ok: false, code: 'stripe_no_url', message: 'Stripe did not return a Checkout URL.', raw: session };
    }
    // Stripe verifies sessions by id, so the reference we hand back to the
    // frontend must be the session id (not the tx_ref we generated).
    return { ok: true, authorization_url: session.url, reference: session.id, raw: session };
  } catch (e) {
    return paymentErrorOut('stripe', e);
  }
}

async function verifyPaystack(reference) {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return { ok: false, code: 'paystack_key_missing', message: 'Paystack not configured.' };
  }
  try {
    const r = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } },
    );
    const txn = r.data?.data;
    if (!txn) return { ok: false, code: 'paystack_no_data', message: 'Paystack returned no transaction for this reference.' };
    if (txn.status !== 'success') {
      return {
        ok: false, code: 'txn_not_successful',
        message: `Transaction status is "${txn.status || 'unknown'}". Only successful charges can be verified.`,
        gateway_response: txn.gateway_response || null,
      };
    }
    return {
      ok: true,
      amount_kobo: txn.amount,
      customer_email: (txn.customer?.email || '').toLowerCase(),
      currency: txn.currency || 'NGN',
      raw: txn,
    };
  } catch (e) { return paymentErrorOut('paystack', e); }
}

async function verifyFlutterwave(reference) {
  if (!process.env.FLUTTERWAVE_SECRET_KEY) {
    return { ok: false, code: 'flutterwave_key_missing', message: 'Flutterwave not configured.' };
  }
  try {
    const r = await axios.get(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } },
    );
    const txn = r.data?.data;
    if (!txn) return { ok: false, code: 'flutterwave_no_data', message: 'Flutterwave returned no transaction for this reference.' };
    if (txn.status !== 'successful') {
      return {
        ok: false, code: 'txn_not_successful',
        message: `Transaction status is "${txn.status || 'unknown'}".`,
      };
    }
    return {
      ok: true,
      amount_kobo: Math.round((Number(txn.amount) || 0) * 100),
      customer_email: (txn.customer?.email || '').toLowerCase(),
      currency: txn.currency || 'NGN',
      raw: txn,
    };
  } catch (e) { return paymentErrorOut('flutterwave', e); }
}

async function verifyStripe(sessionId, planPriceKobo) {
  if (!process.env.STRIPE_SECRET_KEY) {
    return { ok: false, code: 'stripe_key_missing', message: 'Stripe not configured.' };
  }
  try {
    const r = await axios.get(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } },
    );
    const session = r.data;
    if (!session) return { ok: false, code: 'stripe_no_data', message: 'Stripe returned no session for this id.' };
    if (session.payment_status !== 'paid') {
      return {
        ok: false, code: 'txn_not_successful',
        message: `Stripe payment_status is "${session.payment_status || 'unknown'}".`,
      };
    }
    return {
      ok: true,
      amount_kobo:      planPriceKobo || 0,
      amount_usd_cents: session.amount_total,
      customer_email:   (session.customer_email || session.customer_details?.email || '').toLowerCase(),
      currency:         (session.currency || 'usd').toUpperCase(),
      raw:              session,
    };
  } catch (e) { return paymentErrorOut('stripe', e); }
}

// Detect provider for back-compat: explicit body.provider wins; otherwise the
// reference shape gives it away (Stripe session ids start with `cs_`; our
// own references for paystack/flutterwave embed the provider name in slot 4).
function detectProvider(req) {
  const explicit = String(req.body?.provider || '').toLowerCase();
  if (PROVIDERS.includes(explicit)) return explicit;
  const ref = String(req.body?.reference || '');
  if (/^cs_(test|live)_/i.test(ref)) return 'stripe';
  const parts = ref.split('_');
  if (parts[3] && PROVIDERS.includes(parts[3].toLowerCase())) return parts[3].toLowerCase();
  return 'paystack';
}

module.exports = {
  VALID_CATS, VALID_PLANS, PROVIDERS,
  getPlanPricing, paymentErrorOut, detectProvider,
  initPaystack, initFlutterwave, initStripe,
  verifyPaystack, verifyFlutterwave, verifyStripe,
};
