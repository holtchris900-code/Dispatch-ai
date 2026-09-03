// Orchestrates "a client's agent just went live -> get them a real, working
// phone number" end to end, so the two nearly-identical create-phone-agent
// routes in server.js (the client-portal self-service one and the
// founder-dashboard one) both call one function instead of duplicating this
// logic.
//
// Buys a real UK number from Telnyx (lib/telnyxClient.js) and immediately
// hands it to Retell (lib/retellClient.js's importPhoneNumber) so it's bound
// to this specific client's own agent and ready to ring, with no manual
// dashboard clicking on either side.
//
// Deliberately never throws. A phone-number purchase failing for any reason
// (Telnyx rate limited, the one-time SIP connection not set up yet, out of
// local numbers, a network hiccup) must never block the agent itself from
// being created and handed to the client -- the same "never block the real
// transaction" fail-safe used elsewhere in this app (see checkScriptSafety
// falling back to manual review, and notifyFounder never blocking a
// signup). Callers should create the agent first, then call this, and treat
// a { success: false } result as "flag this client for a manual number
// instead of failing the whole request."
const { buyUkPhoneNumber } = require('./telnyxClient');
const { importPhoneNumber } = require('./retellClient');

async function provisionPhoneNumber({ agentId, companyName }) {
  try {
    const purchase = await buyUkPhoneNumber();
    if (purchase.demoMode) {
      return { success: false, demoMode: true, message: purchase.message };
    }

    const imported = await importPhoneNumber({
      phoneNumber: purchase.phoneNumber,
      agentId,
      nickname: companyName,
    });
    if (imported.demoMode) {
      // The number itself was bought successfully -- it's just not wired to
      // Retell yet (the SIP connection env vars are missing). Surface the
      // number that was bought so a founder fixing this manually doesn't
      // also have to go hunting for which number just got purchased.
      return { success: false, demoMode: true, message: imported.message, phoneNumber: purchase.phoneNumber };
    }

    return { success: true, phoneNumber: imported.phoneNumber };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
}

module.exports = { provisionPhoneNumber };
