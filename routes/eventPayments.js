// routes/eventPayments.js
// Payment surface for paid event registrations. Reuses the same provider
// helpers the mobile subscription flow uses (services/payments.js) so
// Paystack / Flutterwave / Stripe behave identically here.
//
// Flow:
//   1. Frontend POSTs /api/events/:eventId/payments/initialize with the
//      provider choice and the ticket selection. We read the ticket type's
//      stored price, init the provider, and return:
//        { authorizationUrl, reference, amountKobo, paymentSessionToken }
//   2. Frontend redirects the user to authorizationUrl.
//   3. Provider redirects back to our frontend callback page with the
//      reference. The page POSTs /api/events/payments/verify with the
//      reference + the session token.
//   4. We verify with the provider, confirm the charged amount matches the
//      quoted amount, and mint a paymentProofToken.
//   5. Frontend hands paymentProofToken to /api/events/:id/register, which
//      uses it to confirm the paid registration is actually paid.
//
// Pricing model: event_ticket_types.price_cents is treated as USD cents
// (matches the existing CreateEvent UI label "Price (USD)"). For the NGN
// providers we convert via EVENT_USD_NGN_RATE (default 1500) so a $5
// ticket charges ₦7,500 (= 750,000 kobo) on Paystack/Flutterwave.

const express = require('express');
const db = require('../db');
const {
  PROVIDERS,
  initPaystack, initFlutterwave, initStripe,
  verifyPaystack, verifyFlutterwave, verifyStripe,
  detectProvider,
} = require('../services/payments');
const { sign, verify: verifySessionToken } = require('../services/eventPaymentToken');
const { isValidEmail } = require('../utils/helpers');

const router = express.Router();

const USD_NGN_RATE = Math.max(
  1,
  parseInt(process.env.EVENT_USD_NGN_RATE, 10) || 1500,
);

// Map a USD-cents ticket price to the pricing shape services/payments.js
// expects. Kobo column is the same numeric value as the NGN equivalent in
// the smallest unit (1 NGN = 100 kobo, so USD cents × rate gives kobo).
function buildPricing(priceUsdCents, quantity) {
  const usdCents = (priceUsdCents || 0) * quantity;
  return {
    price_kobo:      usdCents * USD_NGN_RATE,
    price_usd_cents: usdCents,
    days:            0,
  };
}

// POST /api/events/:eventId/payments/initialize
// Body: { provider, email, ticketTypeId, quantity, accommodationId?, callbackUrl }
router.post('/api/events/:eventId/payments/initialize', async (req, res) => {
  const eventId         = String(req.params.eventId || '').trim();
  const provider        = String(req.body?.provider || 'paystack').toLowerCase();
  const email           = String(req.body?.email || '').trim().toLowerCase();
  const ticketTypeId    = String(req.body?.ticketTypeId || '').trim();
  const accommodationId = req.body?.accommodationId ? String(req.body.accommodationId) : null;
  const quantity        = Math.max(1, Math.min(50, parseInt(req.body?.quantity, 10) || 1));
  const callbackUrl     = String(req.body?.callbackUrl || '').trim();

  if (!PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'Unknown payment provider.', code: 'bad_provider' });
  }
  if (!eventId || !ticketTypeId) {
    return res.status(400).json({ error: 'eventId and ticketTypeId are required.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (!callbackUrl || !/^https?:\/\//i.test(callbackUrl)) {
    return res.status(400).json({ error: 'callbackUrl must be an absolute http(s) URL.' });
  }

  // Look up the ticket type's price and remaining capacity in one shot.
  // Falls back to req.body.amountUsdCents when the table doesn't exist yet
  // (dev / partly-migrated env) so the flow can still be exercised.
  let ttRow;
  try {
    const r = await db.query(
      `SELECT type_id, name, price_cents, role,
              capacity, sold,
              (capacity - sold) AS remaining
         FROM event_ticket_types
        WHERE event_id = $1 AND type_id = $2`,
      [eventId, ticketTypeId],
    );
    if (!r.rows.length) {
      return res.status(404).json({ error: 'Ticket type not found for this event.' });
    }
    ttRow = r.rows[0];
  } catch (e) {
    const fallback = parseInt(req.body?.amountUsdCents, 10);
    if (!Number.isFinite(fallback) || fallback < 50) {
      return res.status(500).json({ error: 'Could not load ticket pricing.', detail: e.message });
    }
    ttRow = { type_id: ticketTypeId, name: req.body?.ticketTypeName || 'Ticket', price_cents: fallback, capacity: 0, sold: 0, remaining: null };
  }

  if (!ttRow.price_cents || ttRow.price_cents <= 0) {
    return res.status(400).json({
      error: 'This ticket type is free — register directly instead of through payments.',
      code: 'free_ticket',
    });
  }
  if (ttRow.capacity > 0 && ttRow.remaining !== null && quantity > ttRow.remaining) {
    return res.status(409).json({
      error: `Only ${ttRow.remaining} of "${ttRow.name}" left.`,
      code: 'capacity',
    });
  }

  const pricing = buildPricing(ttRow.price_cents, quantity);
  const reference =
    `EVT_${Date.now()}_${Math.random().toString(36).slice(2, 11)}_${provider}_${eventId}`.slice(0, 100);

  const metadata = {
    purpose:        'event_registration',
    event_id:       eventId,
    ticket_type_id: ticketTypeId,
    quantity:       String(quantity),
    accommodation_id: accommodationId || '',
    ticket_type_name: ttRow.name,
  };

  const planId = `event_${eventId}_${ticketTypeId}`.slice(0, 100);
  const callArgs = { email, pricing, planId, reference, metadata, callbackUrl };

  let result;
  if (provider === 'flutterwave') result = await initFlutterwave(callArgs);
  else if (provider === 'stripe')  result = await initStripe(callArgs);
  else                              result = await initPaystack({
    ...callArgs,
    metadata: {
      ...metadata,
      custom_fields: [
        { display_name: 'Event',  variable_name: 'event_id',      value: eventId },
        { display_name: 'Ticket', variable_name: 'ticket_type',   value: ttRow.name },
        { display_name: 'Qty',    variable_name: 'quantity',      value: String(quantity) },
      ],
    },
  });

  if (!result.ok) {
    const httpCode = result.status === 401 ? 400 : 502;
    return res.status(httpCode).json({
      error:   result.message,
      code:    result.code,
      detail:  result.detail || null,
      provider,
    });
  }

  // Stripe verifies sessions by id, not our reference — preserve whichever
  // string the provider expects on verify.
  const paymentSessionToken = sign({
    kind:           'event_payment_session',
    eventId,
    ticketTypeId,
    accommodationId,
    quantity,
    amountKobo:     pricing.price_kobo,
    amountUsdCents: pricing.price_usd_cents,
    reference:      result.reference,
    provider,
    email,
  });

  res.json({
    ok:                  true,
    provider,
    authorizationUrl:    result.authorization_url,
    reference:           result.reference,
    amountKobo:          pricing.price_kobo,
    amountUsdCents:      pricing.price_usd_cents,
    quantity,
    paymentSessionToken,
  });
});

// POST /api/events/payments/verify
// Body: { reference, provider?, paymentSessionToken }
router.post('/api/events/payments/verify', async (req, res) => {
  const provider     = detectProvider(req);
  const reference    = String(req.body?.reference || '').trim();
  const sessionToken = String(req.body?.paymentSessionToken || '').trim();

  if (!reference)    return res.status(400).json({ error: 'reference is required.' });
  if (!sessionToken) return res.status(400).json({ error: 'paymentSessionToken is required.' });

  const sessionCheck = verifySessionToken(sessionToken);
  if (!sessionCheck.ok) {
    return res.status(403).json({
      ok: false,
      error: `Payment session token ${sessionCheck.error}.`,
      code:  `session_${sessionCheck.error}`,
    });
  }
  const session = sessionCheck.payload;
  if (session.kind !== 'event_payment_session' || session.reference !== reference) {
    return res.status(403).json({ ok: false, error: 'Token does not match this payment.', code: 'session_mismatch' });
  }

  let result;
  if (provider === 'flutterwave') result = await verifyFlutterwave(reference);
  else if (provider === 'stripe') result = await verifyStripe(reference, session.amountKobo);
  else                            result = await verifyPaystack(reference);

  if (!result.ok) {
    return res.status(402).json({
      ok:    false,
      error: result.message,
      code:  result.code,
      provider,
    });
  }

  // Amount tamper-check. Stripe verifies in USD cents (compared against the
  // session's amountUsdCents); Paystack / Flutterwave compare in kobo.
  if (provider === 'stripe') {
    if ((result.amount_usd_cents || 0) !== session.amountUsdCents) {
      return res.status(402).json({
        ok:    false,
        error: `Stripe amount ${result.amount_usd_cents} ¢ != expected ${session.amountUsdCents} ¢.`,
        code:  'amount_mismatch',
      });
    }
  } else if ((result.amount_kobo || 0) !== session.amountKobo) {
    return res.status(402).json({
      ok:    false,
      error: `Provider amount ${result.amount_kobo} kobo != expected ${session.amountKobo} kobo.`,
      code:  'amount_mismatch',
    });
  }

  // 15 minutes is plenty for the user to land on /payments/callback, get
  // tickets created via /register, and see their tickets. After that the
  // proof expires and another verify call (or a fresh payment) is needed.
  const paymentProofToken = sign({
    kind:            'event_payment_proof',
    eventId:         session.eventId,
    ticketTypeId:    session.ticketTypeId,
    accommodationId: session.accommodationId,
    quantity:        session.quantity,
    amountKobo:      session.amountKobo,
    amountUsdCents:  session.amountUsdCents,
    reference,
    provider,
    customerEmail:   result.customer_email || session.email,
  }, 900);

  res.json({
    ok:                true,
    provider,
    reference,
    eventId:           session.eventId,
    ticketTypeId:      session.ticketTypeId,
    accommodationId:   session.accommodationId,
    quantity:          session.quantity,
    amountKobo:        session.amountKobo,
    amountUsdCents:    session.amountUsdCents,
    customerEmail:     result.customer_email || session.email,
    paymentProofToken,
  });
});

module.exports = router;
