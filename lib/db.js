// Very small JSON-file "database" for the MVP.
// Good enough to demo and test with; swap for a real database (Postgres,
// SQLite, etc.) once you have real clients and need reliability/concurrency.

const fs = require('fs');
const path = require('path');

// DATA_DIR defaults to a folder inside the project itself, which is fine for
// local testing but does NOT survive Render restarts/redeploys/spin-downs on
// the free tier -- that's exactly what wiped out test clients earlier. Once
// a persistent disk is attached in Render (see LAUNCH_CHECKLIST.md), set
// DATA_DIR to that disk's mount path (e.g. /var/data) as an environment
// variable, and client data will actually survive from then on.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'clients.json');

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

module.exports = { listClients, getClient, getClientBySubscriptionId, addClient, updateClient };

