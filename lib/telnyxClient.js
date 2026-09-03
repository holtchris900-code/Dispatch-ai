// Thin wrapper around Telnyx's REST API (https://telnyx.com) for buying a
// real UK phone number on demand -- deliberately no npm dependency (no
// "telnyx" package), just fetch + built-ins, to stay consistent with the
// rest of this project's zero-dependency approach (see lib/stripeClient.js,
// lib/retellClient.js).
//
// Falls back to a demo-mode message if TELNYX_API_KEY or TELNYX_CONNECTION_ID
// aren't set, the same pattern used everywhere else in this app when an
// optional service isn't configured yet -- so nothing here ever throws just
// because Telnyx hasn't been set up, and the "create phone agent" button
// keeps working (just without an automatic number) until it is.
//
// IMPORTANT one-time setup this depends on: before this can buy anything, a
// Telnyx "Connection" has to exist in the Telnyx dashboard, with Origination
// pointed at sip:sip.retellai.com and Termination using a username/password
// credential -- see LAUNCH_CHECKLIST.md Step 5 for the exact walkthrough.
// That connection's ID becomes TELNYX_CONNECTION_ID below, and its
// credentials become TELNYX_SIP_USERNAME / TELNYX_SIP_PASSWORD (used over in
// lib/retellClient.js's importPhoneNumber). It's created ONCE and reused for
// every future client -- never created per purchase.
//
// NOTE: Telnyx's API can evolve over time. This reflects the documented
// request/response shape at https://developers.telnyx.com/docs/api as of
// when it was written -- always sanity-check against their current docs
// before relying on it, and call a freshly-bought number yourself to
// confirm it actually rings through before handing it to a client.

const API_BASE = 'https://api.telnyx.com/v2';

function missingConfigMessage() {
  const missing = [];
  if (!process.env.TELNYX_API_KEY) missing.push('TELNYX_API_KEY');
  if (!process.env.TELNYX_CONNECTION_ID) missing.push('TELNYX_CONNECTION_ID');
  if (missing.length === 0) return null;
  return `${missing.join(', ')} not set yet -- see LAUNCH_CHECKLIST.md Step 5 to connect Telnyx before phone numbers can be bought automatically.`;
}

async function telnyxRequest(path, { method = 'GET', body } = {}) {
  const apiKey = process.env.TELNYX_API_KEY;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (json && json.errors && json.errors[0] && json.errors[0].detail) || JSON.stringify(json);
    throw new Error(`Telnyx API error on ${path} (${res.status}): ${detail}`);
  }
  return json;
}

// Finds one purchasable UK number. TELNYX_NUMBER_LOCALITY (e.g. "London") is
// optional and narrows the search to that city if set -- otherwise this
// just takes whatever Telnyx has available anywhere in the UK. Throws if
// nothing comes back, so the caller's fail-safe wrapper (see
// lib/phoneProvisioning.js) can flag it for a manual look instead of a
// client silently ending up without a number.
async function findAvailableUkNumber() {
  const locality = process.env.TELNYX_NUMBER_LOCALITY;
  const params = new URLSearchParams({
    'filter[country_code]': 'GB',
    'filter[limit]': '5',
  });
  if (locality) params.set('filter[locality]', locality);

  const result = await telnyxRequest(`/available_phone_numbers?${params.toString()}`);
  const first = result && result.data && result.data[0];
  if (!first) {
    throw new Error('No purchasable UK numbers came back from Telnyx -- try again shortly, or check TELNYX_NUMBER_LOCALITY if one is set.');
  }
  return first.phone_number;
}

// Buys the given number and, in the same call, assigns it to this app's
// pre-created Telnyx Connection (TELNYX_CONNECTION_ID) -- so it's already
// wired to carry calls to/from Retell the instant the purchase goes through,
// no separate "assign this number to that connection" step needed.
async function orderNumber(phoneNumber) {
  await telnyxRequest('/number_orders', {
    method: 'POST',
    body: {
      phone_numbers: [{ phone_number: phoneNumber }],
      connection_id: process.env.TELNYX_CONNECTION_ID,
    },
  });
  return phoneNumber;
}

// Full flow: find a real purchasable UK number and buy it. Returns just the
// E.164 phone number string (e.g. "+44..."); server.js hands that straight
// to retellClient's importPhoneNumber() to bind it to a specific client's
// own agent.
async function buyUkPhoneNumber() {
  const configMessage = missingConfigMessage();
  if (configMessage) {
    return { demoMode: true, message: configMessage };
  }

  const phoneNumber = await findAvailableUkNumber();
  await orderNumber(phoneNumber);
  return { demoMode: false, phoneNumber };
}

module.exports = { buyUkPhoneNumber };
