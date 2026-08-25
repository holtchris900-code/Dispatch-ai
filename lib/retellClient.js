// Pushes an approved, paying client's script into Retell AI
// (https://www.retellai.com) so it becomes a real, callable phone agent --
// using plain `fetch`, no SDK, consistent with how lib/stripeClient.js and
// lib/emailClient.js talk to their APIs.
//
// Falls back to a demo-mode message if RETELL_API_KEY isn't set, the same
// pattern used everywhere else in this app (Claude, Stripe, Resend) when an
// optional service isn't configured yet -- so the dashboard button always
// works, it just doesn't create anything real until the key is added.
//
// NOTE: Retell's API has multiple endpoints and evolves over time. This
// reflects the documented request/response shape at
// https://docs.retellai.com/api-references as of when it was written --
// always sanity-check against their current docs before relying on it, and
// call the number yourself to test before handing it to a real client.

const crypto = require('crypto');

const RETELL_BASE_URL = 'https://api.retellai.com';

// A long, unguessable path segment for the Retell webhook route (see
// server.js's /api/retell/webhook/:token), derived from RETELL_API_KEY
// itself rather than a separate environment variable -- keeps this app's
// "no new required config" approach, while still meaning only someone who
// already has this app's Retell key could construct a working webhook URL.
// This is deliberately NOT an attempt to replicate Retell's own webhook
// signature scheme (their exact signing header can change -- check
// https://docs.retellai.com if you want to layer that on as well); the
// unguessable URL itself is what protects the endpoint here, the same
// pattern already used for the past-customer portal and Stripe customer
// portal links elsewhere in this app.
function retellWebhookToken() {
  const apiKey = process.env.RETELL_API_KEY || '';
  return crypto.createHash('sha256').update(`${apiKey}:webhook`).digest('hex').slice(0, 32);
}

async function retellRequest(path, body) {
  const apiKey = process.env.RETELL_API_KEY;
  const res = await fetch(`${RETELL_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Retell API error on ${path} (${res.status}): ${text}`);
  }
  return res.json();
}

// Creates a Retell "LLM" resource (the agent's brain, built from this
// client's own approved script) and then an "agent" wired to it (the voice
// + phone-facing side). Two separate Retell resources under the hood, but
// one call from this app's point of view.
async function createPhoneAgent({ companyName, script, webhookUrl }) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    return {
      demoMode: true,
      message:
        'RETELL_API_KEY is not set yet -- see LAUNCH_CHECKLIST.md Step 5 to connect Retell before a real phone agent can be created.',
    };
  }

  const llm = await retellRequest('/create-retell-llm', {
    general_prompt: script,
    model: 'gpt-4.1',
    start_speaker: 'agent',
    general_tools: [
      { type: 'end_call', name: 'end_call', description: 'End the call politely once the conversation is finished.' },
    ],
  });

  const agentBody = {
    response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
    voice_id: 'retell-Cimo', // pick a different voice at https://docs.retellai.com/api-references/list-voices
    agent_name: companyName || 'Dispatch AI agent',
  };
  // Lets Retell tell this app how long each real call lasted, so that
  // duration can count toward this client's monthly minutes the same way
  // website-widget chat messages do (see server.js's usage-tracking
  // section). Set once at agent creation -- there's no separate "update
  // webhook" step needed anywhere else in this app.
  if (webhookUrl) {
    agentBody.webhook_url = webhookUrl;
  }
  const agent = await retellRequest('/create-agent', agentBody);

  return {
    demoMode: false,
    llmId: llm.llm_id,
    agentId: agent.agent_id,
  };
}

module.exports = { createPhoneAgent, retellWebhookToken };
