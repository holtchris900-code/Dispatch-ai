// Deliberately built with ZERO npm dependencies (only Node's built-in
// `http`, `fs`, `path`, `crypto` modules). This means it runs anywhere with
// Node 18+ installed with no "npm install" step required, which keeps the
// path from "download this" to "it's running" as short as possible.

require('./lib/loadEnv')();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./lib/db');
const { callClaude } = require('./lib/claude');
const { buildScriptGenerationPrompt, DEMO_SYSTEM_PROMPT, buildPersonalizedDemoPrompt } = require('./lib/scriptPrompt');
const { HELP_CHAT_SYSTEM_PROMPT } = require('./lib/helpChatPrompt');
const { buildWidgetChatSystemPrompt } = require('./lib/widgetChatPrompt');
const { buildConversationInsightPrompt, parseConversationInsight } = require('./lib/conversationInsightPrompt');
const { buildFollowUpDraftPrompt, parseFollowUpDraft } = require('./lib/followUpPrompt');
const { buildScriptSafetyCheckPrompt, parseScriptSafetyCheck } = require('./lib/scriptSafetyCheckPrompt');
const { sendEmail } = require('./lib/emailClient');
const { createCheckoutSession, verifyStripeSignature, createPortalSession, getCheckoutSession, createInvoiceItem } = require('./lib/stripeClient');
const { createPhoneAgent, updatePhoneAgentTools, retellWebhookToken, PHONE_AGENT_TOOLS_VERSION } = require('./lib/retellClient');
const { provisionPhoneNumber } = require('./lib/phoneProvisioning');
const { sendSms } = require('./lib/telnyxClient');
const googleCalendar = require('./lib/googleCalendarClient');

const { parseCsv } = require('./lib/csv');
const { buildPastCustomerOutreachPrompt, parsePastCustomerOutreach, monthsSince } = require('./lib/pastCustomerOutreachPrompt');
const { buildReviewRequestPrompt } = require('./lib/reviewRequestPrompt');


const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Used to build links that go OUT of the app (texted/emailed to a real
// customer) from code paths that don't have access to the current
// request's own host (e.g. executeBookingTool, shared by both the website
// chat widget and the Retell phone-call webhook). Override with an env var
// if this app is ever moved to a different domain.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://dispatch-ai-pd2p.onrender.com';
// A plain, human-readable "Tue 3 Nov, 2:00pm" style label for appointment
// confirmation texts/emails and the client-portal appointments list --
// built from an RFC3339 string (what googleCalendarClient.js already
// produces) and the business's own IANA timeZone, so it always reads in
// the business's local time, not the server's.
function formatApptForHuman(rfc3339, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'Europe/London',
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit',
    }).format(new Date(rfc3339));
  } catch (err) {
    return rfc3339;
  }
}

// Emails the business owner whenever one of THEIR customers' appointments
// changes without the owner doing it themselves -- the AI moving or
// cancelling one mid-call/mid-chat, or the customer doing it from their own
// manage-appointment link. Deliberately NOT called from the client-portal
// routes where the business owner cancels/reschedules something themselves
// (see server.js's clientPortalAppointmentCancelMatch /
// clientPortalAppointmentRescheduleMatch below) -- they already know, since
// they just did it. Best-effort and silent on failure, same pattern as
// notifyFounder and the customer's own booking-confirmation send above:
// never lets a notification problem affect the actual booking change.
async function notifyBusinessOwnerOfAppointmentChange(clientRecord, appt, kind) {
  const ownerEmail = clientRecord?.intake?.contactEmail;
  if (!ownerEmail) return;
  try {
    const companyName = clientRecord.intake?.companyName || 'your business';
    const who = appt.customerName || 'A customer';
    const contactBits = [appt.customerPhone, appt.customerEmail].filter(Boolean).join(' / ');
    const whoLine = contactBits ? `${who} (${contactBits})` : who;
    const whenLabel = formatApptForHuman(appt.startAt, appt.timeZone);
    const portalLink = clientRecord.clientPortalToken
      ? `${PUBLIC_BASE_URL}/client-portal.html?token=${clientRecord.clientPortalToken}`
      : `${PUBLIC_BASE_URL}/client-login`;

    const subject =
      kind === 'cancelled'
        ? `${companyName}: an appointment was cancelled`
        : `${companyName}: an appointment was moved`;
    const text =
      kind === 'cancelled'
        ? `${whoLine} cancelled their appointment that was booked for ${whenLabel}.\n\nView your schedule: ${portalLink}`
        : `${whoLine} moved their appointment to ${whenLabel}.\n\nView your schedule: ${portalLink}`;

    await sendEmail({ to: ownerEmail, subject, text, fromName: 'Dispatch AI' });
  } catch (err) {
    console.error(`Business-owner appointment-change notification failed for client ${clientRecord.id}:`, err.message || err);
  }
}

// Silently keeps an existing client's phone agent up to date with the
// latest booking tools, with no one having to notice anything changed or
// click a button again. Call this (fire-and-forget -- never awaited) from
// a page-load route a client or the founder actually hits on their own --
// the client portal's own data load below, and the founder dashboard's
// single-client card load -- NOT from a loop over every client at once,
// so this never does more than one real Retell call per visit.
//
// Compares the client's own stored retellToolsVersion against
// lib/retellClient.js's PHONE_AGENT_TOOLS_VERSION (bumped there any time
// buildAgentPromptAndTools meaningfully changes, e.g. this round's
// reschedule_appointment / cancel_appointment addition) so it only ever
// does real work once per client per upgrade -- not on every single page
// load forever -- and stamps the client's record once the refresh
// succeeds so it won't be retried again until the next real upgrade.
// Exactly what turns "existing clients must remember to click Create
// phone agent again" into "it just happens the next time they open their
// portal."
function maybeRefreshPhoneAgentToolsInBackground(clientRecord, baseUrl) {
  if (!clientRecord || !clientRecord.retellAgentId || !clientRecord.retellLlmId) return;
  if ((clientRecord.retellToolsVersion || 0) >= PHONE_AGENT_TOOLS_VERSION) return;
  updatePhoneAgentTools({
    llmId: clientRecord.retellLlmId,
    companyName: clientRecord.intake?.companyName,
    script: clientRecord.script,
    toolsUrl: `${baseUrl}/api/retell/tools/${retellWebhookToken()}`,
    timeZone: clientRecord.intake?.timeZone,
    appointmentLengthMinutes: clientRecord.intake?.appointmentLengthMinutes,
  })
    .then(() => {
      db.updateClient(clientRecord.id, { retellToolsVersion: PHONE_AGENT_TOOLS_VERSION });
    })
    .catch((err) => {
      console.error(`Background phone-agent tools refresh failed for client ${clientRecord.id}:`, err.message || err);
    });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Added for the favicon and social-sharing preview image -- without the
  // right content-type here, browsers won't render an .svg favicon inline
  // and social platforms (Facebook/LinkedIn/WhatsApp/Twitter) can refuse an
  // og:image that isn't served as a real image type.
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

// Sends the founder a heads-up email whenever a new signup needs their
// manual review (or when an auto-approval couldn't fully complete, e.g.
// because Stripe isn't configured). Reuses FOLLOWUP_REPLY_TO -- the
// founder's own inbox, already set up for lead follow-up replies -- rather
// than asking for a second "founder email" setting. If it's not set, or the
// send fails for any reason, this quietly does nothing: the dashboard still
// shows the flagged client either way, so a missing notification never
// hides anything, it just means the founder has to notice it themselves.
async function notifyFounder({ companyName, reason }) {
  const founderEmail = process.env.FOLLOWUP_REPLY_TO;
  if (!founderEmail) return;
  try {
    await sendEmail({
      to: founderEmail,
      subject: `Dispatch AI -- "${companyName}" needs your review`,
      text: `A new signup needs a manual look before their AI agent's script can go out.\n\nBusiness: ${companyName}\nWhy: ${reason}\n\nCheck it in your dashboard: /dashboard`,
      fromName: 'Dispatch AI',
    });
  } catch (err) {
    // Never let a notification failure affect the signup itself.
  }
}

// Runs the same automatic "is this script safe to go out with no human
// check first" pass used for brand-new signups (see the onboarding route
// below) against any candidate script text. Factored out so a client's own
// self-service portal edits (see the client-portal script route further
// down) go through the identical safety net as a new draft, instead of a
// separate, looser check. Returns { checked: false } when Claude is in demo
// mode (no ANTHROPIC_API_KEY) -- there's no real AI opinion to trust yet, so
// callers decide their own safe-side fallback for that case.
async function checkScriptSafety(intake, scriptText) {
  try {
    const safetyPrompt = buildScriptSafetyCheckPrompt(intake, scriptText);
    const safetyResult = await callClaude({
      system: safetyPrompt.system,
      messages: safetyPrompt.messages,
      maxTokens: 300,
    });
    if (safetyResult.demoMode) return { checked: false };
    const safety = parseScriptSafetyCheck(safetyResult.text);
    return { checked: true, safe: safety.status === 'SAFE', reason: safety.reason };
  } catch (err) {
    return {
      checked: true,
      safe: false,
      reason: 'Something went wrong during the automatic check, so this needs a manual look.',
    };
  }
}

// Loads every website-widget/hosted-page conversation for a client, tagging
// (once one's gone quiet for a while) an outcome and drafting a follow-up
// for any newly-tagged unbooked lead we have an email for. Factored out of
// the founder's dashboard route so the client's own self-service portal
// (further down) sees identical, freshly-classified data through the exact
// same code path, rather than two slightly different implementations
// drifting apart over time.
async function getClassifiedConversations(clientRecord) {
  const conversations = db.listConversationsForClient(clientRecord.id);
  const IDLE_MS = 5 * 60 * 1000;
  const now = Date.now();

  for (const convo of conversations) {
    const isIdle = now - new Date(convo.updatedAt).getTime() > IDLE_MS;
    const hasExchange = convo.messages.length >= 2;

    if (convo.outcome === 'unclassified' && isIdle && hasExchange) {
      const { system, messages } = buildConversationInsightPrompt(clientRecord, convo.messages);
      const result = await callClaude({ system, messages, maxTokens: 300 });
      const insight = result.demoMode
        ? {
            outcome: 'unclear',
            contactName: null,
            contactEmail: null,
            contactPhone: null,
            summary: '(AI review needs a real ANTHROPIC_API_KEY -- this is a placeholder.)',
          }
        : parseConversationInsight(result.text);

      const updated = db.updateConversation(convo.id, { ...insight, classifiedAt: new Date().toISOString() });
      Object.assign(convo, updated);
    }

    if (convo.outcome === 'unbooked_lead' && convo.contactEmail && convo.followUpStatus === 'none') {
      const { system, messages } = buildFollowUpDraftPrompt(clientRecord, convo);
      const result = await callClaude({ system, messages, maxTokens: 300 });
      const draft = result.demoMode
        ? {
            subject: '(placeholder subject -- add a real ANTHROPIC_API_KEY)',
            body: '(AI follow-up drafting needs a real ANTHROPIC_API_KEY -- this is a placeholder.)',
          }
        : parseFollowUpDraft(result.text);

      const updated = db.updateConversation(convo.id, {
        followUpSubject: draft.subject,
        followUpBody: draft.body,
        followUpStatus: draft.body ? 'drafted' : 'none',
        followUpDraftedAt: new Date().toISOString(),
      });
      Object.assign(convo, updated);
    }
  }

  return conversations;
}

// A safe, client-facing projection of a client record -- used by every
// self-service portal route below. Deliberately NOT a spread of the raw
// record: fields like googleRefreshToken, stripeCustomerId, and the login
// tokens themselves are real credentials/internal identifiers that should
// never leave the server, even to the one client they belong to.
function clientPortalView(clientRecord) {
  return {
    id: clientRecord.id,
    status: clientRecord.status,
    plan: clientRecord.plan || null,
    companyName: clientRecord.intake?.companyName || '',
    contactEmail: clientRecord.intake?.contactEmail || '',
    script: clientRecord.script || '',
    pendingScriptEdit: clientRecord.pendingScriptEdit || null,
    reviewReason: clientRecord.pendingScriptEdit ? clientRecord.reviewReason : null,
    cancelledAt: clientRecord.cancelledAt || null,
    hasStripeCustomer: !!clientRecord.stripeCustomerId,
    retellAgentId: clientRecord.retellAgentId || null,
    retellPhoneNumber: clientRecord.retellPhoneNumber || null,
    googleCalendarConnectedAt: clientRecord.googleCalendarConnectedAt || null,
    googleCalendarEmail: clientRecord.googleCalendarEmail || null,
    googleCalendarNeedsReconnect: !!clientRecord.googleCalendarNeedsReconnect,
    usageMinutesThisPeriod: clientRecord.usageMinutesThisPeriod || 0,
    pastCustomerPortalToken: clientRecord.pastCustomerPortalToken || null,
    reviewLink: clientRecord.reviewLink || null,
    hostedPageEnabled: !!clientRecord.hostedPageEnabled,
    hostedPageSlug: clientRecord.hostedPageSlug || null,    hasServiceM8Key: !!clientRecord.serviceM8ApiKey,
  };
}

// --- Past-customer outreach (repeat/seasonal work) --------------------------
// Shared by both the founder's read-only dashboard view and the client's own
// portal (see public/customer-portal.html): finds past customers who are
// "due" for a reminder -- enough time has passed since their last service --
// and haven't been drafted yet, and drafts an outreach message for each.
// Computed on demand whenever either page is loaded, rather than on a
// background timer -- the same simplest-thing-that-works approach already
// used for classifying widget conversations.
const DEFAULT_REMIND_AFTER_MONTHS = 6;

function isPastCustomerDue(pc) {
  if (!pc.lastServiceDate) return false;
  const months = monthsSince(pc.lastServiceDate);
  if (months === null) return false;
  const threshold = Number(pc.remindAfterMonths) > 0 ? Number(pc.remindAfterMonths) : DEFAULT_REMIND_AFTER_MONTHS;
  return months >= threshold;
}

async function draftDueOutreach(clientRecord, pastCustomers) {
  for (const pc of pastCustomers) {
    if (pc.outreachStatus !== 'none') continue;
    if (!isPastCustomerDue(pc)) continue;

    // Can't email a reminder with nowhere to send it -- mark it clearly
    // rather than silently skipping forever, so it's visible on both the
    // client's portal and the founder's dashboard that this row needs an
    // email address added (via a fresh CSV upload) before it can go out.
    if (!pc.email) {
      const updated = db.updatePastCustomer(pc.id, { outreachStatus: 'no_email' });
      Object.assign(pc, updated);
      continue;
    }

    const { system, messages } = buildPastCustomerOutreachPrompt(clientRecord, pc);
    const result = await callClaude({ system, messages, maxTokens: 300 });
    if (result.demoMode) continue; // leave as 'none' -- no real ANTHROPIC_API_KEY to draft with yet

    const draft = parsePastCustomerOutreach(result.text);
    const updated = db.updatePastCustomer(pc.id, {
      outreachSubject: draft.subject,
      outreachBody: draft.body,
      outreachStatus: draft.body ? 'drafted' : 'none',
      outreachDraftedAt: new Date().toISOString(),
    });
    Object.assign(pc, updated);
  }
  return pastCustomers;
}

// --- Usage tracking & overage billing (minutes) ------------------------
// Makes the "N call & chat minutes / month" promise on the pricing page
// actually true, instead of just a number on a page nothing enforces. Two
// sources feed a client's usage for the current billing period: real phone
// call duration from Retell (via their webhook, below) and a fixed estimate
// per website-widget chat message -- chat doesn't have a natural "minute"
// the way a phone call does, so each visitor message simply counts as
// CHAT_MINUTES_PER_MESSAGE minutes. Simple and predictable, though it won't
// always match a chat's real wall-clock length exactly -- worth knowing.
//
// Crossing 80% of the plan's included minutes emails the client a heads-up
// (once per billing period). Crossing 100% emails a second notice explaining
// that extra minutes are now billed automatically, and every newly-crossed
// overage minute is added to the client's Stripe customer as a "pending"
// invoice item -- Stripe automatically attaches those to their NEXT
// scheduled invoice, so this needs no metered-billing product/price set up
// in the Stripe dashboard, and no new environment variables either. The AI
// agent itself is never blocked or slowed down by any of this -- going over
// a plan costs the client money, not their customer a missed call or a
// stalled chat, matching the fail-safe-toward-the-real-customer philosophy
// used everywhere else in this app.
//
// Usage resets to zero when Stripe's `invoice.paid` webhook event fires for
// a client's subscription (their billing period renewing -- see the webhook
// handler below). Only Starter and Growth have a defined minute allowance;
// a client with no recognized plan is silently skipped, which also covers
// Multi-Location, since that tier is custom-quoted rather than self-serve
// checkout and so never actually gets `client.plan` set to anything here.
const CHAT_MINUTES_PER_MESSAGE = 2;
const PLAN_MINUTES = { starter: 250, growth: 750 };
// Free-trial length offered on a client's first-ever checkout (see
// FREE_TRIAL_DAYS usage below) -- matches what OnCrew, Rosie, and Ringly
// all lead with. Only applied when a client has never had a paid
// subscription before (clientRecord.paidAt is unset), so a client who
// cancelled and comes back through the self-service portal doesn't get a
// second trial -- Stripe would otherwise happily grant one every time.
const FREE_TRIAL_DAYS = 14;
// Matches the Â£0.30-0.35/minute range already promised in the pricing
// page's footnote -- Growth gets the better per-minute rate, consistent
// with it already being the better per-minute deal on its base price too.
const PLAN_OVERAGE_RATE_GBP = { starter: 0.35, growth: 0.3 };
const USAGE_WARNING_THRESHOLD = 0.8;
// Disconnection reasons that mean the call genuinely never got through to
// a conversation with the AI -- Retell's documented "not connected" and
// "error" categories (see https://docs.retellai.com/reliability/debug-call-disconnect),
// as opposed to e.g. "user_hangup" or "agent_hangup", which mean a real
// conversation happened and just ended normally. Deliberately conservative:
// only these clearly-failed cases trigger the missed-call text-back below,
// so a customer never gets an unnecessary "sorry we missed you" text after
// a call that actually went fine.
const MISSED_CALL_DISCONNECT_REASONS = new Set([
  'dial_busy', 'dial_failed', 'dial_no_answer', 'invalid_destination',
  'telephony_provider_permission_denied', 'telephony_provider_unavailable',
  'sip_routing_error', 'marked_as_spam', 'network_blocked', 'user_declined',
  'concurrency_limit_reached', 'no_valid_payment', 'credit_exhausted',
  'budget_reached', 'scam_detected', 'error_llm_websocket_open',
  'error_llm_websocket_lost_connection', 'error_llm_websocket_runtime',
  'error_llm_websocket_corrupt_payload', 'error_no_audio_received',
  'error_asr', 'error_retell', 'error_unknown', 'error_user_not_joined',
  'registered_call_timeout',
]);


async function recordUsageMinutes(clientRecord, minutes) {
  const plan = clientRecord.plan;
  const includedMinutes = PLAN_MINUTES[plan];
  if (!includedMinutes || !minutes) return; // unrecognized/no plan, or nothing to add -- nothing to track

  try {
    if (!clientRecord.usagePeriodStart) {
      clientRecord = db.updateClient(clientRecord.id, {
        usagePeriodStart: clientRecord.paidAt || new Date().toISOString(),
      });
    }

    const newTotal = (clientRecord.usageMinutesThisPeriod || 0) + minutes;
    clientRecord = db.updateClient(clientRecord.id, { usageMinutesThisPeriod: newTotal });

    const companyName = clientRecord.intake?.companyName || 'your business';
    const planLabel = plan === 'growth' ? 'Growth' : 'Starter';
    const contactEmail = clientRecord.intake?.contactEmail;
    const rate = PLAN_OVERAGE_RATE_GBP[plan];

    // Heads-up at 80% -- sent at most once per billing period.
    if (newTotal >= includedMinutes * USAGE_WARNING_THRESHOLD && !clientRecord.usageWarnedAt && contactEmail) {
      const result = await sendEmail({
        to: contactEmail,
        subject: `${companyName} -- approaching your monthly minute limit`,
        text: `Hi,\n\nYour Dispatch AI ${planLabel} plan includes ${includedMinutes} call & chat minutes each month. You've used about ${newTotal} of those so far this billing period.\n\nIf you go over, extra minutes are billed automatically at Â£${rate.toFixed(2)}/minute (the same rate on our pricing page) -- no action needed from you, and your AI agent keeps answering calls and chats without any interruption either way.\n\nWant more minutes included instead? Just reply to this email any time to talk about moving to a higher plan.\n\n-- Dispatch AI`,
        fromName: 'Dispatch AI',
      });
      if (!result.demoMode) {
        clientRecord = db.updateClient(clientRecord.id, { usageWarnedAt: new Date().toISOString() });
      }
    }

    // Over the limit -- notify once, then bill every newly-crossed overage minute.
    if (newTotal > includedMinutes) {
      if (!clientRecord.usageOverageNotifiedAt && contactEmail) {
        const result = await sendEmail({
          to: contactEmail,
          subject: `${companyName} -- you've reached your monthly minute limit`,
          text: `Hi,\n\nYour Dispatch AI ${planLabel} plan's ${includedMinutes} monthly call & chat minutes have now been used for this billing period. Your AI agent keeps working exactly as before -- calls and chats are never interrupted -- but minutes beyond your plan are now billed automatically at Â£${rate.toFixed(2)}/minute, and will appear as a separate line item on your next invoice.\n\nWant more minutes included instead? Just reply to this email any time to talk about moving to a higher plan.\n\n-- Dispatch AI`,
          fromName: 'Dispatch AI',
        });
        if (!result.demoMode) {
          clientRecord = db.updateClient(clientRecord.id, { usageOverageNotifiedAt: new Date().toISOString() });
        }
      }

      const overageSoFar = newTotal - includedMinutes;
      const alreadyBilled = clientRecord.overageMinutesBilled || 0;
      const deltaMinutes = overageSoFar - alreadyBilled;

      if (deltaMinutes > 0 && clientRecord.stripeCustomerId) {
        const amountPence = Math.round(deltaMinutes * rate * 100);
        const result = await createInvoiceItem({
          customerId: clientRecord.stripeCustomerId,
          amountPence,
          currency: 'gbp',
          description: `${deltaMinutes} overage minute(s) beyond your ${planLabel} plan's ${includedMinutes}-minute monthly allowance`,
        });
        if (!result.demoMode) {
          db.updateClient(clientRecord.id, { overageMinutesBilled: overageSoFar });
        }
      }
    }
  } catch (err) {
    // Never let usage tracking, a warning email, or overage billing break
    // the actual call/chat a real customer is having -- same fail-safe
    // philosophy used everywhere else in this app.
    console.error(`Usage tracking failed for client ${clientRecord.id}:`, err);
  }
}

// --- Real-time calendar booking (Google Calendar) ---------------------------
// Lets a paying client's website widget check real availability and create a
// real appointment directly on that client's own calendar, instead of just
// collecting details for the founder or client to confirm later. Optional --
// everything here degrades gracefully to today's "collect details" behavior
// if GOOGLE_CLIENT_ID/SECRET aren't set, or a specific client hasn't
// connected their calendar yet.

// Returns a live Google access token for this client, refreshing it via
// their stored refresh token if the cached one is missing or about to
// expire, and persisting the refreshed token back to their record so the
// next request can reuse it without another round trip. Throws 'not_connected'
// if this client has never connected a calendar -- callers should treat that
// as a normal, expected case, not an error to log.
async function getGoogleAccessToken(clientRecord) {
  if (!clientRecord.googleRefreshToken) {
    throw new Error('not_connected');
  }
  const now = Date.now();
  if (
    clientRecord.googleAccessToken &&
    clientRecord.googleAccessTokenExpiresAt &&
    now < clientRecord.googleAccessTokenExpiresAt - 60000
  ) {
    return clientRecord.googleAccessToken;
  }
  const tokens = await googleCalendar.refreshAccessToken(clientRecord.googleRefreshToken);
  const updated = db.updateClient(clientRecord.id, {
    googleAccessToken: tokens.access_token,
    googleAccessTokenExpiresAt: now + (tokens.expires_in || 3600) * 1000,
    googleCalendarNeedsReconnect: false,
  });
  // Keep the in-memory record in sync too, since it's reused for the rest of
  // this same chat request (possibly across more than one tool call).
  Object.assign(clientRecord, updated);
  return tokens.access_token;
}

// Tool definitions handed to Claude on every widget-chat turn. Advertised
// unconditionally (even for clients who haven't connected a calendar yet) --
// executeBookingTool() below handles the "not connected" case by telling
// Claude to fall back to collecting details manually, which is exactly
// today's behavior, just reached through the tool instead of hardcoded.
const BOOKING_TOOLS = [
  {
    name: 'check_availability',
    description:
      "Check whether a specific date and time is actually free on the business's real calendar. ALWAYS call this before you offer or confirm any specific appointment time to the customer -- never guess or assume a time is open.",
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
    name: 'book_appointment',
    description:
      "Create a REAL appointment on the business's calendar. Only call this once the customer has agreed to a specific date and time you already confirmed was free with check_availability, and you have their name plus a phone number or email to reach them. Never tell a customer their appointment is booked unless this tool reports success.",
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
  },
];
BOOKING_TOOLS.push({
  name: 'flag_emergency',
  description:
    "Call this IMMEDIATELY the moment the visitor describes a genuine emergency as defined in this business's own approved script (e.g. a gas smell, a burst pipe or active flooding, no heat in freezing weather, exposed wiring) -- this alerts the business right away, it does not just save a note for later. Do not wait until the end of the conversation to call it.",
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
BOOKING_TOOLS.push({
  name: 'log_job_request',
  description:
    "Call this once -- and only once -- per customer, as soon as you know what job or service they want done AND have at least one way to reach them (a name plus a phone number or email). Call it even if you go on to book a specific appointment time with book_appointment right after -- this is what lets the business see every real job request, not just the ones that get booked on the spot. Don't call it again just because they mention more detail afterwards.",
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
BOOKING_TOOLS.push({
  name: 'reschedule_appointment',
  description:
    "Move an existing CONFIRMED appointment to a new date and time. Ask the customer for the phone number their original appointment was booked under so the right one can be found, and ALWAYS call check_availability on the new time before offering or confirming it. If no matching appointment is found, tell the customer you can't find a booking under that number -- don't guess, and don't book a brand-new appointment instead without saying so.",
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
BOOKING_TOOLS.push({
  name: 'cancel_appointment',
  description:
    "Cancel an existing CONFIRMED appointment. Ask the customer for the phone number their original appointment was booked under so the right one can be found, and confirm with them that they actually want to cancel before calling this -- it can't be undone from this conversation. If no matching appointment is found, tell the customer you can't find a booking under that number.",
  input_schema: {
    type: 'object',
    properties: {
      customerPhone: { type: 'string', description: 'The phone number the original appointment was booked under' },
    },
    required: ['customerPhone'],
  },
});

async function executeBookingTool(name, input, clientRecord, source = 'website chat widget') {
  const timeZone = clientRecord.intake?.timeZone || 'Europe/London';
  const durationMinutes =
    Number(input.durationMinutes) || Number(clientRecord.intake?.appointmentLengthMinutes) || 60;
  if (name === 'flag_emergency') {
    // Deliberately placed BEFORE the Google Calendar connection check below
    // -- flagging an emergency has nothing to do with calendar booking, and
    // must work for every client regardless of whether they've connected a
    // calendar yet. Tries to text the on-call number first (if the client
    // provided one and has a live Retell phone number to text from), falls
    // back to emailing the business's own contact address otherwise -- so
    // every client gets SOME real alert, never just a note nobody sees
    // until morning. Never throws: a live call or chat must never break
    // just because this alert failed to send.
    const companyName = clientRecord.intake?.companyName || 'the business';
    const emergencySummaryLines = [
      `Possible emergency reported via Dispatch AI (${source}).`,
      input.issueSummary ? `What they said: ${input.issueSummary}` : null,
      input.callerName ? `Name: ${input.callerName}` : null,
      input.callerPhone ? `Phone: ${input.callerPhone}` : null,
    ].filter(Boolean).join('\n');

    const onCallNumber = clientRecord.intake?.onCallNumber;
    if (onCallNumber && clientRecord.retellPhoneNumber) {
      try {
        const call = await placeEmergencyAlertCall(db, {
          fromNumber: clientRecord.retellPhoneNumber,
          toNumber: onCallNumber,
          companyName,
          issueSummary: input.issueSummary,
          callerName: input.callerName,
          callerPhone: input.callerPhone,
        });
        if (call) {
          return {
            alerted: true,
            note: "An automated call is going out to the on-call number right now to brief them on this. Tell the caller it's been flagged as urgent and someone will reach out right away.",
          };
        }
      } catch (err) {
        console.error(`Emergency alert call failed for client ${clientRecord.id}:`, err.message || err);
      }
    }
    if (onCallNumber && clientRecord.retellPhoneNumber) {
      try {
        await sendSms({ to: onCallNumber, from: clientRecord.retellPhoneNumber, text: emergencySummaryLines });
        return {
          alerted: true,
          note: 'The on-call number has just been texted about this. Tell the caller it has been flagged as urgent and someone will reach out right away.',
        };
      } catch (err) {
        console.error(`Emergency SMS alert failed for client ${clientRecord.id}:`, err.message || err);
      }
    }
    if (clientRecord.intake?.contactEmail) {
      try {
        await sendEmail({
          to: clientRecord.intake.contactEmail,
          subject: `Possible emergency reported -- ${companyName}`,
          text: emergencySummaryLines,
          fromName: 'Dispatch AI',
        });
        return {
          alerted: true,
          note: 'The business has just been emailed about this. Tell the caller it has been flagged as urgent and someone will follow up as soon as possible.',
        };
      } catch (err) {
        console.error(`Emergency email alert failed for client ${clientRecord.id}:`, err.message || err);
      }
    }
    return {
      alerted: false,
      note: "Couldn't reach the business automatically just now. Still treat this as urgent -- tell the caller a team member will follow up as soon as possible.",
    };
  }
  if (name === 'log_job_request') {
    // Deliberately placed BEFORE the Google Calendar connection check below,
    // for the same reason flag_emergency is -- taking down a job request
    // has nothing to do with calendar booking, and must work for every
    // client whether or not they've connected a calendar yet. Never throws:
    // a live call or chat must never break just because this failed to save.
    try {
      db.addJob({
        clientId: clientRecord.id,
        source,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        customerEmail: input.customerEmail,
        jobDescription: input.jobDescription,
        preferredTime: input.preferredTime,
      });
    } catch (err) {
      console.error(`Failed to save job request for client ${clientRecord.id}:`, err.message || err);
    }    pushJobToServiceM8IfConnected(clientRecord, {
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      customerEmail: input.customerEmail,
      jobDescription: input.jobDescription,
      preferredTime: input.preferredTime,
    });
    return { logged: true };
  }


  if (!googleCalendar.isConfigured() || !clientRecord.googleRefreshToken) {
    return {
      connected: false,
      note: "Live calendar booking isn't connected for this business yet. Collect the customer's preferred date/time and contact info, and tell them a team member will confirm it -- do not say the appointment is booked.",
    };
  }

  const getAccessToken = () => getGoogleAccessToken(clientRecord);

  try {
    if (name === 'check_availability') {
      const result = await googleCalendar.checkAvailability({
        getAccessToken,
        date: input.date,
        startTime: input.startTime,
        durationMinutes,
        timeZone,
      });
      return { connected: true, free: result.free };
    }

    if (name === 'book_appointment') {
      const companyName = clientRecord.intake?.companyName || 'the business';
      const summary = `${input.customerName || 'Customer'} -- ${input.issueDescription || 'Service call'}`;
      const description = [
        input.customerPhone ? `Phone: ${input.customerPhone}` : null,
        input.customerEmail ? `Email: ${input.customerEmail}` : null,
        input.issueDescription ? `Issue: ${input.issueDescription}` : null,
                `Booked automatically by ${companyName}'s Dispatch AI ${source}.`,
      ]
        .filter(Boolean)
        .join('\n');

      const result = await googleCalendar.createAppointment({
        getAccessToken,
        date: input.date,
        startTime: input.startTime,
        durationMinutes,
        timeZone,
        summary,
        description,
      });

      if (result.conflict) {
        return {
          connected: true,
          booked: false,
          conflict: true,
          note: 'That exact time was just taken by someone else. Offer the customer a different time and check it again before confirming.',
        };
      }

      // Save a real appointment record -- this is what lets the business
      // see their actual confirmed bookings in their own portal instead of
      // only on Google Calendar, and what lets a cancel/reschedule (from
      // the portal, the customer's own manage link, or the AI itself) find
      // the right one afterwards.
      const appointment = db.addAppointment({
        clientId: clientRecord.id,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        customerEmail: input.customerEmail,
        startAt: result.startRfc,
        endAt: result.endRfc,
        timeZone,
        description: input.issueDescription,
        calendarEventId: result.eventId,
        source,
      });

      // Best-effort confirmation to the CUSTOMER with their own manage link
      // (view/cancel/reschedule without calling back) -- never blocks or
      // fails the booking itself if sending this has a problem.
      try {
        const manageUrl = `${PUBLIC_BASE_URL}/manage-appointment.html?token=${appointment.manageToken}`;
        const whenLabel = formatApptForHuman(result.startRfc, timeZone);
        if (input.customerPhone && clientRecord.retellPhoneNumber) {
          await sendSms({
            to: input.customerPhone,
            from: clientRecord.retellPhoneNumber,
            text: `${companyName}: you're booked in for ${whenLabel}. Manage or change this booking: ${manageUrl}`,
          });
        } else if (input.customerEmail) {
          await sendEmail({
            to: input.customerEmail,
            subject: `${companyName} -- your appointment is booked`,
            text: `Hi ${input.customerName || ''},\n\nYou're booked in for ${whenLabel} with ${companyName}.\n\nNeed to cancel or change the time? Use this link:\n${manageUrl}\n\n-- ${companyName} (via Dispatch AI)`,
            fromName: companyName,
          });
        }
      } catch (err) {
        console.error(`Booking confirmation send failed for client ${clientRecord.id}:`, err.message || err);
      }

      return { connected: true, booked: true };
    }

    if (name === 'reschedule_appointment') {
      const appt = db.findUpcomingAppointmentByPhone(clientRecord.id, input.customerPhone);
      if (!appt) {
        return {
          connected: true,
          found: false,
          note: "No upcoming appointment was found under that phone number. Double-check the number with the customer, or offer to log a fresh job request with log_job_request instead.",
        };
      }

      const result = await googleCalendar.rescheduleAppointment({
        getAccessToken,
        eventId: appt.calendarEventId,
        date: input.newDate,
        startTime: input.newStartTime,
        durationMinutes,
        timeZone,
      });

      if (result.conflict) {
        return {
          connected: true,
          found: true,
          rescheduled: false,
          conflict: true,
          note: 'That new time was just taken by someone else. Offer the customer a different time and check it again before confirming.',
        };
      }

      const updatedAppt = db.updateAppointment(appt.id, { startAt: result.startRfc, endAt: result.endRfc });
      await notifyBusinessOwnerOfAppointmentChange(clientRecord, updatedAppt, 'rescheduled');
      return { connected: true, found: true, rescheduled: true };
    }

    if (name === 'cancel_appointment') {
      const appt = db.findUpcomingAppointmentByPhone(clientRecord.id, input.customerPhone);
      if (!appt) {
        return {
          connected: true,
          found: false,
          note: "No upcoming appointment was found under that phone number. Double-check the number with the customer.",
        };
      }

      await googleCalendar.cancelAppointment({ getAccessToken, eventId: appt.calendarEventId });
      const cancelledAppt = db.updateAppointment(appt.id, { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: 'ai' });
      await notifyBusinessOwnerOfAppointmentChange(clientRecord, cancelledAppt, 'cancelled');
      return { connected: true, found: true, cancelled: true };
    }

    return { error: true, note: 'Unknown tool.' };
  } catch (err) {
    if (err.message === 'not_connected') {
      return {
        connected: false,
        note: "Live calendar booking isn't connected for this business yet. Collect the customer's preferred date/time and contact info, and tell them a team member will confirm it.",
      };
    }
    // Covers an expired/revoked refresh token, a Google outage, or anything
    // else going wrong -- fails safe back to "collect details manually"
    // rather than ever breaking the chat or claiming a false booking. Also
    // flags the client's card in the dashboard so the founder notices a
    // reconnect is needed, rather than this failing silently forever.
    console.error(`Google Calendar tool "${name}" failed for client ${clientRecord.id}:`, err);
    db.updateClient(clientRecord.id, { googleCalendarNeedsReconnect: true });
    return {
      connected: true,
      error: true,
      note: "Something went wrong reaching the calendar just now. Collect the customer's preferred date/time and contact info, and tell them a team member will confirm it shortly.",
    };
  }
}

const MAX_BOOKING_TOOL_ITERATIONS = 6;

// Runs the widget-chat conversation through Claude, letting it call the
// booking tools as many times as it needs (checking a couple of times,
// finding one busy, checking another) before producing its final reply to
// the visitor. All of this tool back-and-forth happens inside this one
// function call -- the browser only ever sees the final text, and the
// stored conversation transcript is unaffected, so nothing else in this app
// needs to know tools exist.
async function runWidgetChat({ system, messages, clientRecord }) {
  let anthropicMessages = [...messages];

  for (let i = 0; i < MAX_BOOKING_TOOL_ITERATIONS; i++) {
    const result = await callClaude({ system, messages: anthropicMessages, tools: BOOKING_TOOLS });

    if (result.demoMode || result.stopReason !== 'tool_use') {
      return result;
    }

    const toolUseBlocks = (result.content || []).filter((block) => block.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      return result;
    }

    // Anthropic requires the assistant's own tool_use content echoed back
    // before the matching tool_result turn.
    anthropicMessages.push({ role: 'assistant', content: result.content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      const output = await executeBookingTool(block.name, block.input || {}, clientRecord);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(output) });
    }
    anthropicMessages.push({ role: 'user', content: toolResults });
  }

  // Ran out of iterations without a final answer -- extremely unlikely, but
  // fail safe with a plain message rather than leaving the visitor hanging.
  return {
    text: "Let me have a team member follow up with you directly to lock in the details.",
    demoMode: false,
  };
}

// A tiny, self-contained HTML page for the couple of spots (the Google OAuth
// callback, mainly) that are reached by a real browser navigation rather
// than a fetch call, so a plain message and a link back is more useful than
// a JSON error would be.
function simpleHtmlPage(title, message, backHref, linkLabel = 'Back to dashboard') {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} â Dispatch AI</title>
<link rel="stylesheet" href="/styles.css"></head>
<body><div class="wrap"><section style="padding:60px 0; max-width:520px; margin:0 auto; text-align:center;">
<h1 style="font-size:24px;">${title}</h1>
<p style="color:#4b5563; font-size:15px;">${message}</p>
<a class="btn btn-primary" href="${backHref}" style="display:inline-block; margin-top:16px;">${linkLabel}</a>
</section></div></body></html>`;
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A login link is single-use and expires quickly on purpose -- long enough
// for someone to open their email and click it, short enough that a stale,
// unused link in an old email isn't a standing risk.
const CLIENT_LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

// --- Hosted website add-on --------------------------------------------------
// A simple, public one-page site for any paid client who's turned this on
// (see hostedPageEnabled) -- for a client with no website of their own, or
// whose existing site won't allow adding the chat widget. Server-rendered
// per request rather than a static file, since the content is specific to
// one client, at /site/<their slug> on this app's own domain. Its embedded
// chat talks to the exact same /api/widget-chat route (and so the exact
// same usage tracking, conversation storage, and real-time calendar
// booking) as the embeddable widget.js clients paste into their own sites --
// the only difference is where the chat lives, tagged with
// source:'hosted-page' so it's distinguishable in their conversation list.
function renderHostedSitePage(clientRecord) {
  const intake = clientRecord.intake || {};
  const companyName = escapeHtml(intake.companyName || 'Our business');
  const tagline = [intake.trades, intake.serviceArea].filter(Boolean).map(escapeHtml).join(' Â· ');
  const hours = intake.hours ? escapeHtml(intake.hours) : null;
  const phone = clientRecord.retellPhoneNumber ? escapeHtml(clientRecord.retellPhoneNumber) : null;
  const clientIdJson = JSON.stringify(clientRecord.id);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${companyName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<div class="wrap">
  <header>
    <span class="logo">${companyName}</span>
  </header>

  <section class="hero" style="grid-template-columns: 1fr; max-width: 640px; margin: 0 auto; text-align: center; padding-bottom: 8px;">
    <div>
      ${tagline ? `<div class="eyebrow">${tagline}</div>` : ''}
      <h1 style="font-size:34px;">Talk to us any time -- <span class="accent">our AI answers instantly</span></h1>
      <p class="sub" style="margin-left:auto; margin-right:auto;">Ask a question, get a quote, or book an appointment right here. A real person follows up if you ever need one.</p>
      ${hours || phone ? `<div class="stat-strip" style="justify-content:center; border-top:none; padding-top:0; margin-top:8px;">
        ${hours ? `<div class="stat"><span style="display:block; font-size:12.5px; color:var(--ink-faint);">Hours</span><b style="font-size:15px;">${hours}</b></div>` : ''}
        ${phone ? `<div class="stat"><span style="display:block; font-size:12.5px; color:var(--ink-faint);">Call us</span><b style="font-size:15px;">${phone}</b></div>` : ''}
      </div>` : ''}
    </div>
  </section>

  <section style="max-width: 560px; margin: 0 auto; padding-bottom: 60px;">
    <div class="chat-card" id="demo">
      <div class="badge"><span class="dot"></span> AI assistant -- usually replies in seconds</div>
      <div id="chatLog">
        <div class="msg ai"><div class="bubble">Hi! How can I help today?</div></div>
      </div>
      <div class="chat-input-row">
        <input id="chatInput" type="text" placeholder="Type a message..." />
        <button class="btn btn-primary" id="sendBtn">Send</button>
      </div>
      <div class="demo-mode-banner" id="demoModeBanner"></div>
    </div>
  </section>

  <footer>Powered by Dispatch AI</footer>
</div>

<script>
const clientId = ${clientIdJson};
const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const demoModeBanner = document.getElementById('demoModeBanner');
let history = [{ role: 'assistant', content: 'Hi! How can I help today?' }];
let conversationId = null;

function addBubble(role, text) {
  const msg = document.createElement('div');
  msg.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  msg.appendChild(bubble);
  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  addBubble('user', text);
  history.push({ role: 'user', content: text });
  addBubble('ai', '...');
  const placeholder = chatLog.lastElementChild;

  try {
    const res = await fetch('/api/widget-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: clientId, messages: history, conversationId: conversationId, source: 'hosted-page' })
    });
    const data = await res.json();
    placeholder.remove();
    addBubble('ai', data.text || 'Sorry, something went wrong.');
    history.push({ role: 'assistant', content: data.text || '' });
    if (data.conversationId) conversationId = data.conversationId;
    if (data.demoMode) {
      demoModeBanner.style.display = 'block';
      demoModeBanner.textContent = 'Demo mode -- this business has not connected a real AI key yet, so replies are placeholders.';
    }
  } catch (err) {
    placeholder.remove();
    addBubble('ai', 'Sorry, something went wrong reaching the AI.');
  }
}

sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendMessage(); });
</script>
</body>
</html>`;
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

// The widget-chat endpoint is called from a PAYING CLIENT'S OWN website --
// some domain that isn't yours -- so, unlike every other route here, it
// needs to explicitly allow cross-origin requests.
const WIDGET_CORS_HEADERS = { 'access-control-allow-origin': '*' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', (chunk) => {
      chunks += chunk;
      if (chunks.length > 2_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!chunks) return resolve({});
      try {
        resolve(JSON.parse(chunks));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Reads the raw, unparsed request body as a Buffer. Needed for the Stripe
// webhook route specifically -- signature verification requires the exact
// raw bytes Stripe sent, before any JSON parsing happens.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// --- Dashboard authentication (HTTP Basic Auth) ---------------------------
// Protects the dashboard page and every /api/clients* endpoint (viewing,
// editing, approving, and generating payment links -- all admin actions).
// /api/chat, /api/onboard, and /api/stripe/webhook stay public since
// prospects, new clients, and Stripe's own servers need to reach them
// without a login.
//
// If DASHBOARD_PASSWORD isn't set, a clearly-insecure default is used so
// the dashboard is still protected out of the box rather than wide open --
// but the console logs a loud warning until a real password is set in
// Render's environment variables.
function isProtectedPath(pathname) {
  return pathname === '/dashboard' || pathname.startsWith('/api/clients');
}

function checkDashboardAuth(req) {
  const expectedUser = process.env.DASHBOARD_USERNAME || 'admin';
  const expectedPass = process.env.DASHBOARD_PASSWORD || 'changeme-now';

  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Basic ')) return false;

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch (err) {
    return false;
  }
  const sepIdx = decoded.indexOf(':');
  if (sepIdx === -1) return false;
  const user = decoded.slice(0, sepIdx);
  const pass = decoded.slice(sepIdx + 1);

  const userBuf = Buffer.from(user);
  const expectedUserBuf = Buffer.from(expectedUser);
  const passBuf = Buffer.from(pass);
  const expectedPassBuf = Buffer.from(expectedPass);

  const userMatches =
    userBuf.length === expectedUserBuf.length && crypto.timingSafeEqual(userBuf, expectedUserBuf);
  const passMatches =
    passBuf.length === expectedPassBuf.length && crypto.timingSafeEqual(passBuf, expectedPassBuf);

  return userMatches && passMatches;
}

function sendAuthChallenge(res) {
  res.writeHead(401, {
    'content-type': 'text/plain',
    'www-authenticate': 'Basic realm="Dispatch AI Dashboard"',
  });
  res.end('Authentication required.');
}
function serveStaticFile(req, res, urlPath) {
  // Map "/" -> index.html, "/onboard" -> onboard.html, "/dashboard" -> dashboard.html
  const routeMap = {
    '/': 'index.html',
    '/onboard': 'onboard.html',
    '/dashboard': 'dashboard.html',
    '/success': 'success.html',
    '/client-login': 'client-login.html',
    '/plumbers': 'plumbers.html',
    '/electricians': 'electricians.html',
  };
  const relativePath = routeMap[urlPath] || urlPath.replace(/^\//, '');

  const filePath = path.join(PUBLIC_DIR, relativePath);

  // Prevent path traversal outside the public directory.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'content-type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    // --- Dashboard auth gate --------------------------------------------
    if (isProtectedPath(pathname) && !checkDashboardAuth(req)) {
      return sendAuthChallenge(res);
    }

    // --- Stripe webhook (must read the RAW body, before any JSON parsing) --
    if (pathname === '/api/stripe/webhook' && req.method === 'POST') {
      const rawBody = await readRawBody(req);
      const signatureHeader = req.headers['stripe-signature'];
      const verification = verifyStripeSignature(
        rawBody.toString('utf8'),
        signatureHeader,
        process.env.STRIPE_WEBHOOK_SECRET
      );

      if (!verification.valid) {
        console.error('Stripe webhook rejected:', verification.reason);
        return sendJson(res, 400, { error: `Invalid webhook: ${verification.reason}` });
      }

      let event;
      try {
        event = JSON.parse(rawBody.toString('utf8'));
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON payload' });
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const clientId = session.client_reference_id;
        if (clientId && db.getClient(clientId)) {
          const clientRecord = db.getClient(clientId);
          db.updateClient(clientId, {
            status: 'paid',
            plan: clientRecord.pendingPlan || null,
            paidAt: new Date().toISOString(),
            stripeSubscriptionId: session.subscription || null,
            stripeCustomerId: session.customer || null,
          });
          console.log(`Client ${clientId} marked as paid via Stripe webhook.`);
        } else {
          console.warn('Stripe webhook: checkout.session.completed with unknown client_reference_id', clientId);
        }
      }

      // Fires the moment Stripe actually ends a subscription -- whether
      // that's an immediate cancellation or the end of a paid period,
      // depending on how cancellation was triggered. This is the signal
      // that a client should lose access.
      if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const clientRecord = db.getClientBySubscriptionId(subscription.id);
        if (clientRecord) {
          db.updateClient(clientRecord.id, {
            status: 'cancelled',
            cancelledAt: new Date().toISOString(),
          });
          console.log(`Client ${clientRecord.id} marked as cancelled via Stripe webhook.`);
        } else {
          console.warn('Stripe webhook: customer.subscription.deleted for unknown subscription', subscription.id);
        }
      }

      // Fires at the start of every billing cycle when Stripe generates that
      // period's invoice -- the signal a client's minute allowance has
      // renewed, so their usage tracking (see the section above) starts
      // fresh instead of carrying last period's minutes forward forever.
      if (event.type === 'invoice.paid') {
        const invoice = event.data.object;
        const clientRecord = invoice.subscription ? db.getClientBySubscriptionId(invoice.subscription) : null;
        if (clientRecord) {
          db.updateClient(clientRecord.id, {
            usageMinutesThisPeriod: 0,
            usagePeriodStart: new Date().toISOString(),
            usageWarnedAt: null,
            usageOverageNotifiedAt: null,
            overageMinutesBilled: null,
          });
          console.log(`Client ${clientRecord.id} usage reset for new billing period via Stripe webhook.`);
        }
      }

      return sendJson(res, 200, { received: true });
    }

    // --- Internal: autonomous email-marketing agent trigger ---------------
    // Fired once a day by a scheduled task that hits this app's own live
    // URL -- not by anything running inside this process -- so it keeps
    // working through Render restarts/redeploys/free-tier spin-downs
    // instead of relying on an in-process timer that would silently stop.
    // Deliberately NOT behind isProtectedPath's dashboard Basic Auth (no
    // human is there every day to type a password); it has its own check
    // instead, and that check fails CLOSED -- with no AGENT_RUN_SECRET set
    // at all, every request is rejected rather than let through on a
    // missing or guessable secret.
    if (pathname === '/api/internal/agents/email-marketing/run' && req.method === 'POST') {
      if (!checkAgentRunSecret(req)) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        return res.end('Unauthorized');
      }
      const summary = await runEmailMarketingAgent();
      return sendJson(res, 200, summary);
    }

    // --- Embeddable website chat widget (runs on a client's OWN site) -----
    // Browsers send a preflight OPTIONS request before a cross-origin POST
    // with a JSON content-type -- this has to succeed with the right CORS
    // headers or the real request never gets sent.
    if (pathname === '/api/widget-chat' && req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...WIDGET_CORS_HEADERS,
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return res.end();
    }

    if (pathname === '/api/widget-chat' && req.method === 'POST') {
      const { clientId, messages, conversationId, source } = await readBody(req);
      if (!clientId || !Array.isArray(messages) || messages.length === 0) {
        return sendJson(res, 400, { error: 'clientId and messages are required' }, WIDGET_CORS_HEADERS);
      }

      const clientRecord = db.getClient(clientId);
      // Gated on status === 'paid' specifically -- this is what makes
      // cancelling a subscription actually turn the widget off, consistent
      // with how the rest of billing access works in this app.
      if (!clientRecord || clientRecord.status !== 'paid') {
        return sendJson(res, 200, {
          text: "Sorry, chat isn't available right now -- please call or check back later.",
          unavailable: true,
        }, WIDGET_CORS_HEADERS);
      }

      const system = buildWidgetChatSystemPrompt(clientRecord);
      const result = await runWidgetChat({ system, messages, clientRecord });

      // Counts toward this client's monthly minutes, same as a real phone
      // call's duration does -- skipped in demo mode (no ANTHROPIC_API_KEY
      // yet) so a business isn't billed for interactions that aren't really
      // using the AI at all.
      if (!result.demoMode) {
        await recordUsageMinutes(clientRecord, CHAT_MINUTES_PER_MESSAGE);
      }

      // Remember this conversation so the business owner can see it in their
      // dashboard, even after the visitor closes the tab -- the foundation
      // for eventually following up with visitors who don't book.
      const fullTranscript = [...messages, { role: 'assistant', content: result.text }];
      const convo = db.appendConversationTurn({
        conversationId,
        clientId,
        // 'hosted-page' when this came from a client's Dispatch-AI-hosted
        // site (see /site/:slug below) instead of a widget embedded on
        // their own site, so it's distinguishable in their conversation
        // list even though both paths otherwise behave identically.
        source: source === 'hosted-page' ? 'hosted-page' : 'website-widget',
        messages: fullTranscript,
      });

      return sendJson(res, 200, { ...result, conversationId: convo.id }, WIDGET_CORS_HEADERS);
    }

      // --- Landing page demo chat widget -----------------------------------
    // Defaults to the fixed fictional persona (DEMO_SYSTEM_PROMPT), but a
    // visitor can personalize the demo with their own company name (and
    // optionally trade) via the "Try it as my business" box on the landing
    // page -- see buildPersonalizedDemoPrompt for how that stays honest
    // about not knowing this business's real details yet.
    if (pathname === '/api/chat' && req.method === 'POST') {
      const { messages, companyName, trade } = await readBody(req);
      if (!Array.isArray(messages) || messages.length === 0) {
        return sendJson(res, 400, { error: 'messages array is required' });
      }
      const system =
        companyName && companyName.trim()
          ? buildPersonalizedDemoPrompt(companyName.trim(), trade ? trade.trim() : '')
          : DEMO_SYSTEM_PROMPT;
      const result = await callClaude({ system, messages });
      return sendJson(res, 200, result);
    }

    // --- Live voice demo: browser "talk to it live" button on the landing --
    // page. Creates ONE persistent Retell agent for the same fixed demo
    // persona as the text-chat demo above (DEMO_SYSTEM_PROMPT -- "Summit Air
    // & Plumbing"), the very first time anyone tries the voice demo, then
    // reuses that same agent forever -- cached via db.getDemoAgent /
    // db.saveDemoAgent, same simple-JSON-file pattern as everything else in
    // this app. No booking tools or webhook are attached (there's no real
    // business or calendar behind this demo), and no phone number is bought
    // -- the browser talks to this agent entirely over WebRTC using Retell's
    // public-key web-call flow (see public/index.html), so this route only
    // ever hands back an agent_id and the public key, never a secret.
    //
    // Requires a RETELL_PUBLIC_KEY environment variable (created in Retell's
    // dashboard under API Keys -> Public Keys, restricted to this site's own
    // domain -- see LAUNCH_CHECKLIST.md). Until that's set, this returns
    // { demoMode: true } and the landing page shows the text-chat demo only.
    if (pathname === '/api/demo/voice-agent' && req.method === 'POST') {
      const publicKey = process.env.RETELL_PUBLIC_KEY;
      if (!publicKey) {
        return sendJson(res, 200, { demoMode: true });
      }

      const cached = db.getDemoAgent();
      if (cached && cached.agentId) {
        return sendJson(res, 200, { agentId: cached.agentId, publicKey });
      }

      const created = await createPhoneAgent({
        companyName: 'Dispatch AI (live voice demo)',
        script: DEMO_SYSTEM_PROMPT,
      });

      if (created.demoMode) {
        return sendJson(res, 200, { demoMode: true });
      }

      db.saveDemoAgent({
        llmId: created.llmId,
        agentId: created.agentId,
        createdAt: new Date().toISOString(),
      });
      return sendJson(res, 200, { agentId: created.agentId, publicKey });
    }

    // --- Help chat widget on the intake form (/onboard) -------------------
    // Separate from /api/chat (the landing-page demo, which role-plays as a
    // fictional client's AI receptionist) -- this one answers questions
    // about the form, pricing, and billing for the person signing up.
    if (pathname === '/api/help-chat' && req.method === 'POST') {
      const { messages } = await readBody(req);
      if (!Array.isArray(messages) || messages.length === 0) {
        return sendJson(res, 400, { error: 'messages array is required' });
      }
      const result = await callClaude({ system: HELP_CHAT_SYSTEM_PROMPT, messages });
      return sendJson(res, 200, result);
    }

    // --- Client onboarding / intake form -----------------------------------
    if (pathname === '/api/onboard' && req.method === 'POST') {
      const intake = await readBody(req);
      if (!intake.companyName) {
        return sendJson(res, 400, { error: 'companyName is required' });
      }
      if (!intake.contactEmail) {
        return sendJson(res, 400, { error: 'contactEmail is required' });
      }

      const id = crypto.randomUUID();
      const client = {
        id,
        status: 'generating',
        createdAt: new Date().toISOString(),
        intake,
        script: null,
        demoMode: false,
      };
      db.addClient(client);

      const { system, messages } = buildScriptGenerationPrompt(intake);
      const result = await callClaude({ system, messages, maxTokens: 1200 });

      let updated = db.updateClient(id, {
        status: 'draft',
        script: result.text,
        demoMode: result.demoMode,
      });

      // --- Automatic review ---------------------------------------------
      // A second, independent AI pass reads the draft script back against
      // the intake answers, looking specifically for the kinds of mistakes
      // a human reviewer would have caught (missing pricing, contradictions,
      // leftover placeholder text, wrong tone, a missing AI-disclosure
      // greeting). If it's confident nothing is wrong, the client is
      // auto-approved and sent a real payment link immediately by email --
      // no waiting on the founder. If it's not confident, or anything at
      // all goes wrong in this block, this fails SAFE-side: the client
      // stays in manual "draft" review exactly like before this feature
      // existed, and the founder gets emailed so nothing sits unnoticed.
      //
      // This whole step is skipped in demo mode (no ANTHROPIC_API_KEY) --
      // there's no real script yet to check, so it falls back to the
      // original fully-manual flow untouched.
      if (!result.demoMode) {
        const check = await checkScriptSafety(intake, result.text);

        if (check.checked && check.safe) {
          updated = db.updateClient(id, {
            status: 'approved',
            approvedAt: new Date().toISOString(),
            reviewMode: 'auto',
            reviewReason: null,
          });

          const baseUrl = `${url.protocol}//${url.host}`;
          const checkout = await createCheckoutSession({
            clientId: id,
            priceId: process.env.STRIPE_PRICE_ID_STARTER,
            companyName: intake.companyName,
            trialDays: FREE_TRIAL_DAYS, // brand-new signup -- always their first checkout
            successUrl: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,

            cancelUrl: `${baseUrl}/?checkout=cancelled`,
          });

          if (!checkout.demoMode) {
            db.updateClient(id, { pendingPlan: 'starter' });
            const emailResult = await sendEmail({
              to: intake.contactEmail,
              subject: `${intake.companyName} -- your AI agent is ready to go live`,
              text: `Hi,\n\nThanks for signing up for Dispatch AI. Your AI agent's script has been reviewed and it's ready to go.\n\nComplete your subscription here to go live:\n${checkout.url}\n\nOnce you're live, you'll be able to review and tweak the script again any time.\n\n-- Dispatch AI`,
              fromName: 'Dispatch AI',
            });
            updated = db.updateClient(id, {
              customerEmailSentAt: emailResult.demoMode ? null : new Date().toISOString(),
              customerEmailDemoMode: !!emailResult.demoMode,
            });
          } else {
            // Safe to auto-approve, but there's no real payment link to
            // send (Stripe isn't fully configured yet) -- don't email a
            // customer a broken link, tell the founder instead.
            await notifyFounder({
              companyName: intake.companyName,
              reason: `Auto-approved, but couldn't generate a real payment link yet (${checkout.message}). Send one manually from the dashboard once Stripe is configured.`,
            });
          }
        } else if (check.checked) {
          updated = db.updateClient(id, {
            reviewMode: 'manual',
            reviewReason:
              check.reason || "The automatic check couldn't confirm this script was safe to send without a look first.",
          });
          await notifyFounder({ companyName: intake.companyName, reason: updated.reviewReason });
        }
        // check.checked === false means Claude is in demo mode -- nothing
        // to compare against yet, so this stays in the default manual
        // "draft" review set a few lines up, exactly like before this
        // feature existed.
      }

      return sendJson(res, 200, updated);
    }

    // --- Past-customer portal (client-facing, no dashboard login) -----------
    // Reached via a long, unguessable token instead of a password -- the
    // same security model already used for the Stripe customer portal /
    // success page (a long token stands in for a login). Deliberately public
    // (not under isProtectedPath) so a client can use it without ever
    // knowing your dashboard password.
    const portalUploadMatch = pathname.match(/^\/api\/customer-portal\/([^/]+)\/upload$/);
    if (portalUploadMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPastCustomerPortalToken(portalUploadMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });

      const { csvText } = await readBody(req);
      if (!csvText || !csvText.trim()) {
        return sendJson(res, 400, { error: 'No CSV content received.' });
      }

      const rows = parseCsv(csvText);
      const validRows = rows.filter((r) => r.name && r.name.trim());
      const skipped = rows.length - validRows.length;

      if (validRows.length === 0) {
        return sendJson(res, 400, { error: 'No valid rows found -- make sure there is a "name" column with a value in every row.' });
      }

      const created = db.addPastCustomers(clientRecord.id, validRows);
      return sendJson(res, 200, { added: created.length, skipped });
    }

    // Lists this client's past customers, drafting a reminder for anyone
    // newly "due" along the way (see draftDueOutreach above).
    const portalCustomersMatch = pathname.match(/^\/api\/customer-portal\/([^/]+)\/customers$/);
    if (portalCustomersMatch && req.method === 'GET') {
      const clientRecord = db.getClientByPastCustomerPortalToken(portalCustomersMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });

      let pastCustomers = db.listPastCustomersForClient(clientRecord.id);
      pastCustomers = await draftDueOutreach(clientRecord, pastCustomers);
      return sendJson(res, 200, { companyName: clientRecord.intake?.companyName || '', pastCustomers });
    }

    // Lets the client edit an AI-drafted outreach message before it's ever
    // used -- same "review before it goes out" pattern used everywhere else
    // in this app.
    const portalOutreachEditMatch = pathname.match(/^\/api\/customer-portal\/([^/]+)\/customers\/([^/]+)\/outreach$/);
    if (portalOutreachEditMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPastCustomerPortalToken(portalOutreachEditMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      const pc = db.getPastCustomer(portalOutreachEditMatch[2]);
      if (!pc || pc.clientId !== clientRecord.id) return sendJson(res, 404, { error: 'not found' });

      const { subject, body } = await readBody(req);
      const updated = db.updatePastCustomer(pc.id, { outreachSubject: subject, outreachBody: body });
      return sendJson(res, 200, updated);
    }

    const portalOutreachApproveMatch = pathname.match(/^\/api\/customer-portal\/([^/]+)\/customers\/([^/]+)\/outreach\/approve$/);
    if (portalOutreachApproveMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPastCustomerPortalToken(portalOutreachApproveMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      const pc = db.getPastCustomer(portalOutreachApproveMatch[2]);
      if (!pc || pc.clientId !== clientRecord.id) return sendJson(res, 404, { error: 'not found' });

      const updated = db.updatePastCustomer(pc.id, {
        outreachStatus: 'approved',
        outreachApprovedAt: new Date().toISOString(),
      });
      return sendJson(res, 200, updated);
    // Lets the client manually ask for a review for one specific past
    // customer (unlike the time-based "next service" reminder above, this
    // is always client-initiated -- there's no "due date" for asking for a
    // review, just "the job's done, ask now"). Writes into the exact same
    // outreachSubject/outreachBody/outreachStatus fields as the reminder
    // above so the existing edit/approve/send UI and routes work unchanged
    // for this too -- it's just a different kind of message going into the
    // same slot. Works even without an email on file, since the send route
    // (see outreach/send below) already falls back to a text message via
    // pc.phone when there's no email.
    const portalReviewRequestDraftMatch = pathname.match(/^\/api\/customer-portal\/([^/]+)\/customers\/([^/]+)\/review-request\/draft$/);
    if (portalReviewRequestDraftMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPastCustomerPortalToken(portalReviewRequestDraftMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      const pc = db.getPastCustomer(portalReviewRequestDraftMatch[2]);
      if (!pc || pc.clientId !== clientRecord.id) return sendJson(res, 404, { error: 'not found' });

      const { system, messages } = buildReviewRequestPrompt(clientRecord, pc);
      const result = await callClaude({ system, messages, maxTokens: 300 });
      if (result.demoMode) {
        return sendJson(res, 200, result);
      }

      const draft = parsePastCustomerOutreach(result.text);
      const updated = db.updatePastCustomer(pc.id, {
        outreachSubject: draft.subject,
        outreachBody: draft.body,
        outreachStatus: draft.body ? 'drafted' : 'none',
        outreachDraftedAt: new Date().toISOString(),
      });
      return sendJson(res, 200, { pastCustomer: updated });
    }

    }

    // Actually sends the approved reminder, via the same Resend integration
    // used for lead follow-ups. Deliberately a separate click from Approve.
    const portalOutreachSendMatch = pathname.match(/^\/api\/customer-portal\/([^/]+)\/customers\/([^/]+)\/outreach\/send$/);
    if (portalOutreachSendMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPastCustomerPortalToken(portalOutreachSendMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      const pc = db.getPastCustomer(portalOutreachSendMatch[2]);
      if (!pc || pc.clientId !== clientRecord.id) return sendJson(res, 404, { error: 'not found' });

      if (pc.outreachStatus !== 'approved') {
        return sendJson(res, 400, { error: 'Approve the draft before sending it.' });
      }
      if (!pc.email && pc.phone && clientRecord.retellPhoneNumber) {
        const smsResult = await sendSms({
          to: pc.phone,
          from: clientRecord.retellPhoneNumber,
          text: pc.outreachBody || '',
        });
        if (smsResult.demoMode || !smsResult.success) {
          return sendJson(res, 200, smsResult);
        }
        const updatedBySms = db.updatePastCustomer(pc.id, {
          outreachStatus: 'sent',
          outreachSentAt: new Date().toISOString(),
        });
        return sendJson(res, 200, { ...smsResult, pastCustomer: updatedBySms });
      }
      if (!pc.email) {
        return sendJson(res, 400, { error: 'No email address on file for this customer.' });
      }

      const companyName = clientRecord.intake?.companyName || 'the business';
      const result = await sendEmail({
        to: pc.email,
        subject: pc.outreachSubject || 'Checking in',
        text: pc.outreachBody || '',
        fromName: companyName,
      });

      if (result.demoMode) {
        return sendJson(res, 200, result);
      }

      const updated = db.updatePastCustomer(pc.id, {
        outreachStatus: 'sent',
        outreachSentAt: new Date().toISOString(),
      });
      return sendJson(res, 200, { ...result, pastCustomer: updated });
    }

    // --- Client self-service portal (magic-link login) -----------------------
    // Lets a paying (or previously-paying) client manage their own account --
    // script, billing, phone agent, conversations, calendar, usage, and the
    // hosted-website add-on -- without waiting on the founder. No passwords:
    // a client requests a login by email and gets a one-click link. All the
    // routes below are deliberately public (not under isProtectedPath),
    // reached instead by a long, unguessable clientPortalToken -- the same
    // security model already used for the past-customer portal, just handed
    // out through an emailed magic link the first time instead of a link the
    // founder generates and sends by hand.

    if (pathname === '/api/client-portal/request-login' && req.method === 'POST') {
      const { email } = await readBody(req);
      const clientRecord = email ? db.getClientByContactEmail(email) : null;

      // Deliberately the same response whether or not the email matches a
      // real client, so this can't be used to check which businesses are
      // (or aren't) Dispatch AI clients just by trying emails against it.
      if (!clientRecord) {
        return sendJson(res, 200, { sent: true });
      }

      const loginToken = crypto.randomBytes(24).toString('hex');
      db.updateClient(clientRecord.id, {
        clientLoginToken: loginToken,
        clientLoginTokenExpiresAt: Date.now() + CLIENT_LOGIN_TOKEN_TTL_MS,
      });

      const baseUrl = `${url.protocol}//${url.host}`;
      const loginUrl = `${baseUrl}/api/client-portal/verify?token=${loginToken}`;
      const result = await sendEmail({
        to: clientRecord.intake.contactEmail,
        subject: 'Your Dispatch AI login link',
        text: `Hi,\n\nHere's your one-click link to manage your Dispatch AI account:\n${loginUrl}\n\nThis link works once and expires in 15 minutes. If you didn't request this, you can safely ignore this email.\n\n-- Dispatch AI`,
        fromName: 'Dispatch AI',
      });

      // No real email service configured yet -- surface the link directly
      // in the response so this is still testable before RESEND_API_KEY is
      // set, the same demo-mode fallback pattern used for follow-ups and
      // past-customer outreach elsewhere in this app.
      if (result.demoMode) {
        return sendJson(res, 200, { sent: true, demoMode: true, message: result.message, loginUrl });
      }
      return sendJson(res, 200, { sent: true });
    }

    // The link a client actually clicks from their email -- a real page
    // navigation, not a fetch, so on success it redirects straight into
    // their portal rather than returning JSON. Single-use and short-lived:
    // once verified, the login token is cleared and replaced by the
    // longer-lived clientPortalToken, which is what every other route below
    // actually runs on.
    if (pathname === '/api/client-portal/verify' && req.method === 'GET') {
      const token = url.searchParams.get('token');
      const clientRecord = token ? db.getClientByLoginToken(token) : null;
      const expired =
        !clientRecord || !clientRecord.clientLoginTokenExpiresAt || Date.now() > clientRecord.clientLoginTokenExpiresAt;

      if (expired) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          simpleHtmlPage(
            'Login link expired',
            "This login link isn't valid any more -- login links only work once and expire after 15 minutes. Head back and request a new one.",
            '/client-login',
            'Request a new link'
          )
        );
      }

      let updated = clientRecord;
      if (!updated.clientPortalToken) {
        updated = db.updateClient(clientRecord.id, { clientPortalToken: crypto.randomBytes(24).toString('hex') });
      }
      db.updateClient(clientRecord.id, { clientLoginToken: null, clientLoginTokenExpiresAt: null });

      res.writeHead(302, { location: `/client-portal.html?token=${updated.clientPortalToken}` });
      return res.end();
    }

    // Rotates a client's portal token -- a self-service "sign out of this
    // link everywhere" for anyone worried a link leaked, since there's no
    // password to change instead.
    const clientPortalRegenerateMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/regenerate$/);
    if (clientPortalRegenerateMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalRegenerateMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      const updated = db.updateClient(clientRecord.id, { clientPortalToken: crypto.randomBytes(24).toString('hex') });
      return sendJson(res, 200, { token: updated.clientPortalToken });
    }

    // The main portal payload -- everything the client-portal page needs to
    // render in one call. Only ever available to clients who've actually
    // subscribed at some point (paid or cancelled) -- there's nothing to
    // self-serve yet for a brand-new signup still in manual review.
    const clientPortalDataMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/data$/);
    if (clientPortalDataMatch && req.method === 'GET') {
      const clientRecord = db.getClientByPortalToken(clientPortalDataMatch[1]);
      if (!clientRecord || (clientRecord.status !== 'paid' && clientRecord.status !== 'cancelled')) {
        return sendJson(res, 404, { error: 'not found' });
      }
      // Every time a client opens their own portal is also a chance to
      // silently bring their live phone agent's tools up to date, with no
      // button for them to remember to click -- see
      // maybeRefreshPhoneAgentToolsInBackground above. Not awaited, so it
      // never slows down the page they're actually waiting on.
      maybeRefreshPhoneAgentToolsInBackground(clientRecord, `${url.protocol}//${url.host}`);
      const conversations = await getClassifiedConversations(clientRecord);
      return sendJson(res, 200, { ...clientPortalView(clientRecord), conversations });
    }
    // Analytics data for the client-portal dashboard -- kept as its own
    // route rather than folded into /data above, so that route's existing
    // shape never has to change. Same "paid or cancelled clients only" gate
    // as /data above.
    const clientPortalCallsMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/calls$/);
    if (clientPortalCallsMatch && req.method === 'GET') {
      const clientRecord = db.getClientByPortalToken(clientPortalCallsMatch[1]);
      if (!clientRecord || (clientRecord.status !== 'paid' && clientRecord.status !== 'cancelled')) {
        return sendJson(res, 404, { error: 'not found' });
      }
      return sendJson(res, 200, { calls: db.listCallsForClient(clientRecord.id) });
    }
    // Customer-jobs data for the client portal's editable jobs table --
    // same "paid or cancelled clients only" gate as /calls and /data above.
    const clientPortalJobsMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/jobs$/);
    if (clientPortalJobsMatch && req.method === 'GET') {
      const clientRecord = db.getClientByPortalToken(clientPortalJobsMatch[1]);
      if (!clientRecord || (clientRecord.status !== 'paid' && clientRecord.status !== 'cancelled')) {
        return sendJson(res, 404, { error: 'not found' });
      }
      return sendJson(res, 200, { jobs: db.listJobsForClient(clientRecord.id) });
    }

    // Lets a client correct or annotate one row of their own job list --
    // e.g. fixing a misheard phone number, or marking a job done -- right
    // from the portal. Checks the job id actually belongs to THIS client,
    // not just any job id that happens to resolve to something.
    const clientPortalJobUpdateMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/jobs\/([^/]+)$/);
    if (clientPortalJobUpdateMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalJobUpdateMatch[1]);
      if (!clientRecord || (clientRecord.status !== 'paid' && clientRecord.status !== 'cancelled')) {
        return sendJson(res, 404, { error: 'not found' });
      }
      const jobId = clientPortalJobUpdateMatch[2];
      const ownJobs = db.listJobsForClient(clientRecord.id);
      if (!ownJobs.some((j) => j.id === jobId)) {
        return sendJson(res, 404, { error: 'not found' });
      }
      const updates = await readBody(req);
      const allowedFields = ['customerName', 'customerPhone', 'customerEmail', 'jobDescription', 'preferredTime', 'status', 'notes'];
      const safeUpdates = {};
      allowedFields.forEach((key) => {
        if (key in updates) safeUpdates[key] = updates[key];
      });
      const updated = db.updateJob(jobId, safeUpdates);
      return sendJson(res, 200, { job: updated });
    }

    // Real, confirmed upcoming appointments for the client portal's
    // "Upcoming appointments" list -- separate from /jobs above, which is
    // every request taken down whether or not it turned into a booked
    // time. Same "paid or cancelled clients only" gate as /jobs and /data.
    const clientPortalAppointmentsMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/appointments$/);
    if (clientPortalAppointmentsMatch && req.method === 'GET') {
      const clientRecord = db.getClientByPortalToken(clientPortalAppointmentsMatch[1]);
      if (!clientRecord || (clientRecord.status !== 'paid' && clientRecord.status !== 'cancelled')) {
        return sendJson(res, 404, { error: 'not found' });
      }
      return sendJson(res, 200, { appointments: db.listUpcomingAppointmentsForClient(clientRecord.id) });
    }

    // Lets a business owner cancel one of their own confirmed appointments
    // right from the portal -- cancels the real Google Calendar event too,
    // not just this app's own record of it. Checks the appointment id
    // actually belongs to THIS client first, same ownership check as the
    // job-update route above.
    const clientPortalAppointmentCancelMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/appointments\/([^/]+)\/cancel$/);
    if (clientPortalAppointmentCancelMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalAppointmentCancelMatch[1]);
      if (!clientRecord || (clientRecord.status !== 'paid' && clientRecord.status !== 'cancelled')) {
        return sendJson(res, 404, { error: 'not found' });
      }
      const appt = db.getAppointmentById(clientPortalAppointmentCancelMatch[2]);
      if (!appt || appt.clientId !== clientRecord.id) {
        return sendJson(res, 404, { error: 'not found' });
      }
      if (appt.status === 'cancelled') {
        return sendJson(res, 200, { appointment: appt });
      }
      try {
        if (appt.calendarEventId && googleCalendar.isConfigured() && clientRecord.googleRefreshToken) {
          await googleCalendar.cancelAppointment({
            getAccessToken: () => getGoogleAccessToken(clientRecord),
            eventId: appt.calendarEventId,
          });
        }
      } catch (err) {
        console.error(`Appointment cancel (client-portal) failed for client ${clientRecord.id}:`, err.message || err);
        return sendJson(res, 502, { error: "Couldn't reach the calendar just now. Try again shortly." });
      }
      const updated = db.updateAppointment(appt.id, {
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
        cancelledBy: 'business',
      });
      return sendJson(res, 200, { appointment: updated });
    }

    // Lets a business owner move one of their own confirmed appointments to
    // a new date/time right from the portal -- same best-effort conflict
    // check and PATCH-not-recreate approach as the AI's own
    // reschedule_appointment tool in executeBookingTool above.
    const clientPortalAppointmentRescheduleMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/appointments\/([^/]+)\/reschedule$/);
    if (clientPortalAppointmentRescheduleMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalAppointmentRescheduleMatch[1]);
      if (!clientRecord || (clientRecord.status !== 'paid' && clientRecord.status !== 'cancelled')) {
        return sendJson(res, 404, { error: 'not found' });
      }
      const appt = db.getAppointmentById(clientPortalAppointmentRescheduleMatch[2]);
      if (!appt || appt.clientId !== clientRecord.id || appt.status === 'cancelled') {
        return sendJson(res, 404, { error: 'not found' });
      }
      if (!googleCalendar.isConfigured() || !clientRecord.googleRefreshToken) {
        return sendJson(res, 400, { error: 'Google Calendar is not connected for this account.' });
      }
      const { date, startTime, durationMinutes } = await readBody(req);
      if (!date || !startTime) {
        return sendJson(res, 400, { error: 'A new date and time are both required.' });
      }
      try {
        const result = await googleCalendar.rescheduleAppointment({
          getAccessToken: () => getGoogleAccessToken(clientRecord),
          eventId: appt.calendarEventId,
          date,
          startTime,
          durationMinutes: Number(durationMinutes) || Math.round((new Date(appt.endAt) - new Date(appt.startAt)) / 60000) || 60,
          timeZone: appt.timeZone,
        });
        if (result.conflict) {
          return sendJson(res, 200, { conflict: true });
        }
        const updated = db.updateAppointment(appt.id, { startAt: result.startRfc, endAt: result.endRfc });
        return sendJson(res, 200, { appointment: updated });
      } catch (err) {
        console.error(`Appointment reschedule (client-portal) failed for client ${clientRecord.id}:`, err.message || err);
        return sendJson(res, 502, { error: "Couldn't reach the calendar just now. Try again shortly." });
      }
    }

    // Lets a client edit their own AI agent's script -- but unlike the
    // founder's own script-editing route (which saves directly, since it's
    // the founder's own trusted edit), this runs the client's edit through
    // the exact same automatic safety check used on a brand-new signup
    // (checkScriptSafety, defined above). A confidently-safe edit goes live
    // immediately; anything else leaves the live script untouched and stores
    // the edit as a pending suggestion for the founder to apply or discard
    // from their dashboard, with a heads-up email -- the same fail-safe
    // philosophy used everywhere else a script could go out unreviewed.
    const clientPortalScriptMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/script$/);
    if (clientPortalScriptMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalScriptMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });

      const { script } = await readBody(req);
      if (!script || !script.trim()) {
        return sendJson(res, 400, { error: 'Script cannot be empty.' });
      }

      const check = await checkScriptSafety(clientRecord.intake, script);
      if (!check.checked || check.safe) {
        const updated = db.updateClient(clientRecord.id, { script, pendingScriptEdit: null, reviewReason: null });
        return sendJson(res, 200, { ...clientPortalView(updated), autoApplied: true });
      }

      const updated = db.updateClient(clientRecord.id, {
        pendingScriptEdit: script,
        reviewReason: `The client edited their AI script and the automatic check flagged it: ${
          check.reason || 'needs a manual look'
        }. Their live script hasn't changed yet -- review their suggested edit on the dashboard.`,
      });
      await notifyFounder({ companyName: clientRecord.intake?.companyName, reason: updated.reviewReason });
      return sendJson(res, 200, { ...clientPortalView(updated), autoApplied: false, flagReason: check.reason });
    }

    // Lets a cancelled client resubscribe themselves -- same checkout logic
    // as the founder's own "Get [plan] link" buttons, just self-triggered.
    const clientPortalCheckoutMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/checkout$/);
    if (clientPortalCheckoutMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalCheckoutMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });

            const { plan } = await readBody(req);
      const priceId = plan === 'growth' ? process.env.STRIPE_PRICE_ID_GROWTH : process.env.STRIPE_PRICE_ID_STARTER;
      const baseUrl = `${url.protocol}//${url.host}`;
      const result = await createCheckoutSession({
        clientId: clientRecord.id,
        priceId,
        companyName: clientRecord.intake?.companyName,
        // No trial here -- this route is a cancelled client resubscribing
        // themselves, and clientRecord.paidAt is already set from their
        // earlier subscription, so they've already had their one trial.
        trialDays: clientRecord.paidAt ? 0 : FREE_TRIAL_DAYS,
        successUrl: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${baseUrl}/client-portal.html?token=${clientPortalCheckoutMatch[1]}`,
      });


      const normalizedPlan = plan === 'growth' ? 'growth' : 'starter';
      if (!result.demoMode) {
        db.updateClient(clientRecord.id, { pendingPlan: normalizedPlan });
      }
      return sendJson(res, 200, { ...result, plan: normalizedPlan });
    }

    // Self-service "manage my subscription" link, same as the founder's own
    // portal button, just scoped by portal token instead of dashboard auth.
    const clientPortalStripeMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/portal$/);
    if (clientPortalStripeMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalStripeMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      const baseUrl = `${url.protocol}//${url.host}`;
      const result = await createPortalSession({
        customerId: clientRecord.stripeCustomerId,
        returnUrl: `${baseUrl}/client-portal.html?token=${clientPortalStripeMatch[1]}`,
      });
      return sendJson(res, 200, result);
    }

    const clientPortalPhoneAgentMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/create-phone-agent$/);
    if (clientPortalPhoneAgentMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalPhoneAgentMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      if (clientRecord.status !== 'paid') {
        return sendJson(res, 400, { error: 'You need to be on a paid plan before creating a live phone agent.' });
      }
                        if (clientRecord.retellAgentId) {
        // Also keep this agent's "brain" in sync with the client's current
        // script and real-time calendar-booking tools -- covers a client
        // whose agent was created before booking tools existed, or whose
        // script has been edited since their agent was first built. Never
        // blocks the rest of this route if it fails (e.g. a transient
        // Retell hiccup): the phone-number retry below, and the response
        // itself, still go ahead either way.
        try {
          const toolsBaseUrl = `${url.protocol}//${url.host}`;
          await updatePhoneAgentTools({
            llmId: clientRecord.retellLlmId,
            companyName: clientRecord.intake?.companyName,
            script: clientRecord.script,
            toolsUrl: `${toolsBaseUrl}/api/retell/tools/${retellWebhookToken()}`,
            timeZone: clientRecord.intake?.timeZone,
            appointmentLengthMinutes: clientRecord.intake?.appointmentLengthMinutes,
          });
          db.updateClient(clientRecord.id, { retellToolsVersion: PHONE_AGENT_TOOLS_VERSION });
        } catch (err) {
          console.error("Refreshing existing phone agent's booking tools failed:", err.message || err);
        }

        // Agent already exists. If an earlier automatic number purchase
        // failed (or hadn't been built yet), a repeat click here is also a
        // reasonable moment to try again, instead of the client being stuck
        // with no number forever just because the first attempt hit a
        // hiccup.
        if (!clientRecord.retellPhoneNumber) {

          const provision = await provisionPhoneNumber({
            agentId: clientRecord.retellAgentId,
            companyName: clientRecord.intake?.companyName,
          });
          if (provision.success) {
            db.updateClient(clientRecord.id, {
              retellPhoneNumber: provision.phoneNumber,
              retellPhoneNumberSavedAt: new Date().toISOString(),
            });
          } else if (!provision.demoMode) {
            console.error('Automatic phone number purchase failed (retry):', provision.error || provision.message);
            await notifyFounder({            

              companyName: clientRecord.intake?.companyName,
              reason: `Automatic phone number purchase failed: ${provision.error || provision.message}. Buy one manually in Telnyx and import it to Retell agent ${clientRecord.retellAgentId}, then save it on this client's card.`,
            });
          }
        }
        const refreshed = db.getClient(clientRecord.id) || clientRecord;
        return sendJson(res, 200, {
          demoMode: false,
          llmId: refreshed.retellLlmId,
          agentId: refreshed.retellAgentId,
          retellPhoneNumber: refreshed.retellPhoneNumber || null,
        });
      }

      const baseUrl = `${url.protocol}//${url.host}`;
      const result = await createPhoneAgent({
        companyName: clientRecord.intake?.companyName,
        script: clientRecord.script,
        webhookUrl: `${baseUrl}/api/retell/webhook/${retellWebhookToken()}`,
        toolsUrl: `${baseUrl}/api/retell/tools/${retellWebhookToken()}`,
        timeZone: clientRecord.intake?.timeZone,
        appointmentLengthMinutes: clientRecord.intake?.appointmentLengthMinutes,
      });

      

            if (!result.demoMode) {
        db.updateClient(clientRecord.id, {
          retellLlmId: result.llmId,
          retellAgentId: result.agentId,
          retellAgentCreatedAt: new Date().toISOString(),
          retellToolsVersion: PHONE_AGENT_TOOLS_VERSION,
        });

        // Automatically buy this client their own real UK number and bind
        // it to the agent just created -- see lib/phoneProvisioning.js.
        // Never blocks: if it fails, the agent above still exists and the
        // client can still use the manual /phone-number fallback route
        // below (or the founder can retry by re-clicking, handled above).
        const provision = await provisionPhoneNumber({
          agentId: result.agentId,
          companyName: clientRecord.intake?.companyName,
        });
        if (provision.success) {
          db.updateClient(clientRecord.id, {
            retellPhoneNumber: provision.phoneNumber,
            retellPhoneNumberSavedAt: new Date().toISOString(),
          });
          result.retellPhoneNumber = provision.phoneNumber;
        } else if (!provision.demoMode) {
                    console.error('Automatic phone number purchase failed (first creation):', provision.error || provision.message);
          await notifyFounder({
            companyName: clientRecord.intake?.companyName,
            reason: `Automatic phone number purchase failed: ${provision.error || provision.message}. Buy one manually in Telnyx and import it to Retell agent ${result.agentId}, then save it on this client's card.`,
          });
        }
      }
      return sendJson(res, 200, result);
    }

    const clientPortalPhoneNumberMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/phone-number$/);

    if (clientPortalPhoneNumberMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalPhoneNumberMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      const { phoneNumber } = await readBody(req);
      const updated = db.updateClient(clientRecord.id, {
        retellPhoneNumber: phoneNumber || null,
        retellPhoneNumberSavedAt: new Date().toISOString(),
      });
      return sendJson(res, 200, clientPortalView(updated));
    }    const clientPortalServiceM8Match = pathname.match(/^\/api\/client-portal\/([^/]+)\/service-m8$/);
    if (clientPortalServiceM8Match && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalServiceM8Match[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      const { serviceM8ApiKey } = await readBody(req);
      if (serviceM8ApiKey) {
        const works = await serviceM8.testApiKey(serviceM8ApiKey);
        if (!works) {
          return sendJson(res, 400, { error: "That key didn't work -- double check it and try again." });
        }
      }
      const updated = db.updateClient(clientRecord.id, { serviceM8ApiKey: serviceM8ApiKey || null });
      return sendJson(res, 200, clientPortalView(updated));
    }
    const clientPortalReviewLinkMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/review-link$/);
    if (clientPortalReviewLinkMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalReviewLinkMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      const { reviewLink } = await readBody(req);
      const updated = db.updateClient(clientRecord.id, { reviewLink: reviewLink || null });
      return sendJson(res, 200, clientPortalView(updated));
    }


    // Generates (or reuses) this client's own past-customer portal link --
    // same token, same page (public/customer-portal.html) the founder can
    // also hand them, just self-service here instead of waiting on a click
    // from the dashboard.
    const clientPortalCustomerLinkMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/customer-portal-link$/);
    if (clientPortalCustomerLinkMatch && req.method === 'POST') {
      let clientRecord = db.getClientByPortalToken(clientPortalCustomerLinkMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      if (!clientRecord.pastCustomerPortalToken) {
        clientRecord = db.updateClient(clientRecord.id, { pastCustomerPortalToken: crypto.randomBytes(24).toString('hex') });
      }
      const baseUrl = `${url.protocol}//${url.host}`;
      return sendJson(res, 200, { url: `${baseUrl}/customer-portal.html?token=${clientRecord.pastCustomerPortalToken}` });
    }

    // Starts the same Google OAuth flow as the founder's dashboard button,
    // just reachable from the client's own portal -- returnTo carries the
    // portal token through the redirect so the callback below can send them
    // back to their own portal instead of the founder's (password-protected)
    // dashboard once they've approved access.
    const clientPortalCalendarConnectMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/google-calendar\/connect$/);
    if (clientPortalCalendarConnectMatch && req.method === 'GET') {
      const token = clientPortalCalendarConnectMatch[1];
      const clientRecord = db.getClientByPortalToken(token);
      if (!clientRecord) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('Not found.');
      }
      if (!googleCalendar.isConfigured()) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          simpleHtmlPage(
            'Google Calendar not set up yet',
            "Google Calendar isn't connected to Dispatch AI yet -- ask your Dispatch AI contact to finish that setup before this button can work.",
            `/client-portal.html?token=${token}`,
            'Back to your account'
          )
        );
      }
      const baseUrl = `${url.protocol}//${url.host}`;
      const authUrl = googleCalendar.getAuthUrl({ clientId: clientRecord.id, baseUrl, returnTo: `portal:${token}` });
      res.writeHead(302, { location: authUrl });
      return res.end();
    }

    const clientPortalCalendarDisconnectMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/google-calendar\/disconnect$/);
    if (clientPortalCalendarDisconnectMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalCalendarDisconnectMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      db.updateClient(clientRecord.id, {
        googleRefreshToken: null,
        googleAccessToken: null,
        googleAccessTokenExpiresAt: null,
        googleCalendarConnectedAt: null,
        googleCalendarEmail: null,
        googleCalendarNeedsReconnect: false,
      });
      return sendJson(res, 200, { disconnected: true });
    }

    // Turns the hosted website add-on on/off, self-service -- same effect as
    // the founder's equivalent dashboard buttons.
    const clientPortalHostedPageEnableMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/hosted-page\/enable$/);
    if (clientPortalHostedPageEnableMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalHostedPageEnableMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      db.assignHostedPageSlug(clientRecord.id, clientRecord.intake?.companyName);
      const updated = db.updateClient(clientRecord.id, { hostedPageEnabled: true });
      const baseUrl = `${url.protocol}//${url.host}`;
      return sendJson(res, 200, { hostedPageEnabled: true, url: `${baseUrl}/site/${updated.hostedPageSlug}` });
    }

    const clientPortalHostedPageDisableMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/hosted-page\/disable$/);
    if (clientPortalHostedPageDisableMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalHostedPageDisableMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      db.updateClient(clientRecord.id, { hostedPageEnabled: false });
      return sendJson(res, 200, { hostedPageEnabled: false });
    }

    // Lets the client edit/approve/send an AI-drafted follow-up for their
    // own unbooked leads -- identical logic to the founder's equivalent
    // routes, just scoped by portal token instead of dashboard auth.
    const clientPortalFollowUpEditMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/conversations\/([^/]+)\/follow-up$/);
    if (clientPortalFollowUpEditMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalFollowUpEditMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      const convo = db.getConversation(clientPortalFollowUpEditMatch[2]);
      if (!convo || convo.clientId !== clientRecord.id) return sendJson(res, 404, { error: 'not found' });

      const { subject, body } = await readBody(req);
      const updated = db.updateConversation(convo.id, { followUpSubject: subject, followUpBody: body });
      return sendJson(res, 200, updated);
    }

    const clientPortalFollowUpApproveMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/conversations\/([^/]+)\/follow-up\/approve$/);
    if (clientPortalFollowUpApproveMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalFollowUpApproveMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      const convo = db.getConversation(clientPortalFollowUpApproveMatch[2]);
      if (!convo || convo.clientId !== clientRecord.id) return sendJson(res, 404, { error: 'not found' });

      const updated = db.updateConversation(convo.id, {
        followUpStatus: 'approved',
        followUpApprovedAt: new Date().toISOString(),
      });
      return sendJson(res, 200, updated);
    }

    const clientPortalFollowUpSendMatch = pathname.match(/^\/api\/client-portal\/([^/]+)\/conversations\/([^/]+)\/follow-up\/send$/);
    if (clientPortalFollowUpSendMatch && req.method === 'POST') {
      const clientRecord = db.getClientByPortalToken(clientPortalFollowUpSendMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      const convo = db.getConversation(clientPortalFollowUpSendMatch[2]);
      if (!convo || convo.clientId !== clientRecord.id) return sendJson(res, 404, { error: 'not found' });

      if (convo.followUpStatus !== 'approved') {
        return sendJson(res, 400, { error: 'Approve the draft before sending it.' });
      }
      if (!convo.contactEmail) {
        return sendJson(res, 400, { error: 'No email address on file for this conversation.' });
      }

      const companyName = clientRecord.intake?.companyName || 'your business';
      const result = await sendEmail({
        to: convo.contactEmail,
        subject: convo.followUpSubject || 'Following up',
        text: convo.followUpBody || '',
        fromName: companyName,
      });

      if (result.demoMode) {
        return sendJson(res, 200, result);
      }

      const updated = db.updateConversation(convo.id, {
        followUpStatus: 'sent',
        followUpSentAt: new Date().toISOString(),
      });
      return sendJson(res, 200, { ...result, conversation: updated });
    }

    // --- Dashboard data ------------------------------------------------------
    if (pathname === '/api/clients' && req.method === 'GET') {
      return sendJson(res, 200, db.listClients());
    }

    const clientScriptMatch = pathname.match(/^\/api\/clients\/([^/]+)\/script$/);
    if (clientScriptMatch && req.method === 'POST') {
      const { script } = await readBody(req);
      const updated = db.updateClient(clientScriptMatch[1], { script });
      if (!updated) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, updated);
    }

    const clientApproveMatch = pathname.match(/^\/api\/clients\/([^/]+)\/approve$/);
    if (clientApproveMatch && req.method === 'POST') {
      const updated = db.updateClient(clientApproveMatch[1], {
        status: 'approved',
        approvedAt: new Date().toISOString(),
      });
      if (!updated) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, updated);
    }

    // Generates a real Stripe subscription payment link for an approved
    // client. Returns a demo-mode message instead of a real link until
    // STRIPE_SECRET_KEY and the price IDs are configured in Render.
    const clientCheckoutMatch = pathname.match(/^\/api\/clients\/([^/]+)\/checkout$/);
    if (clientCheckoutMatch && req.method === 'POST') {
      const { plan } = await readBody(req);
      const clientRecord = db.getClient(clientCheckoutMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });

      const priceId =
        plan === 'growth' ? process.env.STRIPE_PRICE_ID_GROWTH : process.env.STRIPE_PRICE_ID_STARTER;
      const baseUrl = `${url.protocol}//${url.host}`;

            const result = await createCheckoutSession({
        clientId: clientRecord.id,
        priceId,
        companyName: clientRecord.intake?.companyName,
        // Same first-time-only trial rule as the auto-approval flow above.
        trialDays: clientRecord.paidAt ? 0 : FREE_TRIAL_DAYS,
        // These used to point at /dashboard, which is password-protected --
        // a real paying client has no way past that login. They go to the
        // public /success page instead, which is where the self-service
        // "manage my subscription" button lives.
        successUrl: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${baseUrl}/?checkout=cancelled`,
      });


      const normalizedPlan = plan === 'growth' ? 'growth' : 'starter';
      if (!result.demoMode) {
        db.updateClient(clientRecord.id, { pendingPlan: normalizedPlan });
      }

      return sendJson(res, 200, { ...result, plan: normalizedPlan });
    }

    // Lets the founder (from the dashboard, already logged in) generate a
    // manage/cancel link for a specific paying client on demand -- useful
    // when a client emails asking to cancel instead of using the portal
    // link from their original success page.
    const clientPortalMatch = pathname.match(/^\/api\/clients\/([^/]+)\/portal$/);
    if (clientPortalMatch && req.method === 'POST') {
      const clientRecord = db.getClient(clientPortalMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });

      const baseUrl = `${url.protocol}//${url.host}`;
      const result = await createPortalSession({
        customerId: clientRecord.stripeCustomerId,
        returnUrl: `${baseUrl}/dashboard`,
      });
      return sendJson(res, 200, result);
    }

    // Pushes a paying client's approved script into Retell AI as a real,
    // callable phone agent. Gated on status === 'paid' specifically (not
    // just "approved") -- a live phone number costs real money via
    // Retell/Twilio, so this shouldn't be created before someone has
    // actually subscribed, same reasoning as the website widget's gating.
    // Idempotent: if this client already has a Retell agent, just return
    // it instead of creating a duplicate on a second click.
    const clientPhoneAgentMatch = pathname.match(/^\/api\/clients\/([^/]+)\/create-phone-agent$/);
    if (clientPhoneAgentMatch && req.method === 'POST') {
      const clientRecord = db.getClient(clientPhoneAgentMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      if (clientRecord.status !== 'paid') {
        return sendJson(res, 400, { error: 'This client needs to be on a paid plan before creating a live phone agent.' });
      }
      if (clientRecord.retellAgentId) {
        // Also keep this agent's "brain" in sync with the client's current
        // script and real-time calendar-booking tools -- covers a client
        // whose agent was created before booking tools existed, or whose
        // script has been edited since their agent was first built. Never
        // blocks the rest of this route if it fails (e.g. a transient
        // Retell hiccup): the phone-number retry below, and the response
        // itself, still go ahead either way.
        try {
          const toolsBaseUrl = `${url.protocol}//${url.host}`;
          await updatePhoneAgentTools({
            llmId: clientRecord.retellLlmId,
            companyName: clientRecord.intake?.companyName,
            script: clientRecord.script,
            toolsUrl: `${toolsBaseUrl}/api/retell/tools/${retellWebhookToken()}`,
            timeZone: clientRecord.intake?.timeZone,
            appointmentLengthMinutes: clientRecord.intake?.appointmentLengthMinutes,
          });
          db.updateClient(clientRecord.id, { retellToolsVersion: PHONE_AGENT_TOOLS_VERSION });
        } catch (err) {
          console.error("Refreshing existing phone agent's booking tools failed:", err.message || err);
        }

        // Agent already exists. If an earlier automatic number purchase
        // failed (or hadn't been built yet), a repeat click here is also a
        // reasonable moment to try again, rather than the client staying
        // stuck with no number just because the first attempt hit a hiccup.
        if (!clientRecord.retellPhoneNumber) {
          const provision = await provisionPhoneNumber({
            agentId: clientRecord.retellAgentId,
            companyName: clientRecord.intake?.companyName,
          });
          if (provision.success) {
            db.updateClient(clientRecord.id, {
              retellPhoneNumber: provision.phoneNumber,
              retellPhoneNumberSavedAt: new Date().toISOString(),
            });
          } else if (!provision.demoMode) {
            console.error('Automatic phone number purchase failed (retry):', provision.error || provision.message);
            await notifyFounder({
              companyName: clientRecord.intake?.companyName,
              reason: `Automatic phone number purchase failed: ${provision.error || provision.message}. Buy one manually in Telnyx and import it to Retell agent ${clientRecord.retellAgentId}, then save it on this client's card.`,
            });
          }
        }

        const refreshed = db.getClient(clientRecord.id) || clientRecord;
        return sendJson(res, 200, {
          demoMode: false,
          llmId: refreshed.retellLlmId,
          agentId: refreshed.retellAgentId,
          retellPhoneNumber: refreshed.retellPhoneNumber || null,
        });
      }

            const baseUrl = `${url.protocol}//${url.host}`;
      const result = await createPhoneAgent({
        companyName: clientRecord.intake?.companyName,
        script: clientRecord.script,
        webhookUrl: `${baseUrl}/api/retell/webhook/${retellWebhookToken()}`,
        toolsUrl: `${baseUrl}/api/retell/tools/${retellWebhookToken()}`,
        timeZone: clientRecord.intake?.timeZone,
        appointmentLengthMinutes: clientRecord.intake?.appointmentLengthMinutes,
      });


      if (!result.demoMode) {
        db.updateClient(clientRecord.id, {
          retellLlmId: result.llmId,
          retellAgentId: result.agentId,
          retellAgentCreatedAt: new Date().toISOString(),
          retellToolsVersion: PHONE_AGENT_TOOLS_VERSION,
        });

        // Automatically buy this client their own real UK number and bind
        // it to the agent just created -- see lib/phoneProvisioning.js.
        // Never blocks: if it fails, the agent above still exists and the
        // founder can save a number by hand via the input box below, or
        // retry by re-clicking (handled above).
        const provision = await provisionPhoneNumber({
          agentId: result.agentId,
          companyName: clientRecord.intake?.companyName,
        });
        if (provision.success) {
          db.updateClient(clientRecord.id, {
            retellPhoneNumber: provision.phoneNumber,
            retellPhoneNumberSavedAt: new Date().toISOString(),
          });
          result.retellPhoneNumber = provision.phoneNumber;
        } else if (!provision.demoMode) {
                    console.error('Automatic phone number purchase failed (first creation):', provision.error || provision.message);
          await notifyFounder({
            companyName: clientRecord.intake?.companyName,
            reason: `Automatic phone number purchase failed: ${provision.error || provision.message}. Buy one manually in Telnyx and import it to Retell agent ${result.agentId}, then save it on this client's card.`,
          });
        }
      }

      return sendJson(res, 200, result);
    }

      

    // Lets the founder record the phone number once they've bought/imported
    // it and assigned it to the agent above -- entirely inside Retell's own
    // dashboard, no API call needed here. This just keeps it visible on this
    // client's card so it's easy to find later and hand to the client.
    const clientPhoneNumberMatch = pathname.match(/^\/api\/clients\/([^/]+)\/phone-number$/);
    if (clientPhoneNumberMatch && req.method === 'POST') {
      const { phoneNumber } = await readBody(req);
      const updated = db.updateClient(clientPhoneNumberMatch[1], {
        retellPhoneNumber: phoneNumber || null,
        retellPhoneNumberSavedAt: new Date().toISOString(),
      });
      if (!updated) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, updated);
    }

    // Generates (or reuses) this client's private past-customer portal link
    // -- for the founder to copy and send to the client directly (text,
    // email, however they normally reach them). Unlike the Stripe portal
    // link, this one is a long-lived token stored on the client record, not
    // a short-lived session, since the client will want to reuse the same
    // link over time to check on their outreach.
    const clientPortalLinkMatch = pathname.match(/^\/api\/clients\/([^/]+)\/customer-portal-link$/);
    if (clientPortalLinkMatch && req.method === 'POST') {
      let clientRecord = db.getClient(clientPortalLinkMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });

      if (!clientRecord.pastCustomerPortalToken) {
        clientRecord = db.updateClient(clientRecord.id, { pastCustomerPortalToken: crypto.randomBytes(24).toString('hex') });
      }

      const baseUrl = `${url.protocol}//${url.host}`;
      return sendJson(res, 200, { url: `${baseUrl}/customer-portal.html?token=${clientRecord.pastCustomerPortalToken}` });
    }

    // Generates (or reuses) this client's self-service account link -- the
    // same clientPortalToken a client gets themselves by requesting a
    // magic-link login (see /api/client-portal/request-login below), just
    // handed to the founder directly so they don't have to wait on the
    // client to request their own first login.
    const clientAccountLinkMatch = pathname.match(/^\/api\/clients\/([^/]+)\/account-portal-link$/);
    if (clientAccountLinkMatch && req.method === 'POST') {
      let clientRecord = db.getClient(clientAccountLinkMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });

      if (!clientRecord.clientPortalToken) {
        clientRecord = db.updateClient(clientRecord.id, { clientPortalToken: crypto.randomBytes(24).toString('hex') });
      }

      const baseUrl = `${url.protocol}//${url.host}`;
      return sendJson(res, 200, { url: `${baseUrl}/client-portal.html?token=${clientRecord.clientPortalToken}` });
    }

    // Applies or discards a script edit a client made from their own
    // self-service portal that the automatic safety check couldn't confirm
    // was safe to go live on its own (see the client-portal script route
    // below) -- their live script is left untouched until the founder
    // decides here.
    const pendingScriptEditApplyMatch = pathname.match(/^\/api\/clients\/([^/]+)\/pending-script-edit\/apply$/);
    if (pendingScriptEditApplyMatch && req.method === 'POST') {
      const clientRecord = db.getClient(pendingScriptEditApplyMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      if (!clientRecord.pendingScriptEdit) return sendJson(res, 400, { error: 'No pending edit to apply.' });
      const updated = db.updateClient(clientRecord.id, {
        script: clientRecord.pendingScriptEdit,
        pendingScriptEdit: null,
        reviewReason: null,
      });
      return sendJson(res, 200, updated);
    }

    const pendingScriptEditDiscardMatch = pathname.match(/^\/api\/clients\/([^/]+)\/pending-script-edit\/discard$/);
    if (pendingScriptEditDiscardMatch && req.method === 'POST') {
      const updated = db.updateClient(pendingScriptEditDiscardMatch[1], { pendingScriptEdit: null, reviewReason: null });
      if (!updated) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, updated);
    }

    // Turns the hosted website add-on on/off for a client -- included free
    // on any paid plan. Assigns a slug on first enable (see
    // assignHostedPageSlug) and keeps it if turned off and back on later,
    // so a link the client has already shared with a customer never breaks.
    const clientHostedPageEnableMatch = pathname.match(/^\/api\/clients\/([^/]+)\/hosted-page\/enable$/);
    if (clientHostedPageEnableMatch && req.method === 'POST') {
      const clientRecord = db.getClient(clientHostedPageEnableMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      db.assignHostedPageSlug(clientRecord.id, clientRecord.intake?.companyName);
      const updated = db.updateClient(clientRecord.id, { hostedPageEnabled: true });
      const baseUrl = `${url.protocol}//${url.host}`;
      return sendJson(res, 200, { hostedPageEnabled: true, url: `${baseUrl}/site/${updated.hostedPageSlug}` });
    }

    const clientHostedPageDisableMatch = pathname.match(/^\/api\/clients\/([^/]+)\/hosted-page\/disable$/);
    if (clientHostedPageDisableMatch && req.method === 'POST') {
      const updated = db.updateClient(clientHostedPageDisableMatch[1], { hostedPageEnabled: false });
      if (!updated) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, { hostedPageEnabled: false });
    }

    // Read-only view for the founder's dashboard -- the client owns editing
    // and sending their own outreach on their private portal page, since
    // they know their own past customers and the founder doesn't (same
    // reasoning as the automatic script safety check). This just lets the
    // founder see what's happening without having to ask.
    const clientPastCustomersMatch = pathname.match(/^\/api\/clients\/([^/]+)\/past-customers$/);
    if (clientPastCustomersMatch && req.method === 'GET') {
      const clientRecord = db.getClient(clientPastCustomersMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });

      let pastCustomers = db.listPastCustomersForClient(clientRecord.id);
      pastCustomers = await draftDueOutreach(clientRecord, pastCustomers);
      return sendJson(res, 200, pastCustomers);
    }

    // Every website-widget conversation a paying client has had, tagged with
    // an outcome (booked / unbooked lead / question answered / unclear) so
    // the founder -- or the client, once they get their own view of this --
    // can see what's happening without reading every transcript. Any
    // conversation that's gone quiet for a while and hasn't been reviewed
    // yet gets classified here, on demand, rather than on a background timer
    // -- simplest thing that works for the volume an MVP will see.
    const clientConversationsMatch = pathname.match(/^\/api\/clients\/([^/]+)\/conversations$/);
    if (clientConversationsMatch && req.method === 'GET') {
      const clientRecord = db.getClient(clientConversationsMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, await getClassifiedConversations(clientRecord));
    }

    // Lets the founder edit an AI-drafted follow-up message before it's ever
    // used -- same "review before it goes out" pattern as editing the main
    // agent script. Nothing gets sent automatically yet; this just updates
    // the stored draft.
    const followUpEditMatch = pathname.match(/^\/api\/clients\/([^/]+)\/conversations\/([^/]+)\/follow-up$/);
    if (followUpEditMatch && req.method === 'POST') {
      const [, clientId, convoId] = followUpEditMatch;
      const convo = db.getConversation(convoId);
      if (!convo || convo.clientId !== clientId) return sendJson(res, 404, { error: 'not found' });

      const { subject, body } = await readBody(req);
      const updated = db.updateConversation(convoId, { followUpSubject: subject, followUpBody: body });
      return sendJson(res, 200, updated);
    }

    // Marks a follow-up draft as approved. Doesn't send anything yet -- there
    // is no sending mechanism built. This just records that the business
    // owner has signed off on the wording, ready for whenever sending exists.
    const followUpApproveMatch = pathname.match(/^\/api\/clients\/([^/]+)\/conversations\/([^/]+)\/follow-up\/approve$/);
    if (followUpApproveMatch && req.method === 'POST') {
      const [, clientId, convoId] = followUpApproveMatch;
      const convo = db.getConversation(convoId);
      if (!convo || convo.clientId !== clientId) return sendJson(res, 404, { error: 'not found' });

      const updated = db.updateConversation(convoId, {
        followUpStatus: 'approved',
        followUpApprovedAt: new Date().toISOString(),
      });
      return sendJson(res, 200, updated);
    }

    // Stage 3 of "never let a lead go cold": actually send an approved
    // follow-up. Deliberately a separate, explicit action from "Approve" --
    // approving just signs off on the wording, this is the one click that
    // actually puts an email in a real person's inbox, so it stays a
    // distinct, founder-triggered step rather than firing automatically the
    // moment something is approved.
    const followUpSendMatch = pathname.match(/^\/api\/clients\/([^/]+)\/conversations\/([^/]+)\/follow-up\/send$/);
    if (followUpSendMatch && req.method === 'POST') {
      const [, clientId, convoId] = followUpSendMatch;
      const convo = db.getConversation(convoId);
      if (!convo || convo.clientId !== clientId) return sendJson(res, 404, { error: 'not found' });

      if (convo.followUpStatus !== 'approved') {
        return sendJson(res, 400, { error: 'Approve the draft before sending it.' });
      }
      if (!convo.contactEmail) {
        return sendJson(res, 400, { error: 'No email address on file for this conversation.' });
      }

      const clientRecord = db.getClient(clientId);
      const companyName = clientRecord?.intake?.companyName || 'the business';

      const result = await sendEmail({
        to: convo.contactEmail,
        subject: convo.followUpSubject || 'Following up',
        text: convo.followUpBody || '',
        fromName: companyName,
      });

      if (result.demoMode) {
        return sendJson(res, 200, result);
      }

      const updated = db.updateConversation(convoId, {
        followUpStatus: 'sent',
        followUpSentAt: new Date().toISOString(),
      });
      return sendJson(res, 200, { ...result, conversation: updated });
    }

    // --- Autonomous email-marketing agent (founder-only dashboard view) ---
    // These sit under /api/clients/marketing/... specifically so they
    // inherit the dashboard's existing Basic Auth gate (isProtectedPath
    // matches anything starting with /api/clients) with no extra wiring.

    // Everything the daily agent drafted but held back for a human look --
    // right now that's just the 'win_back_cancelled' kind, see
    // runEmailMarketingAgent below for why. Enriches each draft with the
    // client's company name since marketingEmails.json only stores a
    // clientId, not a copy of the client's own details.
    if (pathname === '/api/clients/marketing/pending' && req.method === 'GET') {
      const pending = db.listPendingMarketingEmails().map((m) => ({
        ...m,
        companyName: db.getClient(m.clientId)?.intake?.companyName || '(unknown business)',
      }));
      return sendJson(res, 200, pending);
    }

    // A simple activity log for the dashboard -- what the agent has drafted,
    // sent, or had rejected recently, newest first. Capped at 50 so this
    // never grows unbounded in the response as marketingEmails.json grows.
    if (pathname === '/api/clients/marketing/recent' && req.method === 'GET') {
      const recent = db.listMarketingEmails().slice(0, 50).map((m) => ({
        ...m,
        companyName: db.getClient(m.clientId)?.intake?.companyName || '(unknown business)',
      }));
      return sendJson(res, 200, recent);
    }

    // Approves a held draft and sends it right away -- same deliberate
    // separation as the follow-up approve/send split above, except here
    // it's one click instead of two since there's nothing else to edit
    // first (there's no wording-edit box for these, unlike follow-ups).
    const marketingApproveMatch = pathname.match(/^\/api\/clients\/marketing\/([^/]+)\/approve$/);
    if (marketingApproveMatch && req.method === 'POST') {
      const record = db.getMarketingEmailById(marketingApproveMatch[1]);
      if (!record) return sendJson(res, 404, { error: 'not found' });
      if (record.status !== 'pending_approval') {
        return sendJson(res, 400, { error: 'This draft is not waiting for approval.' });
      }
      const clientRecord = db.getClient(record.clientId);
      if (!clientRecord) return sendJson(res, 404, { error: 'client not found' });

      const result = await sendMarketingEmail(clientRecord, record);
      const updated = db.updateMarketingEmail(record.id, result.sent
        ? { status: 'sent', approvedAt: new Date().toISOString(), sentAt: new Date().toISOString() }
        : { status: 'send_failed', approvedAt: new Date().toISOString(), error: result.error || null });
      return sendJson(res, 200, updated);
    }

    // Says no -- the draft is marked rejected and nothing is ever sent.
    // Kept as its own record (not deleted) so it still shows in the recent
    // activity log and so hasRecentMarketingEmail still counts it, which
    // stops the agent re-drafting the exact same nudge again tomorrow.
    const marketingRejectMatch = pathname.match(/^\/api\/clients\/marketing\/([^/]+)\/reject$/);
    if (marketingRejectMatch && req.method === 'POST') {
      const record = db.getMarketingEmailById(marketingRejectMatch[1]);
      if (!record) return sendJson(res, 404, { error: 'not found' });
      if (record.status !== 'pending_approval') {
        return sendJson(res, 400, { error: 'This draft is not waiting for approval.' });
      }
      const updated = db.updateMarketingEmail(record.id, {
        status: 'rejected',
        rejectedAt: new Date().toISOString(),
      });
      return sendJson(res, 200, updated);
    }

    const clientGetMatch = pathname.match(/^\/api\/clients\/([^/]+)$/);
    if (clientGetMatch && req.method === 'GET') {
      const clientRecord = db.getClient(clientGetMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
      // Same silent background refresh as the client portal's own data
      // route above, for when the founder opens this client's card in
      // their own dashboard.
      maybeRefreshPhoneAgentToolsInBackground(clientRecord, `${url.protocol}//${url.host}`);
      return sendJson(res, 200, clientRecord);
    }

    // Public counterpart used by the /success page right after a real
    // customer pays. The Checkout session_id in the URL is a long,
    // unguessable token Stripe generates -- only the paying customer's own
    // browser (and their emailed receipt) ever sees it, so looking up their
    // Stripe customer from it is a reasonable, lightweight way to offer
    // self-service without building a full client login system.
    if (pathname === '/api/portal-session' && req.method === 'POST') {
      const { sessionId } = await readBody(req);
      if (!sessionId) return sendJson(res, 400, { error: 'sessionId is required' });

      const baseUrl = `${url.protocol}//${url.host}`;
      const { demoMode, session } = await getCheckoutSession(sessionId);
      if (demoMode) {
        return sendJson(res, 200, {
          demoMode: true,
          message: 'STRIPE_SECRET_KEY is not set yet -- the self-service portal needs it configured first.',
        });
      }
      if (!session || !session.customer) {
        return sendJson(res, 404, { error: 'checkout session not found' });
      }

      const result = await createPortalSession({
        customerId: session.customer,
        returnUrl: `${baseUrl}/success?session_id=${sessionId}`,
      });
      return sendJson(res, 200, result);
    }
    // Lets a brand-new paying customer get straight into their self-service
    // dashboard right from the Stripe success page, using only the
    // session_id Stripe put in the redirect URL -- no email round-trip, no
    // separate login step first. Public for the same reason
    // /api/portal-session is just above: Stripe's own redirect can't carry
    // the dashboard's Basic Auth header, and this only ever reveals a link
    // tied to the specific checkout session that was just completed.
    if (pathname === '/api/success-portal-link' && req.method === 'POST') {
      const { sessionId } = await readBody(req);
      if (!sessionId) return sendJson(res, 400, { error: 'sessionId is required' });

      const baseUrl = `${url.protocol}//${url.host}`;
      const { demoMode, session } = await getCheckoutSession(sessionId);
      if (demoMode) {
        return sendJson(res, 200, {
          demoMode: true,
          message: 'STRIPE_SECRET_KEY is not set yet -- the self-service dashboard needs it configured first.',
        });
      }
      if (!session || !session.client_reference_id) {
        return sendJson(res, 404, { error: 'checkout session not found' });
      }

      let clientRecord = db.getClient(session.client_reference_id);
      if (!clientRecord) {
        return sendJson(res, 404, { error: 'client not found' });
      }

      if (!clientRecord.clientPortalToken) {
        clientRecord = db.updateClient(clientRecord.id, { clientPortalToken: crypto.randomBytes(24).toString('hex') });
      }

      return sendJson(res, 200, { url: `${baseUrl}/client-portal.html?token=${clientRecord.clientPortalToken}` });
    }


    // Starts the Google OAuth flow for one paying client, so their AI widget
    // can check real availability and create real appointments on their own
    // calendar. A plain link on the dashboard, not a fetch button -- this is
    // a real full-page navigation to Google's consent screen, and comes back
    // under /api/clients so the dashboard's normal Basic Auth gate above
    // already covers it, the same as every other per-client action.
    const googleCalendarConnectMatch = pathname.match(/^\/api\/clients\/([^/]+)\/google-calendar\/connect$/);
    if (googleCalendarConnectMatch && req.method === 'GET') {
      const clientRecord = db.getClient(googleCalendarConnectMatch[1]);
      if (!clientRecord) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('Client not found.');
      }
      if (!googleCalendar.isConfigured()) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          simpleHtmlPage(
            'Google Calendar not set up yet',
            "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET aren't set on this app yet -- see LAUNCH_CHECKLIST.md to connect Google Calendar before this button can work.",
            '/dashboard'
          )
        );
      }
      const baseUrl = `${url.protocol}//${url.host}`;
      const authUrl = googleCalendar.getAuthUrl({ clientId: clientRecord.id, baseUrl });
      res.writeHead(302, { location: authUrl });
      return res.end();
    }

    // Google redirects here after the business owner approves (or declines)
    // calendar access. Public on purpose -- Google's own servers hit this
    // URL directly and can't carry the dashboard's Basic Auth header, the
    // same reason /api/stripe/webhook and /api/portal-session stay public.
    // `state` carries the client ID through the redirect (set in
    // getAuthUrl above).
    if (pathname === '/api/google-calendar/oauth-callback' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      const stateRaw = url.searchParams.get('state');
      const oauthError = url.searchParams.get('error');
      const baseUrl = `${url.protocol}//${url.host}`;

      // `state` carries the client ID, and optionally (see getAuthUrl's
      // `returnTo`) where to send them back afterwards -- the founder's
      // dashboard by default, or a client's own self-service portal if
      // that's where this connection was started from.
      const [stateClientId, returnTo] = (stateRaw || '').split('::');
      const backHref = returnTo && returnTo.startsWith('portal:')
        ? `/client-portal.html?token=${returnTo.slice('portal:'.length)}`
        : '/dashboard';
      const backLabel = backHref.startsWith('/client-portal') ? 'Back to your account' : 'Back to dashboard';

      if (oauthError || !code || !stateClientId) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          simpleHtmlPage(
            'Calendar connection cancelled',
            "Google Calendar wasn't connected -- you can go back and try again.",
            backHref,
            backLabel
          )
        );
      }

      try {
        const tokens = await googleCalendar.exchangeCodeForTokens({ code, baseUrl });
        const existing = db.getClient(stateClientId);
        const connectedEmail = await googleCalendar.getConnectedEmail(tokens.access_token);
        db.updateClient(stateClientId, {
          // Google only sends a refresh_token when access is freshly
          // granted (thanks to prompt=consent, that's every time) -- this
          // fallback just protects against an unexpected missing field.
          googleRefreshToken: tokens.refresh_token || existing?.googleRefreshToken || null,
          googleAccessToken: tokens.access_token,
          googleAccessTokenExpiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
          googleCalendarConnectedAt: new Date().toISOString(),
          googleCalendarEmail: connectedEmail,
          googleCalendarNeedsReconnect: false,
        });
        res.writeHead(302, { location: backHref });
        return res.end();
      } catch (err) {
        console.error('Google Calendar OAuth callback failed:', err);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          simpleHtmlPage(
            'Calendar connection failed',
            'Something went wrong connecting Google Calendar. Go back and try again.',
            backHref,
            backLabel
          )
        );
      }
    }

    // Lets the founder disconnect a client's calendar -- e.g. to reconnect a
    // different Google account, or if a client asks for it to be turned
    // off. Their AI widget falls straight back to collecting details
    // manually, exactly like a client who never connected one at all.
    const googleCalendarDisconnectMatch = pathname.match(/^\/api\/clients\/([^/]+)\/google-calendar\/disconnect$/);
    if (googleCalendarDisconnectMatch && req.method === 'POST') {
      const updated = db.updateClient(googleCalendarDisconnectMatch[1], {
        googleRefreshToken: null,
        googleAccessToken: null,
        googleAccessTokenExpiresAt: null,
        googleCalendarConnectedAt: null,
        googleCalendarEmail: null,
        googleCalendarNeedsReconnect: false,
      });
      if (!updated) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, { disconnected: true });
    }

    // One-click unsubscribe link in every marketing email's footer -- public
    // on purpose, same reason the Stripe webhook and the Google OAuth
    // callback stay public: whoever clicks this has no dashboard login, just
    // the long unguessable token from their own email. Setting
    // marketingOptOut here is what makes the daily agent skip this business
    // for good, not just this one email.
    if (pathname === '/api/marketing/unsubscribe' && req.method === 'GET') {
      const token = url.searchParams.get('token');
      const client = db.setMarketingOptOutByToken(token);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (!client) {
        return res.end(
          simpleHtmlPage(
            'Link not found',
            "This unsubscribe link doesn't look right, or has already been used. If you're still getting emails you don't want, reply to one and let us know.",
            '/',
            'Back to Dispatch AI'
          )
        );
      }
      return res.end(
        simpleHtmlPage(
          "You're unsubscribed",
          `${client.intake?.companyName || 'This business'} won't get any more marketing emails from Dispatch AI.`,
          '/',
          'Back to Dispatch AI'
        )
      );
    }

    // Retell calls this after every real phone call ends, so its actual
    // duration counts toward a client's monthly minutes the same way
    // website-widget chat messages do (see the usage-tracking section
    // above). Public on purpose -- Retell's own servers hit this directly
    // and can't carry the dashboard's Basic Auth header, the same reason
    // /api/stripe/webhook and the Google Calendar callback stay public.
    // Protected instead by a long, unguessable path segment
    // (retellWebhookToken(), derived from RETELL_API_KEY) rather than a
    // login, since only someone who already has this app's Retell key could
    // construct a working URL for it.
    const retellWebhookMatch = pathname.match(/^\/api\/retell\/webhook\/([^/]+)$/);
    if (retellWebhookMatch && req.method === 'POST') {
      if (retellWebhookMatch[1] !== retellWebhookToken()) {
        return sendJson(res, 404, { error: 'not found' });
      }

      const rawBody = await readRawBody(req);
      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON payload' });
      }

      // Only call_ended carries a final duration -- Retell's other webhook
      // events (call_started, call_analyzed) are ignored here so a single
      // call is never counted more than once. NOTE: this reads the payload
      // shape documented at https://docs.retellai.com/api-references as of
      // when this was written -- double-check a real call's payload against
      // their current docs if minute counts ever look off.
      if (payload.event === 'call_ended' && payload.call) {
        const call = payload.call;
        const durationMs =
          call.duration_ms ||
          (call.end_timestamp && call.start_timestamp ? call.end_timestamp - call.start_timestamp : 0);
        const minutes = durationMs > 0 ? Math.ceil(durationMs / 60000) : 0;
        const clientRecord = call.agent_id ? db.getClientByRetellAgentId(call.agent_id) : null;
        if (clientRecord && minutes > 0) {
          await recordUsageMinutes(clientRecord, minutes);
        }
        // Missed-call text-back: if this specific call never actually got
        // through to a conversation (see MISSED_CALL_DISCONNECT_REASONS
        // above), and this client has their own number to text from, send
        // an instant "sorry we missed you" text to the caller -- so a call
        // that genuinely failed doesn't just go cold. Never blocks or
        // delays the webhook response if the text itself fails to send.
        if (
          call.direction === 'inbound' &&
          call.from_number &&
          clientRecord &&
          clientRecord.retellPhoneNumber &&
          MISSED_CALL_DISCONNECT_REASONS.has(call.disconnection_reason)
        ) {
          // Guarantees every real phone call shows up in the "Customer
          // jobs" table, even if the AI never called log_job_request
          // mid-call (a quick question, a wrong number, a missed call).
          // Skipped if a job was already logged DURING this exact call --
          // detected by checking for one created since this call started,
          // which holds for the realistic case of one active call at a
          // time per client's number.
          const callStartIso = call.start_timestamp ? new Date(call.start_timestamp).toISOString() : null;
          const alreadyLoggedThisCall =
            callStartIso && db.listJobsForClient(clientRecord.id).some((j) => j.createdAt >= callStartIso);
          if (!alreadyLoggedThisCall) {
            db.addJob({
              clientId: clientRecord.id,
              source: 'phone call',
              customerPhone: call.from_number || '',
              jobDescription: MISSED_CALL_DISCONNECT_REASONS.has(call.disconnection_reason)
                ? '(Missed call -- no job captured)'
                : '(Call answered -- no further details captured)',
            });            pushJobToServiceM8IfConnected(clientRecord, {
              customerPhone: call.from_number || '',
              jobDescription: MISSED_CALL_DISCONNECT_REASONS.has(call.disconnection_reason)
                ? '(Missed call -- no job captured)'
                : '(Call answered -- no further details captured)',
            });
          }
          const companyName = (clientRecord.intake && clientRecord.intake.companyName) || 'us';
          try {
            await sendSms({
              to: call.from_number,
              from: clientRecord.retellPhoneNumber,
              text: `Sorry we missed you! This is ${companyName} -- reply here or call us back and we'll help right away.`,
            });
          } catch (err) {
            console.error('Missed-call text-back failed:', err.message || err);
          }
        }
        // Log this call for the client-portal analytics dashboard --
        // deliberately a separate, later check rather than touching the
        // missed-call text-back block above, so every real call gets
        // logged here (not just missed ones), while that block above stays
        // untouched.
        if (clientRecord) {
          db.recordCall({
            clientId: clientRecord.id,
            startedAt: call.start_timestamp ? new Date(call.start_timestamp).toISOString() : new Date().toISOString(),
            durationMinutes: minutes,
            disconnectionReason: call.disconnection_reason || null,
            missedCall: MISSED_CALL_DISCONNECT_REASONS.has(call.disconnection_reason),
          });
          // Guarantees every real phone call shows up in the "Customer jobs"
          // table, even if the AI never called log_job_request mid-call (a
          // quick question, a wrong number, a missed call) -- this runs for
          // ALL calls, not just missed ones, which is the whole point.
          // Skipped if a job was already logged for this call -- either by
          // log_job_request mid-call, or by the missed-call block above --
          // detected by checking for one created since this call started,
          // which holds for the realistic case of one active call at a time
          // per client's number.
          const jobCallStartIso = call.start_timestamp ? new Date(call.start_timestamp).toISOString() : null;
          const jobAlreadyLoggedThisCall =
            jobCallStartIso && db.listJobsForClient(clientRecord.id).some((j) => j.createdAt >= jobCallStartIso);
          if (!jobAlreadyLoggedThisCall) {
            db.addJob({
              clientId: clientRecord.id,
              source: 'phone call',
              customerPhone: call.from_number || '',
              jobDescription: MISSED_CALL_DISCONNECT_REASONS.has(call.disconnection_reason)
                ? '(Missed call -- no job captured)'
                : '(Call answered -- no further details captured)',
            });
          }
        }

      }

        return sendJson(res, 200, { received: true });
    }

    // --- Customer self-service: view/cancel/reschedule a booked appointment
    // without calling the business back ----------------------------------
    // Reached by the long, unguessable manageToken texted/emailed to the
    // customer the moment book_appointment confirms a real booking (see
    // executeBookingTool above) -- same "token instead of a login" model
    // used everywhere else in this app a non-business person needs to
    // reach their own record (the client portal, the past-customer
    // portal). Public on purpose: this customer has no account to log
    // into, just the link they were sent.
    const appointmentViewMatch = pathname.match(/^\/api\/appointment\/([^/]+)$/);
    if (appointmentViewMatch && req.method === 'GET') {
      const appt = db.getAppointmentByManageToken(appointmentViewMatch[1]);
      if (!appt) return sendJson(res, 404, { error: 'not found' });
      const clientRecord = db.getClient(appt.clientId);
      return sendJson(res, 200, {
        id: appt.id,
        status: appt.status,
        startAt: appt.startAt,
        endAt: appt.endAt,
        timeZone: appt.timeZone,
        description: appt.description,
        companyName: clientRecord?.intake?.companyName || 'the business',
      });
    }

    const appointmentCancelMatch = pathname.match(/^\/api\/appointment\/([^/]+)\/cancel$/);
    if (appointmentCancelMatch && req.method === 'POST') {
      const appt = db.getAppointmentByManageToken(appointmentCancelMatch[1]);
      if (!appt) return sendJson(res, 404, { error: 'not found' });
      if (appt.status === 'cancelled') return sendJson(res, 200, { status: 'cancelled' });
      const clientRecord = db.getClient(appt.clientId);
      try {
        if (appt.calendarEventId && clientRecord && googleCalendar.isConfigured() && clientRecord.googleRefreshToken) {
          await googleCalendar.cancelAppointment({
            getAccessToken: () => getGoogleAccessToken(clientRecord),
            eventId: appt.calendarEventId,
          });
        }
      } catch (err) {
        console.error(`Appointment cancel (customer link) failed for appointment ${appt.id}:`, err.message || err);
        return sendJson(res, 502, { error: "Couldn't reach the calendar just now. Try again shortly." });
      }
      const cancelledAppt = db.updateAppointment(appt.id, { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: 'customer' });
      if (clientRecord) await notifyBusinessOwnerOfAppointmentChange(clientRecord, cancelledAppt, 'cancelled');
      return sendJson(res, 200, { status: 'cancelled' });
    }

    const appointmentRescheduleMatch = pathname.match(/^\/api\/appointment\/([^/]+)\/reschedule$/);
    if (appointmentRescheduleMatch && req.method === 'POST') {
      const appt = db.getAppointmentByManageToken(appointmentRescheduleMatch[1]);
      if (!appt || appt.status === 'cancelled') return sendJson(res, 404, { error: 'not found' });
      const clientRecord = db.getClient(appt.clientId);
      if (!clientRecord || !googleCalendar.isConfigured() || !clientRecord.googleRefreshToken) {
        return sendJson(res, 400, { error: 'This business’s calendar is not connected right now.' });
      }
      const { date, startTime } = await readBody(req);
      if (!date || !startTime) {
        return sendJson(res, 400, { error: 'A new date and time are both required.' });
      }
      try {
        const durationMinutes = Math.round((new Date(appt.endAt) - new Date(appt.startAt)) / 60000) || 60;
        const result = await googleCalendar.rescheduleAppointment({
          getAccessToken: () => getGoogleAccessToken(clientRecord),
          eventId: appt.calendarEventId,
          date,
          startTime,
          durationMinutes,
          timeZone: appt.timeZone,
        });
        if (result.conflict) {
          return sendJson(res, 200, { conflict: true });
        }
        const updated = db.updateAppointment(appt.id, { startAt: result.startRfc, endAt: result.endRfc });
        await notifyBusinessOwnerOfAppointmentChange(clientRecord, updated, 'rescheduled');
        return sendJson(res, 200, { status: updated.status, startAt: updated.startAt, endAt: updated.endAt });
      } catch (err) {
        console.error(`Appointment reschedule (customer link) failed for appointment ${appt.id}:`, err.message || err);
        return sendJson(res, 502, { error: "Couldn't reach the calendar just now. Try again shortly." });
      }
    }

    // Retell calls this DURING a live phone call whenever the phone agent
    // invokes its check_availability or book_appointment tool (see
    // lib/retellClient.js's createPhoneAgent) -- same real-time Google
    // Calendar logic the website chat widget already uses (executeBookingTool
    // / BOOKING_TOOLS above), just reached from a phone call instead of a
    // chat message. One shared route for both tools since Retell's payload
    // already says which tool it's calling (payload.name) -- executeBookingTool
    // already branches on that same name for the chat-widget path, so there's
    // nothing tool-specific to duplicate here.
    //
    // Public on purpose, same reasoning as /api/retell/webhook above: Retell's
    // own servers hit this mid-call and can't carry the dashboard's Basic
    // Auth header. Protected instead by the same long, unguessable path
    // segment (retellWebhookToken()) already used for that webhook.
    //
    // Always returns 200 with a real (if sometimes "didn't work") result --
    // never a hard error -- so a live call never breaks or goes silent
    // mid-conversation just because this endpoint had trouble; the agent's
    // own instructions (see createPhoneAgent) tell it to fall back to
    // collecting details by hand whenever a tool reports anything other than
    // a clean success.
    const retellToolMatch = pathname.match(/^\/api\/retell\/tools\/([^/]+)$/);
    if (retellToolMatch && req.method === 'POST') {
      if (retellToolMatch[1] !== retellWebhookToken()) {
        return sendJson(res, 404, { error: 'not found' });
      }

      const rawBody = await readRawBody(req);
      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch (err) {
        return sendJson(res, 200, {
          error: true,
          note: "Something went wrong reading that request. Collect the customer's preferred date/time and contact info, and tell them a team member will confirm it.",
        });
      }

      const agentId = payload.call?.agent_id;
      const clientRecord = agentId ? db.getClientByRetellAgentId(agentId) : null;
      if (!clientRecord) {
        return sendJson(res, 200, {
          connected: false,
          note: "Couldn't find this business's account. Collect the customer's preferred date/time and contact info, and tell them a team member will confirm it.",
        });
      }

      const result = await executeBookingTool(payload.name, payload.args || {}, clientRecord, 'phone call');
      return sendJson(res, 200, result);
    }

    // Public hosted-website add-on page -- see renderHostedSitePage above.

    const hostedSiteMatch = pathname.match(/^\/site\/([^/]+)$/);
    if (hostedSiteMatch && req.method === 'GET') {
      const clientRecord = db.getClientByHostedPageSlug(hostedSiteMatch[1]);
      if (!clientRecord || !clientRecord.hostedPageEnabled || clientRecord.status !== 'paid') {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          simpleHtmlPage(
            'Page not found',
            "This page isn't available -- it may have been turned off, or the link is out of date.",
            '/',
            'Go to Dispatch AI'
          )
        );
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(renderHostedSitePage(clientRecord));
    }

    // --- Static files ---------------------------------------------------
    if (req.method === 'GET') {
      return serveStaticFile(req, res, pathname);
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Dispatch AI MVP running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('NOTE: ANTHROPIC_API_KEY is not set -- running in demo/placeholder mode. See .env.example.');
  }
  if (!process.env.DASHBOARD_PASSWORD) {
    console.log('WARNING: DASHBOARD_PASSWORD is not set -- using an insecure default password. Set a real one in Render before sharing this URL.');
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    console.log('NOTE: STRIPE_SECRET_KEY is not set -- payment links will return a demo-mode message instead of real Stripe checkout links.');
  }
  if (!process.env.DATA_DIR) {
    console.log('WARNING: DATA_DIR is not set -- client data is stored on the local filesystem and will be WIPED on every restart, redeploy, or Render free-tier spin-down. See LAUNCH_CHECKLIST.md to fix this with a persistent disk.');
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.log('NOTE: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set -- the dashboard\'s "Connect Google Calendar" button will show a setup message instead of connecting a real calendar. See LAUNCH_CHECKLIST.md.');
  }
  if (!process.env.AGENT_RUN_SECRET) {
    console.log('WARNING: AGENT_RUN_SECRET is not set -- the daily email-marketing agent trigger (/api/internal/agents/email-marketing/run) will reject every request until this is set in Render.');
  }
});
const { placeEmergencyAlertCall } = require('./lib/retellClient');
const serviceM8 = require('./lib/serviceM8Client');

// Pushes a just-logged job into a client's own ServiceM8 account too, if
// they've connected one -- so it shows up in the job-management software
// they already run their business from, not just in Dispatch AI's own
// portal. Deliberately not awaited by its callers: this always runs in the
// background, after the job is already safely saved in Dispatch AI's own
// records, so a slow or failing ServiceM8 call can never delay or break a
// live call, chat, or webhook response.
async function pushJobToServiceM8IfConnected(clientRecord, jobFields) {
  if (!clientRecord || !clientRecord.serviceM8ApiKey) return;
  try {
    const result = await serviceM8.createServiceM8Job(clientRecord.serviceM8ApiKey, jobFields);
    if (!result.success) {
      console.error(`ServiceM8 push failed for client ${clientRecord.id}:`, result.error);
    }
  } catch (err) {
    console.error(`ServiceM8 push failed for client ${clientRecord.id}:`, err.message || err);
  }
}

// --- Autonomous email-marketing agent ---------------------------------------
// Runs once a day (triggered by /api/internal/agents/email-marketing/run,
// see above) against your own client list -- the businesses who signed up
// for Dispatch AI, not their customers. Two situations are handled:
//
//   stalled_draft_reminder -- a signup that started but never finished
//   (status still 'draft' a few days later). Low-risk, so these go out
//   automatically.
//
//   win_back_cancelled -- a former paying client who cancelled a while
//   ago. Higher stakes (easy to come across as pushy to someone who left
//   on purpose), so these are drafted and held here for you to approve
//   from the dashboard instead of sending themselves.
//
// cooldownDays stops either kind being re-drafted for the same business
// every single day the agent runs -- hasRecentMarketingEmail (lib/db.js)
// counts a record from the moment it's created, whatever its final status
// (sent, rejected, or failed), so a rejected win-back email isn't retried
// the very next day either.
const { buildEmailMarketingPrompt, parseEmailMarketingDraft } = require('./lib/emailMarketingPrompt');

const MARKETING_KIND_RULES = {
  stalled_draft_reminder: { autoSend: true, minDaysSince: 3, cooldownDays: 14 },
  win_back_cancelled: { autoSend: false, minDaysSince: 30, cooldownDays: 30 },
};

// Fails CLOSED on purpose: with AGENT_RUN_SECRET unset, every request is
// rejected rather than let through on a missing/guessable secret -- a
// deliberately different default to checkDashboardAuth's insecure-but-
// functional fallback above, since there's no good reason to ever let this
// particular route run without a real secret configured.
function checkAgentRunSecret(req) {
  const expected = process.env.AGENT_RUN_SECRET;
  if (!expected) return false;
  const provided = req.headers['x-agent-secret'];
  if (!provided) return false;
  const providedBuf = Buffer.from(String(provided));
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
}

// Heads-up email for a draft that needs a human look before it sends --
// same reasoning and same silent-no-op-if-unset behaviour as notifyFounder
// above, just worded for this situation instead of a new signup review.
async function notifyFounderOfPendingMarketingEmail({ companyName, kind }) {
  const founderEmail = process.env.FOLLOWUP_REPLY_TO;
  if (!founderEmail) return;
  const kindLabel = kind === 'win_back_cancelled' ? 'a win-back email to a cancelled client' : 'a marketing email';
  try {
    await sendEmail({
      to: founderEmail,
      subject: 'Dispatch AI -- a marketing email needs your approval',
      text: `The daily email-marketing agent drafted ${kindLabel} for "${companyName}" and is holding it for your approval before sending.\n\nReview it in your dashboard: /dashboard`,
      fromName: 'Dispatch AI',
    });
  } catch (err) {
    // Never let a notification failure affect the drafted record itself.
  }
}

// Actually sends one marketing email, always appending a real, working
// unsubscribe link -- generated here in code from a token lazily assigned
// to the client record, never written by the AI itself, so it can never be
// garbled, reworded, or left out by a model that didn't follow the exact
// format asked for. Used both by the agent's own auto-send path and by the
// founder's "Approve" button on a held draft.
async function sendMarketingEmail(clientRecord, record) {
  const contactEmail = clientRecord.intake?.contactEmail;
  if (!contactEmail) {
    return { success: false, demoMode: false, error: 'No contact email on file for this business.' };
  }
  try {
    const unsubClient = db.assignMarketingUnsubscribeToken(clientRecord.id);
    const unsubscribeUrl = `${PUBLIC_BASE_URL}/api/marketing/unsubscribe?token=${unsubClient.marketingUnsubscribeToken}`;
    const fullText = `${record.body}\n\n---\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}`;
    const result = await sendEmail({
      to: contactEmail,
      subject: record.subject || 'A message from Dispatch AI',
      text: fullText,
      fromName: 'Dispatch AI',
    });
    return { success: true, demoMode: !!result.demoMode, error: null };
  } catch (err) {
    return { success: false, demoMode: false, error: err.message || 'Send failed' };
  }
}

async function runEmailMarketingAgent() {
  const summary = { scanned: 0, drafted: 0, autoSent: 0, heldForApproval: 0, skipped: 0, failed: 0 };
  const clients = db.listClients();

  for (const clientRecord of clients) {
    summary.scanned += 1;
    if (clientRecord.marketingOptOut) {
      summary.skipped += 1;
      continue;
    }

    let kind = null;
    if (clientRecord.status === 'draft' && clientRecord.createdAt) {
      const daysSince = (Date.now() - new Date(clientRecord.createdAt).getTime()) / (24 * 60 * 60 * 1000);
      if (daysSince >= MARKETING_KIND_RULES.stalled_draft_reminder.minDaysSince) kind = 'stalled_draft_reminder';
    } else if (clientRecord.status === 'cancelled' && clientRecord.cancelledAt) {
      const daysSince = (Date.now() - new Date(clientRecord.cancelledAt).getTime()) / (24 * 60 * 60 * 1000);
      if (daysSince >= MARKETING_KIND_RULES.win_back_cancelled.minDaysSince) kind = 'win_back_cancelled';
    }
    if (!kind) {
      summary.skipped += 1;
      continue;
    }

    if (!clientRecord.intake?.contactEmail) {
      summary.skipped += 1;
      continue;
    }

    const rules = MARKETING_KIND_RULES[kind];
    if (db.hasRecentMarketingEmail(clientRecord.id, kind, rules.cooldownDays)) {
      summary.skipped += 1;
      continue;
    }

    const { system, messages } = buildEmailMarketingPrompt(clientRecord, kind);
    const result = await callClaude({ system, messages, maxTokens: 300 });
    const draft = result.demoMode
      ? {
          subject: '(placeholder subject -- add a real ANTHROPIC_API_KEY)',
          body: '(AI marketing drafting needs a real ANTHROPIC_API_KEY -- this is a placeholder.)',
        }
      : parseEmailMarketingDraft(result.text);

    if (!draft.body) {
      summary.skipped += 1;
      continue;
    }
    summary.drafted += 1;

    if (rules.autoSend) {
      const record = db.addMarketingEmailDraft({
        clientId: clientRecord.id,
        kind,
        subject: draft.subject,
        body: draft.body,
        status: 'pending_approval',
      });
      const sendResult = await sendMarketingEmail(clientRecord, record);
      db.updateMarketingEmail(record.id, {
        status: sendResult.success ? 'auto_sent' : 'send_failed',
        sentAt: sendResult.success && !sendResult.demoMode ? new Date().toISOString() : null,
        error: sendResult.error || null,
      });
      if (sendResult.success) summary.autoSent += 1;
      else summary.failed += 1;
    } else {
      db.addMarketingEmailDraft({
        clientId: clientRecord.id,
        kind,
        subject: draft.subject,
        body: draft.body,
        status: 'pending_approval',
      });
      await notifyFounderOfPendingMarketingEmail({
        companyName: clientRecord.intake?.companyName || 'a business',
        kind,
      });
      summary.heldForApproval += 1;
    }
  }

  return summary;
}
