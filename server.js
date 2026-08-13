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
const { createCheckoutSession, verifyStripeSignature, createPortalSession, getCheckoutSession } = require('./lib/stripeClient');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

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

      const updated = db.updateClient(id, {
        status: 'draft',
        script: result.text,
        demoMode: result.demoMode,
      });

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

