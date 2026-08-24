// Very small JSON-file "database" for the MVP.
// Good enough to demo and test with; swap for a real database (Postgres,
// SQLite, etc.) once you have real clients and need reliability/concurrency.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// DATA_DIR defaults to a folder inside the project itself, which is fine for
// local testing but does NOT survive Render restarts/redeploys/spin-downs on
// the free tier -- that's exactly what wiped out test clients earlier. Once
// a persistent disk is attached in Render (see LAUNCH_CHECKLIST.md), set
// DATA_DIR to that disk's mount path (e.g. /var/data) as an environment
// variable, and client data will actually survive from then on.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'clients.json');
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');
const PAST_CUSTOMERS_FILE = path.join(DATA_DIR, 'pastCustomers.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readAll() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ clients: [] }, null, 2));
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('clients.json is corrupted, resetting to empty store:', err);
    return { clients: [] };
  }
}

function writeAll(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function listClients() {
  return readAll().clients;
}

function getClient(id) {
  return readAll().clients.find((c) => c.id === id);
}

// Used by the Stripe webhook: subscription lifecycle events (like
// cancellation) reference the Stripe subscription, not our client id, so we
// need to look a client up by the subscription ID we stored on them earlier.
function getClientBySubscriptionId(subscriptionId) {
  return readAll().clients.find((c) => c.stripeSubscriptionId === subscriptionId);
}

// Used by the client-facing past-customer portal: that page is reached by a
// long, unguessable token (see pastCustomerPortalToken on the client
// record), not a login, so every request there needs to resolve back to a
// client from just that token.
function getClientByPastCustomerPortalToken(token) {
  if (!token) return null;
  return readAll().clients.find((c) => c.pastCustomerPortalToken === token);
}

function addClient(client) {
  const data = readAll();
  data.clients.push(client);
  writeAll(data);
  return client;
}

function updateClient(id, updates) {
  const data = readAll();
  const idx = data.clients.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  data.clients[idx] = { ...data.clients[idx], ...updates };
  writeAll(data);
  return data.clients[idx];
}

// --- Website widget conversations ------------------------------------------
// Every conversation a paying client's website widget has with a real
// visitor gets remembered here -- the foundation for showing business owners
// what happened on every chat, and (later) for following up automatically
// with visitors who didn't book. Kept in its own file, same simple JSON-file
// approach as clients.json.

function readConversationsAll() {
  ensureDataDir();
  if (!fs.existsSync(CONVERSATIONS_FILE)) {
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify({ conversations: [] }, null, 2));
  }
  const raw = fs.readFileSync(CONVERSATIONS_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('conversations.json is corrupted, resetting to empty store:', err);
    return { conversations: [] };
  }
}

function writeConversationsAll(data) {
  ensureDataDir();
  fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(data, null, 2));
}

function listConversationsForClient(clientId) {
  return readConversationsAll()
    .conversations.filter((c) => c.clientId === clientId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function getConversation(id) {
  return readConversationsAll().conversations.find((c) => c.id === id);
}

// Called on every widget-chat exchange. The widget always resends its full
// message history (not just the newest message), so we simply store
// whatever it sent plus the new AI reply -- no fragile "append just the
// delta" logic needed. Creates the conversation record on its first message.
function appendConversationTurn({ conversationId, clientId, source, messages }) {
  const data = readConversationsAll();
  const now = new Date().toISOString();
  let convo = conversationId && data.conversations.find((c) => c.id === conversationId);

  if (!convo) {
    convo = {
      id: (conversationId && conversationId.trim()) || crypto.randomUUID(),
      clientId,
      source,
      startedAt: now,
      updatedAt: now,
      messages: [],
      outcome: 'unclassified',
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      summary: null,
      classifiedAt: null,
      followUpSubject: null,
      followUpBody: null,
      followUpStatus: 'none',
      followUpDraftedAt: null,
      followUpApprovedAt: null,
      followUpSentAt: null,
    };
    data.conversations.push(convo);
  }

  convo.messages = messages;
  convo.updatedAt = now;
  // If a visitor picks the conversation back up after it was already
  // reviewed, the old outcome (and any draft/sent follow-up based on it)
  // could now be stale (e.g. they come back and actually book) -- clear it
  // all so it gets looked at again once things go idle. Note: this also
  // clears the record of a follow-up having been sent -- acceptable for an
  // MVP, but worth knowing if you ever go looking for a full send history.
  if (convo.classifiedAt) {
    convo.outcome = 'unclassified';
    convo.classifiedAt = null;
    convo.followUpSubject = null;
    convo.followUpBody = null;
    convo.followUpStatus = 'none';
    convo.followUpDraftedAt = null;
    convo.followUpApprovedAt = null;
    convo.followUpSentAt = null;
  }

  writeConversationsAll(data);
  return convo;
}

function updateConversation(id, updates) {
  const data = readConversationsAll();
  const idx = data.conversations.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  data.conversations[idx] = { ...data.conversations[idx], ...updates };
  writeConversationsAll(data);
  return data.conversations[idx];
}

// --- Past customers (repeat/seasonal-work outreach) ------------------------
// Each paying client can upload a list of their own past customers (via
// their private portal link, public/customer-portal.html) so the AI can
// draft a reminder once enough time has passed since their last service.
// Same simple JSON-file approach as clients.json and conversations.json.

function readPastCustomersAll() {
  ensureDataDir();
  if (!fs.existsSync(PAST_CUSTOMERS_FILE)) {
    fs.writeFileSync(PAST_CUSTOMERS_FILE, JSON.stringify({ pastCustomers: [] }, null, 2));
  }
  const raw = fs.readFileSync(PAST_CUSTOMERS_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('pastCustomers.json is corrupted, resetting to empty store:', err);
    return { pastCustomers: [] };
  }
}

function writePastCustomersAll(data) {
  ensureDataDir();
  fs.writeFileSync(PAST_CUSTOMERS_FILE, JSON.stringify(data, null, 2));
}

function listPastCustomersForClient(clientId) {
  return readPastCustomersAll()
    .pastCustomers.filter((pc) => pc.clientId === clientId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getPastCustomer(id) {
  return readPastCustomersAll().pastCustomers.find((pc) => pc.id === id);
}

// Bulk insert from an uploaded CSV. Each row just needs a name -- everything
// else is optional (though without an email, this customer can be tracked
// but never actually emailed).
function addPastCustomers(clientId, rows) {
  const data = readPastCustomersAll();
  const now = new Date().toISOString();
  const created = rows.map((row) => ({
    id: crypto.randomUUID(),
    clientId,
    name: row.name,
    email: row.email || null,
    phone: row.phone || null,
    serviceType: row.serviceType || null,
    lastServiceDate: row.lastServiceDate || null,
    remindAfterMonths: row.remindAfterMonths || null,
    notes: row.notes || null,
    createdAt: now,
    outreachStatus: 'none',
    outreachSubject: null,
    outreachBody: null,
    outreachDraftedAt: null,
    outreachApprovedAt: null,
    outreachSentAt: null,
  }));
  data.pastCustomers.push(...created);
  writePastCustomersAll(data);
  return created;
}

function updatePastCustomer(id, updates) {
  const data = readPastCustomersAll();
  const idx = data.pastCustomers.findIndex((pc) => pc.id === id);
  if (idx === -1) return null;
  data.pastCustomers[idx] = { ...data.pastCustomers[idx], ...updates };
  writePastCustomersAll(data);
  return data.pastCustomers[idx];
}

module.exports = {
  listClients,
  getClient,
  getClientBySubscriptionId,
  getClientByPastCustomerPortalToken,
  addClient,
  updateClient,
  listConversationsForClient,
  getConversation,
  appendConversationTurn,
  updateConversation,
  listPastCustomersForClient,
  getPastCustomer,
  addPastCustomers,
  updatePastCustomer,
};
