// Very small JSON-file "database" for the MVP.
// Good enough to demo and test with; swap for a real database (Postgres,
// SQLite, etc.) once you have real clients and need reliability/concurrency.

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'clients.json');

function readAll() {
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
