// Dispatch AI MVP server.
//
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
const { buildScriptGenerationPrompt, DEMO_SYSTEM_PROMPT } = require('./lib/scriptPrompt');
const { HELP_CHAT_SYSTEM_PROMPT } = require('./lib/helpChatPrompt');
const { buildWidgetChatSystemPrompt } = require('./lib/widgetChatPrompt');
const { buildConversationInsightPrompt, parseConversationInsight } = require('./lib/conversationInsightPrompt');
const { buildFollowUpDraftPrompt, parseFollowUpDraft } = require('./lib/followUpPrompt');
const { buildScriptSafetyCheckPrompt, parseScriptSafetyCheck } = require('./lib/scriptSafetyCheckPrompt');
const { sendEmail } = require('./lib/emailClient');
const { createCheckoutSession, verifyStripeSignature, createPortalSession, getCheckoutSession, createInvoiceItem } = require('./lib/stripeClient');
const { createPhoneAgent, retellWebhookToken } = require('./lib/retellClient');
const googleCalendar = require('./lib/googleCalendarClient');
const { parseCsv } = require('./lib/csv');
const { buildPastCustomerOutreachPrompt, parsePastCustomerOutreach, monthsSince } = require('./lib/pastCustomerOutreachPrompt');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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
// Matches the £0.30-0.35/minute range already promised in the pricing
// page's footnote -- Growth gets the better per-minute rate, consistent
// with it already being the better per-minute deal on its base price too.
const PLAN_OVERAGE_RATE_GBP = { starter: 0.35, growth: 0.3 };
const USAGE_WARNING_THRESHOLD = 0.8;

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
        text: `Hi,\n\nYour Dispatch AI ${planLabel} plan includes ${includedMinutes} call & chat minutes each month. You've used about ${newTotal} of those so far this billing period.\n\nIf you go over, extra minutes are billed automatically at £${rate.toFixed(2)}/minute (the same rate on our pricing page) -- no action needed from you, and your AI agent keeps answering calls and chats without any interruption either way.\n\nWant more minutes included instead? Just reply to this email any time to talk about moving to a higher plan.\n\n-- Dispatch AI`,
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
          text: `Hi,\n\nYour Dispatch AI ${planLabel} plan's ${includedMinutes} monthly call & chat minutes have now been used for this billing period. Your AI agent keeps working exactly as before -- calls and chats are never interrupted -- but minutes beyond your plan are now billed automatically at £${rate.toFixed(2)}/minute, and will appear as a separate line item on your next invoice.\n\nWant more minutes included instead? Just reply to this email any time to talk about moving to a higher plan.\n\n-- Dispatch AI`,
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

async function executeBookingTool(name, input, clientRecord) {
  const timeZone = clientRecord.intake?.timeZone || 'Europe/London';
  const durationMinutes =
    Number(input.durationMinutes) || Number(clientRecord.intake?.appointmentLengthMinutes) || 60;

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
        `Booked automatically by ${companyName}'s Dispatch AI website chat widget.`,
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
      return { connected: true, booked: true };
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
function simpleHtmlPage(title, message, backHref) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Dispatch AI</title>
<link rel="stylesheet" href="/styles.css"></head>
<body><div class="wrap"><section style="padding:60px 0; max-width:520px; margin:0 auto; text-align:center;">
<h1 style="font-size:24px;">${title}</h1>
<p style="color:#4b5563; font-size:15px;">${message}</p>
<a class="btn btn-primary" href="${backHref}" style="display:inline-block; margin-top:16px;">Back to dashboard</a>
</section></div></body></html>`;
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
      const { clientId, messages, conversationId } = await readBody(req);
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
        source: 'website-widget',
        messages: fullTranscript,
      });

      return sendJson(res, 200, { ...result, conversationId: convo.id }, WIDGET_CORS_HEADERS);
    }

    // --- Landing page demo chat widget -----------------------------------
    if (pathname === '/api/chat' && req.method === 'POST') {
      const { messages } = await readBody(req);
      if (!Array.isArray(messages) || messages.length === 0) {
        return sendJson(res, 400, { error: 'messages array is required' });
      }
      const result = await callClaude({ system: DEMO_SYSTEM_PROMPT, messages });
      return sendJson(res, 200, result);
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
        try {
          const safetyPrompt = buildScriptSafetyCheckPrompt(intake, result.text);
          const safetyResult = await callClaude({
            system: safetyPrompt.system,
            messages: safetyPrompt.messages,
            maxTokens: 300,
          });
          const safety = parseScriptSafetyCheck(safetyResult.text);

          if (!safetyResult.demoMode && safety.status === 'SAFE') {
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
          } else {
            updated = db.updateClient(id, {
              reviewMode: 'manual',
              reviewReason:
                safety.reason ||
                "The automatic check couldn't confirm this script was safe to send without a look first.",
            });
            await notifyFounder({ companyName: intake.companyName, reason: updated.reviewReason });
          }
        } catch (err) {
          updated = db.updateClient(id, {
            reviewMode: 'manual',
            reviewReason: 'Something went wrong during the automatic check, so this needs a manual look.',
          });
          await notifyFounder({ companyName: intake.companyName, reason: updated.reviewReason });
        }
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
        return sendJson(res, 200, {
          demoMode: false,
          llmId: clientRecord.retellLlmId,
          agentId: clientRecord.retellAgentId,
        });
      }

      const baseUrl = `${url.protocol}//${url.host}`;
      const result = await createPhoneAgent({
        companyName: clientRecord.intake?.companyName,
        script: clientRecord.script,
        webhookUrl: `${baseUrl}/api/retell/webhook/${retellWebhookToken()}`,
      });

      if (!result.demoMode) {
        db.updateClient(clientRecord.id, {
          retellLlmId: result.llmId,
          retellAgentId: result.agentId,
          retellAgentCreatedAt: new Date().toISOString(),
        });
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

        // Stage 2 of "never let a lead go cold": draft (never send) a
        // follow-up for any unbooked lead we have an email for. Only drafts
        // once -- if the business owner edits it, we don't want to silently
        // overwrite their edits on the next dashboard load.
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

      return sendJson(res, 200, conversations);
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

    const clientGetMatch = pathname.match(/^\/api\/clients\/([^/]+)$/);
    if (clientGetMatch && req.method === 'GET') {
      const clientRecord = db.getClient(clientGetMatch[1]);
      if (!clientRecord) return sendJson(res, 404, { error: 'not found' });
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
      const stateClientId = url.searchParams.get('state');
      const oauthError = url.searchParams.get('error');
      const baseUrl = `${url.protocol}//${url.host}`;

      if (oauthError || !code || !stateClientId) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          simpleHtmlPage(
            'Calendar connection cancelled',
            "Google Calendar wasn't connected -- you can go back to your dashboard and try again.",
            '/dashboard'
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
        res.writeHead(302, { location: '/dashboard' });
        return res.end();
      } catch (err) {
        console.error('Google Calendar OAuth callback failed:', err);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          simpleHtmlPage(
            'Calendar connection failed',
            'Something went wrong connecting Google Calendar. Go back to your dashboard and try again.',
            '/dashboard'
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
      }

      return sendJson(res, 200, { received: true });
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
});
