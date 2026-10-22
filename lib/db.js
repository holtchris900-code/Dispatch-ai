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
const DEMO_AGENT_FILE = path.join(DATA_DIR, 'demoAgent.json');
const CALLS_FILE = path.join(DATA_DIR, 'calls.json');


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

// Used by the Retell webhook: call-ended events reference the Retell agent,
// not our client id, so we need to look a client up by the agent ID we
// stored on them earlier (same pattern as getClientBySubscriptionId, just
// for phone calls instead of billing).
function getClientByRetellAgentId(agentId) {
  return readAll().clients.find((c) => c.retellAgentId === agentId);
}

// --- Client self-service portal (magic-link login) --------------------------
// Lets a paying (or previously-paying) client log into their own account
// instead of a founder generating and sending them a link every time. No
// passwords: a client requests a login by email, gets a one-click emailed
// link built from a short-lived clientLoginToken, and that link hands them a
// longer-lived clientPortalToken -- the same "long unguessable token instead
// of a login" model already used for the past-customer portal, just reached
// via an emailed link the first time instead of one a founder sends by hand.

// Only clients who have ever actually subscribed (paid or cancelled -- not
// still-draft signups with nothing to manage yet) can request a login, and
// only by the exact contact email they signed up with.
function getClientByContactEmail(email) {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return readAll().clients.find(
    (c) =>
      (c.status === 'paid' || c.status === 'cancelled') &&
      c.intake?.contactEmail &&
      c.intake.contactEmail.trim().toLowerCase() === normalized
  );
}

function getClientByLoginToken(token) {
  if (!token) return null;
  return readAll().clients.find((c) => c.clientLoginToken === token);
}

function getClientByPortalToken(token) {
  if (!token) return null;
  return readAll().clients.find((c) => c.clientPortalToken === token);
}

// --- Hosted website add-on ---------------------------------------------------
// A client without their own website (or whose website won't allow adding
// the chat widget) can turn this on to get a simple one-page site hosted on
// this app's own domain instead, at /site/<slug>.

function getClientByHostedPageSlug(slug) {
  if (!slug) return null;
  return readAll().clients.find((c) => c.hostedPageSlug === slug);
}

function slugify(str) {
  const cleaned = String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'business';
}

// Assigns a unique slug derived from the company name, reusing the existing
// one if this client already has one. Done as a single read-modify-write
// (not "compute a slug, then separately save it") so two clients enabling
// this at the same instant can never collide on the same slug.
function assignHostedPageSlug(clientId, companyName) {
  const data = readAll();
  const client = data.clients.find((c) => c.id === clientId);
  if (!client) return null;
  if (client.hostedPageSlug) return client;

  const base = slugify(companyName);
  let slug = base;
  let n = 2;
  while (data.clients.some((c) => c.hostedPageSlug === slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  client.hostedPageSlug = slug;
  writeAll(data);
  return client;
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
// --- Phone call history (client-portal analytics dashboard) ---------------
// Every real phone call Retell reports back on (see server.js's
// /api/retell/webhook/:token) gets a lightweight record here -- just enough
// to chart call volume and missed-call rate over time. Separate from the
// running usageMinutesThisPeriod total on the client record itself (that's
// still what billing/overage uses); this is purely for the dashboard's
// history and trend charts. Same simple JSON-file approach as
// conversations.json and pastCustomers.json.

function readCallsAll() {
  ensureDataDir();
  if (!fs.existsSync(CALLS_FILE)) {
    fs.writeFileSync(CALLS_FILE, JSON.stringify({ calls: [] }, null, 2));
  }
  const raw = fs.readFileSync(CALLS_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('calls.json is corrupted, resetting to empty store:', err);
    return { calls: [] };
  }
}

function writeCallsAll(data) {
  ensureDataDir();
  fs.writeFileSync(CALLS_FILE, JSON.stringify(data, null, 2));
}

function listCallsForClient(clientId) {
  return readCallsAll()
    .calls.filter((c) => c.clientId === clientId)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

// Called once per real call from the Retell webhook. missedCall is already
// decided by the caller (based on Retell's own disconnection_reason), kept
// as a plain boolean here rather than re-deriving it, so this file doesn't
// need to know anything about Retell's specific reason codes.
function recordCall({ clientId, startedAt, durationMinutes, disconnectionReason, missedCall }) {
  const data = readCallsAll();
  const record = {
    id: crypto.randomUUID(),
    clientId,
    startedAt: startedAt || new Date().toISOString(),
    durationMinutes: durationMinutes || 0,
    disconnectionReason: disconnectionReason || null,
    missedCall: !!missedCall,
  };
  data.calls.push(record);
  writeCallsAll(data);
  return record;
}


// --- Live voice demo agent (landing-page "talk to it live" button) --------
// The browser voice demo (see server.js's /api/demo/voice-agent and
// public/index.html) uses ONE persistent Retell agent built from the same
// fixed demo persona as the text-chat demo, created lazily the very first
// time anyone tries it and reused forever after -- never recreated per
// visitor, per call, or per server restart, so this is cached here exactly
// like everything else in this file instead of living only in memory.
function getDemoAgent() {
  ensureDataDir();
  if (!fs.existsSync(DEMO_AGENT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(DEMO_AGENT_FILE, 'utf-8'));
  } catch (err) {
    console.error('demoAgent.json is corrupted, ignoring cached demo agent:', err);
    return null;
  }
}

function saveDemoAgent(agent) {
  ensureDataDir();
  fs.writeFileSync(DEMO_AGENT_FILE, JSON.stringify(agent, null, 2));
  return agent;
}

module.exports = {
  listClients,
  getClient,
  getClientBySubscriptionId,
  getClientByRetellAgentId,
  getClientByPastCustomerPortalToken,
  getClientByContactEmail,
  getClientByLoginToken,
  getClientByPortalToken,
  getClientByHostedPageSlug,
  assignHostedPageSlug,
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
  getDemoAgent,
  saveDemoAgent,
  listCallsForClient,
  recordCall,
};
// --- Emergency alert briefing agent (outbound AI call when something's
// flagged urgent) -----------------------------------------------------------
// One persistent Retell agent, shared across every client, that calls a
// client's own on-call number and briefs them on a flagged emergency --
// created lazily the first time any client's flag_emergency ever fires, and
// reused forever after, exactly like the live voice demo agent above.
const EMERGENCY_ALERT_AGENT_FILE = path.join(DATA_DIR, 'emergencyAlertAgent.json');

function getEmergencyAlertAgent() {
  ensureDataDir();
  if (!fs.existsSync(EMERGENCY_ALERT_AGENT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(EMERGENCY_ALERT_AGENT_FILE, 'utf-8'));
  } catch (err) {
    console.error('emergencyAlertAgent.json is corrupted, ignoring cached alert agent:', err);
    return null;
  }
}

function saveEmergencyAlertAgent(agent) {
  ensureDataDir();
  fs.writeFileSync(EMERGENCY_ALERT_AGENT_FILE, JSON.stringify(agent, null, 2));
  return agent;
}

module.exports.getEmergencyAlertAgent = getEmergencyAlertAgent;
module.exports.saveEmergencyAlertAgent = saveEmergencyAlertAgent;
// --- Customer jobs (the editable "job list" on the client portal) --------
// Every time the AI learns what job a real caller/chatter wants done AND
// has at least one way to reach them -- see server.js's log_job_request
// tool -- it gets saved here, whether or not it turns into a booked
// calendar appointment. This is what the client portal's "Customer jobs"
// table reads and edits. Same simple JSON-file approach as everything else
// in this file.
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

function readJobsAll() {
  ensureDataDir();
  if (!fs.existsSync(JOBS_FILE)) {
    fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [] }, null, 2));
  }
  const raw = fs.readFileSync(JOBS_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('jobs.json is corrupted, resetting to empty store:', err);
    return { jobs: [] };
  }
}

function writeJobsAll(data) {
  ensureDataDir();
  fs.writeFileSync(JOBS_FILE, JSON.stringify(data, null, 2));
}

function listJobsForClient(clientId) {
  return readJobsAll()
    .jobs.filter((j) => j.clientId === clientId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function addJob({ clientId, source, customerName, customerPhone, customerEmail, jobDescription, preferredTime }) {
  const data = readJobsAll();
  const job = {
    id: crypto.randomUUID(),
    clientId,
    createdAt: new Date().toISOString(),
    source: source || 'unknown',
    customerName: customerName || '',
    customerPhone: customerPhone || '',
    customerEmail: customerEmail || '',
    jobDescription: jobDescription || '',
    preferredTime: preferredTime || '',
    status: 'new',
    notes: '',
  };
  data.jobs.push(job);
  writeJobsAll(data);
  return job;
}

// Used by the client portal's editable jobs table -- a business owner can
// correct a misheard name/number, change the status, or add their own
// notes, directly from their portal. The route in server.js is what checks
// this job id actually belongs to the client making the request; this
// function itself just finds the row by id, same division of
// responsibility as every other write in this file.
function updateJob(id, updates) {
  const data = readJobsAll();
  const idx = data.jobs.findIndex((j) => j.id === id);
  if (idx === -1) return null;
  data.jobs[idx] = { ...data.jobs[idx], ...updates };
  writeJobsAll(data);
  return data.jobs[idx];
}

module.exports.listJobsForClient = listJobsForClient;
module.exports.addJob = addJob;
module.exports.updateJob = updateJob;

// --- Confirmed appointments (in-app calendar + cancel/reschedule) ---------
// book_appointment (server.js) writes one of these every time it actually
// locks in a real slot on the business's Google Calendar -- this is what
// lets the client portal show a real upcoming-appointments list instead of
// only the free-text "preferred time" on a job request, and what lets a
// cancel/reschedule button (from the portal, from the customer's own
// manage-appointment link, or from the AI itself mid-call) find the right
// one to act on. Same simple JSON-file approach as everything else in this
// file. calendarEventId is the Google Calendar event this maps to, so a
// cancel/reschedule here can also update the real calendar, not just this
// record.
const APPOINTMENTS_FILE = path.join(DATA_DIR, 'appointments.json');

function readAppointmentsAll() {
  ensureDataDir();
  if (!fs.existsSync(APPOINTMENTS_FILE)) {
    fs.writeFileSync(APPOINTMENTS_FILE, JSON.stringify({ appointments: [] }, null, 2));
  }
  const raw = fs.readFileSync(APPOINTMENTS_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('appointments.json is corrupted, resetting to empty store:', err);
    return { appointments: [] };
  }
}

function writeAppointmentsAll(data) {
  ensureDataDir();
  fs.writeFileSync(APPOINTMENTS_FILE, JSON.stringify(data, null, 2));
}

// Everything not cancelled and not already in the past, soonest first --
// exactly what the client portal's "Upcoming appointments" list and the
// customer's own manage-appointment page both want.
function listUpcomingAppointmentsForClient(clientId) {
  const nowMs = Date.now();
  return readAppointmentsAll()
    .appointments.filter((a) => a.clientId === clientId && a.status !== 'cancelled' && new Date(a.startAt).getTime() >= nowMs)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
}

function getAppointmentById(id) {
  return readAppointmentsAll().appointments.find((a) => a.id === id);
}

// Reached by the long, unguessable link texted/emailed to the customer when
// their appointment is booked (see server.js's book_appointment handling) --
// same "token instead of a login" model used everywhere else a non-business
// person needs to reach their own record without an account.
function getAppointmentByManageToken(token) {
  if (!token) return null;
  return readAppointmentsAll().appointments.find((a) => a.manageToken === token);
}

// Used when the AI itself needs to reschedule/cancel an appointment mid-call
// or mid-chat: the customer only has a phone number to give, not a token or
// an id, so this finds their soonest still-upcoming confirmed appointment
// with this business by that phone number alone. Exact-match on the phone
// string as given (same level of simplicity as the rest of this file --
// no attempt to normalize different phone formats against each other).
function findUpcomingAppointmentByPhone(clientId, phone) {
  if (!phone) return null;
  const nowMs = Date.now();
  const matches = readAppointmentsAll()
    .appointments.filter(
      (a) => a.clientId === clientId && a.customerPhone === phone && a.status === 'confirmed' && new Date(a.startAt).getTime() >= nowMs
    )
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  return matches[0] || null;
}

function addAppointment({ clientId, customerName, customerPhone, customerEmail, startAt, endAt, timeZone, description, calendarEventId, source }) {
  const data = readAppointmentsAll();
  const appt = {
    id: crypto.randomUUID(),
    clientId,
    createdAt: new Date().toISOString(),
    source: source || 'unknown',
    customerName: customerName || '',
    customerPhone: customerPhone || '',
    customerEmail: customerEmail || '',
    startAt,
    endAt,
    timeZone: timeZone || 'Europe/London',
    description: description || '',
    calendarEventId: calendarEventId || null,
    status: 'confirmed',
    manageToken: crypto.randomBytes(24).toString('hex'),
    cancelledAt: null,
    cancelledBy: null,
  };
  data.appointments.push(appt);
  writeAppointmentsAll(data);
  return appt;
}

// Used for both a reschedule (new startAt/endAt) and a cancel (status +
// cancelledAt/cancelledBy) -- the route in server.js is what checks an
// appointment id actually belongs to the client/customer making the
// request; this function itself just finds the row by id, same division of
// responsibility as updateJob above.
function updateAppointment(id, updates) {
  const data = readAppointmentsAll();
  const idx = data.appointments.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  data.appointments[idx] = { ...data.appointments[idx], ...updates };
  writeAppointmentsAll(data);
  return data.appointments[idx];
}

module.exports.listUpcomingAppointmentsForClient = listUpcomingAppointmentsForClient;
module.exports.getAppointmentById = getAppointmentById;
module.exports.getAppointmentByManageToken = getAppointmentByManageToken;
module.exports.findUpcomingAppointmentByPhone = findUpcomingAppointmentByPhone;
module.exports.addAppointment = addAppointment;
module.exports.updateAppointment = updateAppointment;

// --- Email marketing agent (autonomous nurture/win-back emails) -----------
// The daily email-marketing agent (see server.js's runEmailMarketingAgent)
// scans your own client list -- businesses who signed up for Dispatch AI --
// for two situations: a signup who started but never finished ("stalled
// draft"), and a paying client who cancelled ("win-back"). It drafts a short
// email for each one via Claude, then either sends it straight away (the
// low-risk stalled-draft nudge) or holds it here for you to approve first
// (the higher-stakes win-back email) -- see the "pending_approval" status
// below. Same simple JSON-file approach as everything else in this file.
const MARKETING_EMAILS_FILE = path.join(DATA_DIR, 'marketingEmails.json');

function readMarketingEmailsAll() {
  ensureDataDir();
  if (!fs.existsSync(MARKETING_EMAILS_FILE)) {
    fs.writeFileSync(MARKETING_EMAILS_FILE, JSON.stringify({ marketingEmails: [] }, null, 2));
  }
  const raw = fs.readFileSync(MARKETING_EMAILS_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('marketingEmails.json is corrupted, resetting to empty store:', err);
    return { marketingEmails: [] };
  }
}

function writeMarketingEmailsAll(data) {
  ensureDataDir();
  fs.writeFileSync(MARKETING_EMAILS_FILE, JSON.stringify(data, null, 2));
}

// Most-recent-first, for the dashboard's "recent activity" log.
function listMarketingEmails() {
  return readMarketingEmailsAll().marketingEmails.sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
}

function listPendingMarketingEmails() {
  return readMarketingEmailsAll()
    .marketingEmails.filter((m) => m.status === 'pending_approval')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function getMarketingEmailById(id) {
  return readMarketingEmailsAll().marketingEmails.find((m) => m.id === id);
}

// Used by the agent before drafting anything, so it never nudges the same
// client twice in a short window (e.g. every day it runs) regardless of
// whether that earlier draft was auto-sent, approved, or even rejected --
// a rejected win-back email shouldn't be re-drafted the very next day either.
function hasRecentMarketingEmail(clientId, kind, sinceDays) {
  const cutoffMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  return readMarketingEmailsAll().marketingEmails.some(
    (m) => m.clientId === clientId && m.kind === kind && new Date(m.createdAt).getTime() >= cutoffMs
  );
}

// status is one of: 'pending_approval' (waiting on the founder),
// 'auto_sent' (low-risk kind, sent immediately), 'sent' (a pending one the
// founder approved), 'rejected' (the founder said no), 'send_failed'
// (approved/auto-send attempted but the actual email send errored).
function addMarketingEmailDraft({ clientId, kind, subject, body, status }) {
  const data = readMarketingEmailsAll();
  const record = {
    id: crypto.randomUUID(),
    clientId,
    kind,
    subject: subject || null,
    body: body || null,
    status: status || 'pending_approval',
    createdAt: new Date().toISOString(),
    sentAt: null,
    approvedAt: null,
    rejectedAt: null,
    error: null,
  };
  data.marketingEmails.push(record);
  writeMarketingEmailsAll(data);
  return record;
}

function updateMarketingEmail(id, updates) {
  const data = readMarketingEmailsAll();
  const idx = data.marketingEmails.findIndex((m) => m.id === id);
  if (idx === -1) return null;
  data.marketingEmails[idx] = { ...data.marketingEmails[idx], ...updates };
  writeMarketingEmailsAll(data);
  return data.marketingEmails[idx];
}

// Lazily assigns a long unguessable unsubscribe token to a client record,
// reusing the existing one if it already has one -- same single
// read-modify-write pattern as assignHostedPageSlug above, so two marketing
// emails queued for the same client at once can't end up with two different
// tokens.
function assignMarketingUnsubscribeToken(clientId) {
  const data = readAll();
  const client = data.clients.find((c) => c.id === clientId);
  if (!client) return null;
  if (client.marketingUnsubscribeToken) return client;
  client.marketingUnsubscribeToken = crypto.randomBytes(24).toString('hex');
  writeAll(data);
  return client;
}

// Reached by the one-click unsubscribe link in every marketing email's
// footer -- no login, same "long token instead of an account" model used
// throughout this file. Sets marketingOptOut so the agent skips this client
// from then on, and returns the client so the route can show their company
// name on the confirmation page.
function getClientByMarketingUnsubscribeToken(token) {
  if (!token) return null;
  return readAll().clients.find((c) => c.marketingUnsubscribeToken === token);
}

function setMarketingOptOutByToken(token) {
  const data = readAll();
  const client = data.clients.find((c) => c.marketingUnsubscribeToken === token);
  if (!client) return null;
  client.marketingOptOut = true;
  writeAll(data);
  return client;
}

module.exports.listMarketingEmails = listMarketingEmails;
module.exports.listPendingMarketingEmails = listPendingMarketingEmails;
module.exports.getMarketingEmailById = getMarketingEmailById;
module.exports.hasRecentMarketingEmail = hasRecentMarketingEmail;
module.exports.addMarketingEmailDraft = addMarketingEmailDraft;
module.exports.updateMarketingEmail = updateMarketingEmail;
module.exports.assignMarketingUnsubscribeToken = assignMarketingUnsubscribeToken;
module.exports.getClientByMarketingUnsubscribeToken = getClientByMarketingUnsubscribeToken;
module.exports.setMarketingOptOutByToken = setMarketingOptOutByToken;
