// Pushes an APPROVED client script to Retell AI so it becomes a real,
// callable phone agent. Run this manually for now (node scripts/create-retell-agent.js <clientId>)
// once you've signed up for Retell (https://www.retellai.com) and have a RETELL_API_KEY.
//
// This is intentionally a standalone script, not wired into the dashboard's
// "Approve" button yet -- creating a real phone agent is a bigger, less
// reversible step than just approving a draft, so it's worth doing by hand
// until you've tested this a few times and trust the flow.
//
// NOTE: Retell's API has multiple endpoints and evolves over time. Before
// relying on this in production, sanity-check the current request/response
// shapes against https://docs.retellai.com/api-references -- this script
// reflects the documented shape as of when it was written, but always verify.

require('../lib/loadEnv')();
const db = require('../lib/db');

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const BASE_URL = 'https://api.retellai.com';

async function retellRequest(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${RETELL_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Retell API error on ${path} (${res.status}): ${text}`);
  }
  return res.json();
}

async function main() {
  const clientId = process.argv[2];
  if (!clientId) {
    console.error('Usage: node scripts/create-retell-agent.js <clientId>');
    process.exit(1);
  }
  if (!RETELL_API_KEY) {
    console.error('RETELL_API_KEY is not set in .env -- sign up at https://www.retellai.com first.');
    process.exit(1);
  }

  const client = db.getClient(clientId);
  if (!client) {
    console.error(`No client found with id ${clientId}`);
    process.exit(1);
  }
  if (client.status !== 'approved') {
    console.error(`Client status is "${client.status}", not "approved" -- approve the script in the dashboard first.`);
    process.exit(1);
  }

  console.log(`Creating Retell LLM resource for ${client.intake.companyName}...`);
  const llm = await retellRequest('/create-retell-llm', {
    general_prompt: client.script,
    model: 'gpt-4.1',
    start_speaker: 'agent',
    general_tools: [
      { type: 'end_call', name: 'end_call', description: 'End the call politely once the conversation is finished.' },
    ],
  });
  console.log(`Created LLM: ${llm.llm_id}`);

  console.log('Creating Retell agent...');
  const agent = await retellRequest('/create-agent', {
    response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
    voice_id: 'retell-Cimo', // pick a voice from https://docs.retellai.com/api-references/list-voices
    agent_name: client.intake.companyName,
  });
  console.log(`Created agent: ${agent.agent_id}`);

  console.log('\nNext step (do this in the Retell dashboard, not this script):');
  console.log('1. Go to retellai.com -> Phone Numbers -> buy or import a number.');
  console.log(`2. Assign this number's inbound agent to agent_id: ${agent.agent_id}`);
  console.log('3. Call the number yourself to test before giving it to real customers.');

  db.updateClient(clientId, {
    retellLlmId: llm.llm_id,
    retellAgentId: agent.agent_id,
    status: 'live_pending_phone_number',
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
