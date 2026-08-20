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

const RETELL_BASE_URL = 'https://api.retellai.com';

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
async function createPhoneAgent({ companyName, script }) {
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

  const agent = await retellRequest('/create-agent', {
    response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
    voice_id: 'retell-Cimo', // pick a different voice at https://docs.retellai.com/api-references/list-voices
    agent_name: companyName || 'Dispatch AI agent',
  });

  return {
    demoMode: false,
    llmId: llm.llm_id,
    agentId: agent.agent_id,
  };
}

module.exports = { createPhoneAgent };
