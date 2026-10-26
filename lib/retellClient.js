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

// Bump this any time buildAgentPromptAndTools below meaningfully changes
// (a new tool added, an existing one's behavior changed, etc). server.js
// compares a client's stored retellToolsVersion against this number every
// time they load their own client portal (or the founder loads their card
// in the dashboard) and, if it's out of date, silently refreshes that
// client's live agent in the background -- no one has to notice anything
// changed or click a button again. This is what turned this round's
// reschedule/cancel fix (and every future one like it) from "existing
// clients must remember to re-click Create phone agent" into "it just
// happens automatically the next time they open their portal."
const PHONE_AGENT_TOOLS_VERSION = 2;

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

async function retellRequest(path, body, method = 'POST') {
  const apiKey = process.env.RETELL_API_KEY;
  const res = await fetch(`${RETELL_BASE_URL}${path}`, {
    method,
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

// Builds the general_prompt + general_tools payload shared by BOTH creating
// a brand new phone agent and refreshing an existing one's tools (see
// updatePhoneAgentTools below) -- one shared builder so the two code paths
// can never drift apart and quietly end up with different booking behavior.
//
// toolsUrl (optional): when provided, the agent also gets live
// check_availability / book_appointment / reschedule_appointment /
// cancel_appointment tools pointed at that URL -- the same real-time
// Google Calendar booking the website chat widget already has (see
// server.js's BOOKING_TOOLS / executeBookingTool), just reached over the
// phone instead of over chat. Mirrors the same "BOOKING:" instructions
// given to the chat widget (see lib/widgetChatPrompt.js) so both surfaces
// behave identically -- always check before offering a time, never claim
// something's booked/moved/cancelled unless the tool itself reports
// success, and fall back to "a team member will confirm" if the calendar
// isn't connected or something goes wrong. Safe to always pass this in: if
// the client hasn't connected a calendar yet, the tools themselves report
// "not connected" and the agent falls back to collecting details, same as
// if the tools were never attached at all.
function buildAgentPromptAndTools({ companyName, script, toolsUrl, timeZone, appointmentLengthMinutes }) {
  const generalTools = [
    { type: 'end_call', name: 'end_call', description: 'End the call politely once the conversation is finished.' },
  ];

  let generalPrompt = script;
  if (toolsUrl) {
    const businessName = companyName || 'this business';
    generalPrompt = `${script}

--- LIVE CALENDAR BOOKING ---
You also have tools that check and write directly to ${businessName}'s real calendar (when it's connected): check_availability, book_appointment, reschedule_appointment, and cancel_appointment. This business is in the ${timeZone || 'Europe/London'} time zone, and a typical appointment takes about ${appointmentLengthMinutes || '60'} minutes unless the customer describes something bigger. Always call check_availability before offering or confirming any specific time to the customer -- never guess or assume a slot is open. Once the customer has agreed to a specific time you've confirmed is free, and you have their name plus a phone number or email to reach them, call book_appointment to actually create it. If a customer calls back wanting to move or cancel an appointment they already have, ask for the phone number it was booked under and use reschedule_appointment or cancel_appointment -- always confirm with them before cancelling, since it can't be undone from the call. If a tool reports the calendar isn't connected, that something went wrong, or that no matching appointment was found, fall back to collecting the customer's details and telling them a team member will confirm it -- never tell a customer their appointment is booked, moved, or cancelled unless the tool itself reports success.`;

    generalTools.push(
      {
        type: 'custom_function',
        name: 'check_availability',
        description:
          "Check whether a specific date and time is actually free on the business's real calendar. ALWAYS call this before you offer or confirm any specific appointment time to the customer -- never guess or assume a time is open.",
        url: toolsUrl,
        http_method: 'POST',
        speak_during_execution: 'Let me just check that for you.',
        speak_after_execution: true,
        input_schema: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD' },
            startTime: { type: 'string', description: '24-hour HH:MM, e.g. 14:00' },
            durationMinutes: { type: 'integer', description: 'Expected length of the appointment in minutes' },
          },
          required: ['date', 'startTime'],
        },
      },
      {
        type: 'custom_function',
        name: 'book_appointment',
        description:
          "Create a REAL appointment on the business's calendar. Only call this once the customer has agreed to a specific date and time you already confirmed was free with check_availability, and you have their name plus a phone number or email to reach them. Never tell a customer their appointment is booked unless this tool reports success.",
        url: toolsUrl,
        http_method: 'POST',
        speak_during_execution: "Great, I'm booking that in now.",
        speak_after_execution: true,
        input_schema: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD' },
            startTime: { type: 'string', description: '24-hour HH:MM' },
            durationMinutes: { type: 'integer' },
            customerName: { type: 'string' },
            customerPhone: { type: 'string' },
            customerEmail: { type: 'string' },
            issueDescription: { type: 'string', description: 'Short description of what the customer needs' },
          },
          required: ['date', 'startTime', 'customerName'],
        },
      }
    );
    generalTools.push({
      type: 'custom_function',
      name: 'reschedule_appointment',
      description:
        "Move an existing CONFIRMED appointment to a new date and time. Ask the customer for the phone number their original appointment was booked under so the right one can be found, and ALWAYS call check_availability on the new time before offering or confirming it. If no matching appointment is found, tell the customer you can't find a booking under that number -- don't guess, and don't book a brand-new appointment instead without saying so.",
      url: toolsUrl,
      http_method: 'POST',
      speak_during_execution: "One moment, I'm moving that for you.",
      speak_after_execution: true,
      input_schema: {
        type: 'object',
        properties: {
          customerPhone: { type: 'string', description: 'The phone number the original appointment was booked under' },
          newDate: { type: 'string', description: 'YYYY-MM-DD' },
          newStartTime: { type: 'string', description: '24-hour HH:MM' },
          durationMinutes: { type: 'integer' },
        },
        required: ['customerPhone', 'newDate', 'newStartTime'],
      },
    });
    generalTools.push({
      type: 'custom_function',
      name: 'cancel_appointment',
      description:
        "Cancel an existing CONFIRMED appointment. Ask the customer for the phone number their original appointment was booked under so the right one can be found, and confirm with them that they actually want to cancel before calling this -- it can't be undone from this conversation. If no matching appointment is found, tell the customer you can't find a booking under that number.",
      url: toolsUrl,
      http_method: 'POST',
      speak_during_execution: "Okay, cancelling that now.",
      speak_after_execution: true,
      input_schema: {
        type: 'object',
        properties: {
          customerPhone: { type: 'string', description: 'The phone number the original appointment was booked under' },
        },
        required: ['customerPhone'],
      },
    });
    generalTools.push({
      type: 'custom_function',
      name: 'flag_emergency',
      description:
        "Call this IMMEDIATELY the moment the caller describes a genuine emergency as defined in this business's own script (e.g. a gas smell, a burst pipe or active flooding, no heat in freezing weather, exposed wiring) -- this alerts the business right away, it does not just save a note for later. Do not wait until the end of the call to call it.",
      url: toolsUrl,
      http_method: 'POST',
      speak_during_execution: "I'm flagging this as urgent right now.",
      speak_after_execution: true,
      input_schema: {
        type: 'object',
        properties: {
          issueSummary: { type: 'string', description: 'One sentence describing the emergency, in your own words' },
          callerName: { type: 'string' },
          callerPhone: { type: 'string' },
        },
        required: ['issueSummary'],
      },
    });
    generalTools.push({
      type: 'custom_function',
      name: 'log_job_request',
      description:
        "Call this once -- and only once -- per caller, as soon as you know what job or service they want done AND have at least one way to reach them (a name plus a phone number or email). Call it even if you go on to book a specific appointment time right after -- this is what lets the business see every real job request, not just the ones that get booked on the spot. Don't call it again just because they mention more detail afterwards.",
      url: toolsUrl,
      http_method: 'POST',
      input_schema: {
        type: 'object',
        properties: {
          customerName: { type: 'string' },
          customerPhone: { type: 'string' },
          customerEmail: { type: 'string' },
          jobDescription: { type: 'string', description: 'What they want done, in their own words' },
          preferredTime: {
            type: 'string',
            description: "Whatever they said about timing, in their own words (e.g. 'tomorrow afternoon', 'whenever is cheapest') -- not necessarily a confirmed booking",
          },
        },
        required: ['jobDescription'],
      },
    });
  }
  if (!generalPrompt.includes('--- LANGUAGE ---')) {
    generalPrompt += `\n\n--- LANGUAGE ---\nThis business may get calls in English or Polish. Detect which language the caller is speaking and respond fluently in that same language throughout the call, while still following the instructions and script above.`;
  }


  return { generalPrompt, generalTools };
}

// Creates a Retell "LLM" resource (the agent's brain, built from this
// client's own approved script) and then an "agent" wired to it (the voice
// + phone-facing side). Two separate Retell resources under the hood, but
// one call from this app's point of view.
async function createPhoneAgent({ companyName, script, webhookUrl, toolsUrl, timeZone, appointmentLengthMinutes }) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    return {
      demoMode: true,
      message:
        'RETELL_API_KEY is not set yet -- see LAUNCH_CHECKLIST.md Step 5 to connect Retell before a real phone agent can be created.',
    };
  }

  const { generalPrompt, generalTools } = buildAgentPromptAndTools({
    companyName,
    script,
    toolsUrl,
    timeZone,
    appointmentLengthMinutes,
  });

  const llm = await retellRequest('/create-retell-llm', {
    general_prompt: generalPrompt,
    model: 'gpt-4.1',
    start_speaker: 'agent',
    general_tools: generalTools,
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
  agentBody.language = 'multi';
  if (process.env.RETELL_VOICE_ID) {
    agentBody.voice_id = process.env.RETELL_VOICE_ID;
  }

  const agent = await retellRequest('/create-agent', agentBody);

  return {
    demoMode: false,
    llmId: llm.llm_id,
    agentId: agent.agent_id,
  };
}

// Refreshes an EXISTING agent's brain (its Retell LLM resource) with the
// client's current script and calendar-booking tools, using a PATCH to
// Retell's /update-retell-llm/{llm_id} endpoint -- for a client whose phone
// agent was created before real-time booking existed (or whose script has
// changed since their agent was first built). Uses the exact same builder
// as createPhoneAgent, so an "updated" agent ends up with identical
// behavior to a freshly-created one. Does NOT touch the agent's phone
// number, voice, or call-duration webhook -- only the LLM's brain, so it's
// safe to call any time a client's card is revisited (e.g. every time the
// dashboard's "Create phone agent" / "Retry automatic number" button is
// clicked for a client who already has an agent -- see server.js). This is
// also how an existing agent picks up brand-new tools added to the builder
// above (e.g. reschedule_appointment / cancel_appointment) after it was
// first created -- a client just needs that same button clicked once more.
async function updatePhoneAgentTools({ llmId, companyName, script, toolsUrl, timeZone, appointmentLengthMinutes }) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey || !llmId) {
    return { demoMode: true, updated: false };
  }

  const { generalPrompt, generalTools } = buildAgentPromptAndTools({
    companyName,
    script,
    toolsUrl,
    timeZone,
    appointmentLengthMinutes,
  });

  await retellRequest(
    `/update-retell-llm/${llmId}`,
    { general_prompt: generalPrompt, general_tools: generalTools },
    'PATCH'
  );

  return { demoMode: false, updated: true };
}

// Binds an externally-bought number (e.g. from lib/telnyxClient.js) to one
// specific client's own agent, via Retell's SIP trunk import -- this is what
// makes "a client goes live, they get a real number pointed at their own
// agent, automatically" possible with no clicking around inside Retell's
// dashboard.
//
// The SIP trunk fields here (TELNYX_SIP_TERMINATION_URI / _USERNAME /
// _PASSWORD) come from the same one-time Telnyx "Connection" set up for
// lib/telnyxClient.js -- reused for every number, never created per call.
// See LAUNCH_CHECKLIST.md Step 5.
async function importPhoneNumber({ phoneNumber, agentId, nickname }) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    return {
      demoMode: true,
      message: 'RETELL_API_KEY is not set yet -- cannot import a phone number without it.',
    };
  }
  const terminationUri = process.env.TELNYX_SIP_TERMINATION_URI;
  if (!terminationUri) {
    return {
      demoMode: true,
      message:
        'TELNYX_SIP_TERMINATION_URI (plus TELNYX_SIP_USERNAME / TELNYX_SIP_PASSWORD) is not set yet -- see LAUNCH_CHECKLIST.md Step 5 for the one-time Telnyx SIP connection setup that makes automatic number-buying possible.',
    };
  }

  const imported = await retellRequest('/import-phone-number', {
    phone_number: phoneNumber,
    termination_uri: terminationUri,
    sip_trunk_auth_username: process.env.TELNYX_SIP_USERNAME || undefined,
    sip_trunk_auth_password: process.env.TELNYX_SIP_PASSWORD || undefined,
    inbound_agents: [{ agent_id: agentId, weight: 1 }],
    nickname: nickname || undefined,
  });

  return { demoMode: false, phoneNumber: imported.phone_number || phoneNumber };
}

module.exports = { createPhoneAgent, updatePhoneAgentTools, retellWebhookToken, importPhoneNumber, PHONE_AGENT_TOOLS_VERSION };
// --- Outbound "emergency alert briefing" call ------------------------------
// Rather than just texting or emailing the business when flag_emergency
// fires, this places a REAL outbound phone call -- from the client's own
// Dispatch AI number, to whatever on-call number they gave on their intake
// form -- using one shared Retell agent (created once, reused for every
// client and every incident, see getOrCreateEmergencyAlertAgent below) whose
// only job is to brief whoever answers on this one incident's details and
// answer direct follow-up questions about them. It cannot dispatch a crew,
// look anything else up, or take any other action -- see
// buildEmergencyAlertPrompt. If the on-call person can't be briefed this way
// (no Retell key configured, no agent created yet and creating one fails,
// etc.) this returns null rather than throwing, so server.js can simply fall
// back to texting/emailing instead -- never breaks a live call or chat over
// this failing.
//
// Retell's dynamic-variable substitution ({{...}} in the prompt, filled in
// per-call via retell_llm_dynamic_variables below) is what lets ONE shared
// agent brief any client about any incident, rather than needing a separate
// agent per client. As with the rest of this file: sanity-check the
// `/v2/create-phone-call` request/response shape against
// https://docs.retellai.com/api-references before relying on this, and
// place a real test call to your own phone before trusting it with a client.
function buildEmergencyAlertPrompt() {
  return `You are calling {{company_name}}'s on-call phone to brief them about an emergency just reported through their Dispatch AI phone/chat assistant. You are NOT talking to the original caller -- you're talking to {{company_name}}'s own team.

Open by identifying yourself clearly: say you're an automated alert call from their Dispatch AI assistant about an urgent report.

Then tell them, in plain spoken language:
- What was reported: {{issue_summary}}
- The caller's name, if known: {{caller_name}}
- The caller's phone number, if known: {{caller_phone}}

You can repeat any of these details again if asked, or spell out the phone number digit by digit if asked. You cannot look anything else up, dispatch a team, or take any other action -- you are only here to brief them on this one incident and answer direct questions about these exact details. If asked something you don't know, say that's everything that was captured and they'll need to call the customer back directly for anything else.

Once they've confirmed they've got it (or after repeating the details if asked), end the call politely.`;
}

async function getOrCreateEmergencyAlertAgent(db) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) return null;

  const cached = db.getEmergencyAlertAgent();
  if (cached && cached.agentId) return cached;

  const llm = await retellRequest('/create-retell-llm', {
    general_prompt: buildEmergencyAlertPrompt(),
    model: 'gpt-4.1',
    start_speaker: 'agent',
    general_tools: [
      { type: 'end_call', name: 'end_call', description: 'End the call politely once the on-call person has the details.' },
    ],
  });

  const agent = await retellRequest('/create-agent', {
    response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
    voice_id: process.env.RETELL_VOICE_ID || 'retell-Cimo',
    agent_name: 'Dispatch AI emergency alert',
    language: 'multi',
  });

  return db.saveEmergencyAlertAgent({ llmId: llm.llm_id, agentId: agent.agent_id });
}

async function placeEmergencyAlertCall(db, { fromNumber, toNumber, companyName, issueSummary, callerName, callerPhone }) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey || !fromNumber || !toNumber) return null;

  try {
    const agent = await getOrCreateEmergencyAlertAgent(db);
    if (!agent || !agent.agentId) return null;

    const call = await retellRequest('/v2/create-phone-call', {
      from_number: fromNumber,
      to_number: toNumber,
      override_agent_id: agent.agentId,
      retell_llm_dynamic_variables: {
        company_name: companyName || 'your business',
        issue_summary: issueSummary || 'An urgent issue was reported, no further details given.',
        caller_name: callerName || 'not given',
        caller_phone: callerPhone || 'not given',
      },
    });

    return { callId: call.call_id };
  } catch (err) {
    console.error('Emergency alert call failed:', err.message || err);
    return null;
  }
}

module.exports.placeEmergencyAlertCall = placeEmergencyAlertCall;
