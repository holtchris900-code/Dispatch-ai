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
const PHONE_AGENT_TOOLS_VERSION = 13; // 13: shorter greeting rule + chosen voice applied to existing agents

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
  // Some Retell endpoints (e.g. publish-agent-version) reply 200 with an
  // empty body -- that's a success, not something to parse.
  const replyText = await res.text();
  return replyText ? JSON.parse(replyText) : {};
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
// "07700 900123" -> "+447700900123"; anything unusable -> null.
function toE164Uk(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits.length >= 11 ? digits : null;
  if (digits.startsWith('44')) return `+${digits}`;
  if (digits.startsWith('0') && digits.length >= 10) return `+44${digits.slice(1)}`;
  return null;
}

function buildAgentPromptAndTools({ companyName, script, toolsUrl, timeZone, appointmentLengthMinutes, transferNumber }) {
  const generalTools = [
    { type: 'end_call', name: 'end_call', description: 'End the call politely once the conversation is finished.' },
  ];

  let generalPrompt = script;
  if (toolsUrl) {
    const businessName = companyName || 'this business';
    generalPrompt = `${script}

--- LIVE CALENDAR BOOKING ---
Right now it is {{current_time_${timeZone || 'Europe/London'}}} (the business's local time). Work out dates like "today", "tomorrow" or "next Tuesday" from this, never from memory, and always pass dates to the tools as YYYY-MM-DD with the correct year. Never offer or book a time that has already passed. If a tool ever replies that a time has already passed, quietly work out the correct date from the current time above and check again -- don't tell the caller about the mix-up.
You also have tools that check and write directly to ${businessName}'s real calendar (when it's connected): check_availability, book_appointment, reschedule_appointment, and cancel_appointment. This business is in the ${timeZone || 'Europe/London'} time zone, and a typical appointment takes about ${appointmentLengthMinutes || '60'} minutes unless the customer describes something bigger. Always call check_availability before offering or confirming any specific time to the customer -- never guess or assume a slot is open. Once the customer has agreed to a specific time you've confirmed is free, and you have their name plus a phone number or email to reach them, call book_appointment to actually create it. If a customer calls back wanting to move or cancel an appointment they already have, ask for the phone number it was booked under and use reschedule_appointment or cancel_appointment -- always confirm with them before cancelling, since it can't be undone from the call. If a tool reports the calendar isn't connected, that something went wrong, or that no matching appointment was found, fall back to collecting the customer's details and telling them a team member will confirm it -- never tell a customer their appointment is booked, moved, or cancelled unless the tool itself reports success. Whenever you fall back like this, call log_job_request straight away with everything you've collected (their name, phone number or email, what they need, and when they'd like someone) before you wrap up the call -- that is how the business sees the request. Getting contact details right matters more than speed: ask the caller to spell their email address, then read it back to them letter by letter (for example "j, o, h, n, dot, s, m, i, t, h, at gmail dot com") and ask them to confirm it's right before you save it. Read phone numbers back digit by digit in the same way. For any job at the customer's property, ask for the address where the work is needed, including the postcode, and read the postcode back to check it -- pass it as customerAddress to log_job_request and book_appointment. If the caller corrects anything after you've already called log_job_request, call log_job_request again with the corrected details -- it updates the same job rather than adding a new one. Before ending any call where you've taken a job, read back a short summary of everything you've saved (name, phone number, email, address, what they need, when they'd like someone) and ask "Is all of that right?". If you get interrupted or sidetracked while confirming details -- the caller says something by accident, coughs, asks a side question, or tells you to ignore something -- deal with it briefly, then go back to exactly where you were and finish confirming every detail. Never skip or drop the confirmation because of an interruption. Never promise the customer that someone will come at a particular time (for example "we can get someone out to you today") until a booking has actually been confirmed by book_appointment.`;

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
            customerAddress: { type: 'string', description: 'Address where the work is needed, including the postcode' },
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
        "Call this as soon as you know what job or service the caller wants done AND have at least one way to reach them (a name plus a phone number or email). Call it even if you go on to book a specific appointment time right after -- this is what lets the business see every real job request, not just the ones that get booked on the spot. Before calling it, read their email (letter by letter) and phone number (digit by digit) back to them and get them to confirm. If they correct any detail afterwards, call it again with the corrected details -- this updates the same job instead of creating a new one.",
      url: toolsUrl,
      http_method: 'POST',
      input_schema: {
        type: 'object',
        properties: {
          customerName: { type: 'string' },
          customerPhone: { type: 'string' },
          customerEmail: { type: 'string' },
          customerAddress: { type: 'string', description: 'Address where the work is needed, including the postcode' },
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
  // Speaking to a real person, and a typed fallback for callers the AI is
  // struggling with. Transfer only works on real phone calls (not Retell's
  // web test calls), and only when the business gave a number to send them to.
  const transferTo = toE164Uk(transferNumber);
  generalPrompt += `\n\n--- SPEAKING TO A PERSON ---\nRight after your opening greeting, add one short line letting the caller know they can ask for a person at any time, for example: "...and if you'd rather speak to a person at any point, just say." Don't ask them whether they want to be transferred -- just let them know it's there.`;
  if (transferTo) {
    generalTools.push({
      type: 'transfer_call',
      name: 'transfer_to_person',
      description:
        'Transfer the caller to a real person at the business. Use this when the caller asks to speak to a person, or when you have misunderstood them twice in a row and they would like to speak to someone. Tell them you are putting them through first.',
      transfer_destination: { type: 'predefined', number: transferTo },
      transfer_option: { type: 'cold_transfer', show_transferee_as_caller: false },
    });
    generalPrompt += `\nIf the caller asks for a person, or you've misunderstood them twice in a row, offer to put them through and use transfer_to_person once they agree. Before transferring, if you have their name and number, call log_job_request so their details aren't lost. If the transfer doesn't go through, apologise, take their details with log_job_request and tell them someone will call them back as soon as possible.`;
  } else {
    generalPrompt += `\nThis business hasn't set up a number to transfer calls to. If the caller asks for a person, explain that nobody can come to the phone right now, take their name, number and what they need with log_job_request, and tell them someone will call them back as soon as possible.`;
  }
  if (toolsUrl) {
    generalTools.push({
      type: 'custom_function',
      name: 'send_help_link',
      description:
        "Text the caller a link where they can type out what they need (and, where available, pick an appointment time) instead of talking. Offer this if you're having real trouble understanding them -- for example a bad line or background noise -- or if they'd rather type. Only use it once they agree. It texts the number they're calling from.",
      url: toolsUrl,
      http_method: 'POST',
      speak_during_execution: "Okay, I'm sending that text now.",
      speak_after_execution: true,
      input_schema: { type: 'object', properties: {}, required: [] },
    });
    generalPrompt += `\nIf you're struggling to understand the caller (a bad line, background noise, or you've had to ask them to repeat themselves several times), offer to text them a link where they can type what they need instead, and use send_help_link if they agree. If it reports the text couldn't be sent, take whatever details you can with log_job_request instead.`;
  }

  if (!generalPrompt.includes('--- LANGUAGE ---')) {
    generalPrompt += `\n\n--- LANGUAGE ---\nThis business may get calls in English or Polish. Detect which language the caller is speaking and respond fluently in that same language throughout the call, while still following the instructions and script above.`;
  }


  // These rules go at the very TOP of the prompt: the model follows what it
  // reads first most reliably, and a business's own script often has its
  // own greeting and a list of details to collect that would otherwise win.
  const callRules = `--- HOW TO RUN EVERY CALL (always follow these, even if the script below says otherwise) ---
1. Keep your very first message SHORT -- two short sentences at most: who you are (the business's AI assistant), that they can ask for a real person at any point, and how you can help. For example: "Hi, thanks for calling [business]. I'm the AI assistant -- you can ask for a person at any point. How can I help?" Leave opening hours, service area and anything else out of the greeting; answer those only if asked. Don't ask whether they want to be transferred -- just let them know it's an option.
2. Collect details ONE AT A TIME, like a real receptionist. Ask a single question, wait for the answer, check it if needed, then ask the next. Never list several things you need in one go (for example never say "I'll need your name, number, email and address").
3. A good order is: what they need, then their name, then their phone number, then their email (spelled out and read back), then the address and postcode (postcode read back), then when they'd like someone.
4. Keep each reply short -- one or two sentences -- this is a phone call.
5. Once book_appointment confirms a booking, tell the caller you're sending a confirmation to their email (or by text if they gave no email) with all their details, and that if anything is wrong -- like the address -- they can fix it themselves from the link in it.

`;
  generalPrompt = callRules + generalPrompt;
  return { generalPrompt, generalTools: generalTools.map(toRetellTool) };
}

// Retell's API only accepts custom tools as type "custom", with the request
// method in "method", the arguments schema in "parameters", and
// speak_during_execution as true/false (the words to say go in
// execution_message_description). The tool definitions above use an older
// shape, so this converts each one just before it's sent -- Retell rejects
// the whole agent with a 400 error otherwise. See
// https://docs.retellai.com/api-references/create-retell-llm
function toRetellTool(tool) {
  if (tool.type !== 'custom_function') return tool;
  const converted = {
    type: 'custom',
    name: tool.name,
    description: tool.description,
    url: tool.url,
    method: tool.http_method || 'POST',
    parameters: tool.input_schema,
    speak_during_execution: Boolean(tool.speak_during_execution),
    // Say the result out loud afterwards, except for the background
    // job-logging tool, which should never interrupt the conversation.
    speak_after_execution: tool.speak_after_execution !== undefined ? Boolean(tool.speak_after_execution) : tool.name !== 'log_job_request',
    timeout_ms: 20000,
  };
  if (typeof tool.speak_during_execution === 'string') {
    converted.execution_message_description = tool.speak_during_execution;
  }
  return converted;
}

// Creates a Retell "LLM" resource (the agent's brain, built from this
// client's own approved script) and then an "agent" wired to it (the voice
// + phone-facing side). Two separate Retell resources under the hood, but
// one call from this app's point of view.
async function createPhoneAgent({ companyName, script, webhookUrl, toolsUrl, timeZone, appointmentLengthMinutes, transferNumber }) {
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
    transferNumber,
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
async function updatePhoneAgentTools({ llmId, agentId, phoneNumber, companyName, script, toolsUrl, timeZone, appointmentLengthMinutes, transferNumber }) {
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
    transferNumber,
  });

  // Retell versions: real phone calls use a PUBLISHED agent version, and a
  // published version is read-only. So: make sure there's a draft to edit
  // (copying the current published one if needed), update it, publish it,
  // and point the business's number at it. Any failure throws, so the
  // background refresh retries on the next page load instead of marking
  // the agent as up to date.
  let draftVersion = null;
  if (agentId) {
    const agent = await retellRequest(`/get-agent/${agentId}`, undefined, 'GET');
    draftVersion = agent.version;
    if (agent.is_published) {
      const draft = await retellRequest(`/create-agent-version/${agentId}`, { base_version: agent.version });
      draftVersion = draft.version;
    }
  }

  const llm = await retellRequest(
    `/update-retell-llm/${llmId}`,
    { general_prompt: generalPrompt, general_tools: generalTools },
    'PATCH'
  );
  const result = { demoMode: false, updated: true, llmVersion: llm && llm.version };

  // Voice: RETELL_VOICE_ID in Render picks the voice for every agent. Set
  // on the draft (update-agent edits the latest draft) before publishing.
  if (agentId && process.env.RETELL_VOICE_ID) {
    await retellRequest(`/update-agent/${agentId}`, { voice_id: process.env.RETELL_VOICE_ID }, 'PATCH');
    result.voiceId = process.env.RETELL_VOICE_ID;
  }

  if (agentId) {
    await retellRequest(`/publish-agent-version/${agentId}`, {
      version: draftVersion,
      version_title: `Dispatch AI update v${PHONE_AGENT_TOOLS_VERSION}`,
    });
    result.publishedVersion = draftVersion;
    if (phoneNumber) {
      await pointNumberAtVersion({ phoneNumber, agentId, version: draftVersion });
      result.numberPointedAt = draftVersion;
    }
  }

  return result;
}

async function pointNumberAtVersion({ phoneNumber, agentId, version }) {
  return retellRequest(
    `/update-phone-number/${encodeURIComponent(phoneNumber)}`,
    { inbound_agents: [{ agent_id: agentId, agent_version: version, weight: 1 }] },
    'PATCH'
  );
}

// Returns the agent's current version number, publishing it first if it's
// still a draft -- so a newly connected number answers with a published,
// fixed version rather than whatever happens to be in the editor.
async function ensurePublishedVersion(agentId) {
  const agent = await retellRequest(`/get-agent/${agentId}`, undefined, 'GET');
  if (!agent.is_published) {
    await retellRequest(`/publish-agent-version/${agentId}`, {
      version: agent.version,
      version_title: `Dispatch AI v${PHONE_AGENT_TOOLS_VERSION}`,
    });
  }
  return agent.version;
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

  // Pin the number to a published version (see updatePhoneAgentTools). If
  // that lookup fails, import anyway with Retell's default rather than
  // leaving the business with no working number.
  let agentVersion;
  try {
    agentVersion = await ensurePublishedVersion(agentId);
  } catch (err) {
    console.error(`Publishing agent ${agentId} before import failed:`, err.message || err);
  }

  const imported = await retellRequest('/import-phone-number', {
    phone_number: phoneNumber,
    termination_uri: terminationUri,
    sip_trunk_auth_username: process.env.TELNYX_SIP_USERNAME || undefined,
    sip_trunk_auth_password: process.env.TELNYX_SIP_PASSWORD || undefined,
    inbound_agents: [{ agent_id: agentId, weight: 1, ...(agentVersion != null ? { agent_version: agentVersion } : {}) }],
    nickname: nickname || undefined,
  });

  return { demoMode: false, phoneNumber: imported.phone_number || phoneNumber };
}

// Read-only look at what Retell actually has for an agent, for the
// founder's phone-agent check page in server.js.
async function getAgentSnapshot({ agentId, llmId }) {
  const out = {};
  try {
    const agent = await retellRequest(`/get-agent/${agentId}`, undefined, 'GET');
    out.agent = {
      name: agent.agent_name,
      version: agent.version,
      isPublished: agent.is_published,
      llmId: agent.response_engine && agent.response_engine.llm_id,
      llmVersion: agent.response_engine && agent.response_engine.version,
    };
  } catch (err) {
    out.agentError = err.message || String(err);
  }
  try {
    const llm = await retellRequest(`/get-retell-llm/${llmId}`, undefined, 'GET');
    out.llm = {
      version: llm.version,
      isPublished: llm.is_published,
      promptStart: String(llm.general_prompt || '').slice(0, 90),
      tools: (llm.general_tools || []).map((t) => t.name),
    };
  } catch (err) {
    out.llmError = err.message || String(err);
  }
  return out;
}

module.exports = { createPhoneAgent, updatePhoneAgentTools, retellWebhookToken, importPhoneNumber, PHONE_AGENT_TOOLS_VERSION, getAgentSnapshot };
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
