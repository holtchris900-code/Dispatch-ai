// Thin wrapper around Stripe's REST API -- deliberately no npm dependency
// (no "stripe" package), just fetch + Node's built-in crypto module, to
// stay consistent with the rest of this project's zero-dependency approach.
//
// If no STRIPE_SECRET_KEY is set, createCheckoutSession() returns a clearly
// marked demo response instead of calling Stripe, the same pattern
// lib/claude.js uses for ANTHROPIC_API_KEY -- so the rest of the app stays
// testable before Stripe is fully configured.

const crypto = require('crypto');

const API_BASE = 'https://api.stripe.com/v1';

function formEncode(params) {
  // Stripe's write endpoints expect application/x-www-form-urlencoded,
  // not JSON. Nested params (like line_items[0][price]) are just flat
  // string keys with bracket notation -- no special encoding needed beyond
  // normal URL-encoding of each key/value.
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

// trialDays: optional free-trial length in days, added to the subscription
// via Stripe's own trial_period_days -- Stripe handles not charging the
// card until the trial ends, and the webhook flow (checkout.session.completed)
// already fires the same way whether or not a trial is attached, so nothing
// else in this app needs to know the difference. Callers decide who gets a
// trial (see server.js -- currently, anyone who has never paid before).
async function createCheckoutSession({ clientId, priceId, companyName, successUrl, cancelUrl, trialDays }) {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    return {
      demoMode: true,
      url: null,
      message: 'STRIPE_SECRET_KEY is not set yet -- add it in Render to generate real payment links.',
    };
  }
  if (!priceId) {
    return {
      demoMode: true,
      url: null,
      message: 'No Stripe price ID is configured for this plan -- set STRIPE_PRICE_ID_STARTER / STRIPE_PRICE_ID_GROWTH in Render.',
    };
  }

  const body = formEncode({
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': 1,
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: clientId,
    'metadata[company_name]': companyName || '',
    ...(Number(trialDays) > 0 ? { 'subscription_data[trial_period_days]': Number(trialDays) } : {}),
  });

  const response = await fetch(`${API_BASE}/checkout/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Stripe API error (${response.status}): ${errText}`);
  }

  const session = await response.json();
  return { demoMode: false, url: session.url, sessionId: session.id };
}

// Verifies a Stripe webhook request per Stripe's documented scheme
// (https://docs.stripe.com/webhooks/signatures):
//   header format:   "t=<timestamp>,v1=<signature>[,v0=...]"
//   signed payload:  "<timestamp>.<raw request body>"
//   signature:       hex HMAC-SHA256 of the signed payload, keyed with the
//                     webhook signing secret from the Stripe dashboard.
function verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!signatureHeader || !secret) {
    return { valid: false, reason: 'missing Stripe-Signature header or STRIPE_WEBHOOK_SECRET' };
  }

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((part) => {
      const eqIdx = part.indexOf('=');
      return [part.slice(0, eqIdx), part.slice(eqIdx + 1)];
    })
  );

  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) {
    return { valid: false, reason: 'malformed Stripe-Signature header' };
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedHex = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = Buffer.from(v1, 'hex');
  const signaturesMatch =
    expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

  if (!signaturesMatch) {
    return { valid: false, reason: 'signature mismatch' };
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (ageSeconds > toleranceSeconds) {
    return { valid: false, reason: 'timestamp too old -- possible replay' };
  }

  return { valid: true };
}

// Creates a Stripe-hosted "Customer Portal" session -- a secure page where a
// customer can update their card, view invoices, and cancel their own
// subscription, without you building any of that yourself. Requires the
// Customer Portal to be turned on once in the Stripe dashboard (Settings ->
// Billing -> Customer portal) -- see LAUNCH_CHECKLIST.md.
async function createPortalSession({ customerId, returnUrl }) {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    return {
      demoMode: true,
      url: null,
      message: 'STRIPE_SECRET_KEY is not set yet -- the self-service subscription portal needs it configured first.',
    };
  }
  if (!customerId) {
    return {
      demoMode: true,
      url: null,
      message: 'This client has no Stripe customer on file yet -- they need to complete a real checkout first.',
    };
  }

  const body = formEncode({
    customer: customerId,
    return_url: returnUrl,
  });

  const response = await fetch(`${API_BASE}/billing_portal/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Stripe API error (${response.status}): ${errText}`);
  }

  const session = await response.json();
  return { demoMode: false, url: session.url };
}

// Looks up a Checkout Session by its ID -- used right after a customer pays,
// so the success page can find their Stripe customer ID (needed to open the
// portal) using only the session_id Stripe put in the redirect URL, without
// requiring a full client login system.
async function getCheckoutSession(sessionId) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return { demoMode: true, session: null };
  }

  const response = await fetch(`${API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${secretKey}` },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Stripe API error (${response.status}): ${errText}`);
  }

  const session = await response.json();
  return { demoMode: false, session };
}

// Adds a one-off charge to a customer's Stripe account that Stripe
// automatically attaches to their NEXT scheduled invoice -- this is Stripe's
// standard "pending invoice item" behavior, and it's what makes automatic
// overage billing work here without setting up metered-billing Prices in
// the Stripe dashboard. Used by server.js whenever a client's call/chat
// usage crosses their plan's included minutes for the month.
async function createInvoiceItem({ customerId, amountPence, currency = 'gbp', description }) {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    return {
      demoMode: true,
      message: 'STRIPE_SECRET_KEY is not set yet -- overage minutes can\'t be billed until it is.',
    };
  }
  if (!customerId) {
    return {
      demoMode: true,
      message: 'This client has no Stripe customer on file yet -- they need to complete a real checkout first.',
    };
  }

  const body = formEncode({
    customer: customerId,
    amount: amountPence,
    currency,
    description,
  });

  const response = await fetch(`${API_BASE}/invoiceitems`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Stripe API error (${response.status}): ${errText}`);
  }

  const item = await response.json();
  return { demoMode: false, id: item.id };
}

module.exports = {
  createCheckoutSession,
  verifyStripeSignature,
  createPortalSession,
  getCheckoutSession,
  createInvoiceItem,
};
