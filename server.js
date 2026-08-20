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
const { createCheckoutSession, verifyStripeSignature, createPortalSession, getCheckoutSession } = require('./lib/stripeClient');
const { createPhoneAgent } = require('./lib/retellClient');

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
      const result = await callClaude({ system, messages });

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

      const result = await createPhoneAgent({
        companyName: clientRecord.intake?.companyName,
        script: clientRecord.script,
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
});
