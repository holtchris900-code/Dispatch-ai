// Business verification for a client's own UK phone number.
//
// UK numbers can't just be bought: Ofcom rules mean the phone provider
// (Telnyx) has to check who each number is for before it goes live. Telnyx
// cancels any UK number order that arrives without those details. So each
// client fills in a short form on their account page (business name,
// contact details, address, website, and a photo of their ID or Companies
// House certificate), and this file:
//
//   1. creates their address and uploads their document at Telnyx,
//   2. puts them in a Telnyx "requirement group" (Telnyx's name for a
//      bundle of verification details) and submits it for review,
//   3. orders a UK number tied to that group, and
//   4. checks the order until Telnyx activates it (usually within one
//      working day), then hands the number to Retell so it rings the
//      client's own AI agent.
//
// Steps 1-3 run when the form is submitted (submitVerification +
// orderNumberForClient). Step 4 (checkNumberOrder) is run by server.js on
// a timer and whenever the client opens their account page.
//
// NOTE: written against Telnyx's documented API (requirements,
// requirement_groups, addresses, documents, number_orders). Telnyx
// changes its regulatory forms from time to time, so any requirement this
// code can't recognise is reported back in `missing` -- server.js emails
// the founder so it can be filled in by hand in the Telnyx portal.

const { telnyxRequest } = require('./telnyxClient');
const { areaCodesForPostcode, landlineAreaCode } = require('./ukAreaCodes');

function isConfigured() {
  return !!(process.env.TELNYX_API_KEY && process.env.TELNYX_CONNECTION_ID);
}

// "07700 900123" -> "+447700900123". Leaves anything else as typed.
function toUkE164(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('44')) return `+${digits}`;
  if (digits.startsWith('0')) return `+44${digits.slice(1)}`;
  return digits;
}

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

// Returns an error message for the client, or null if everything needed
// is there.
function validateDetails(d) {
  const required = [
    ['businessName', 'your business name'],
    ['firstName', 'your first name'],
    ['lastName', 'your last name'],
    ['email', 'your email'],
    ['phone', 'your mobile number'],
    ['streetAddress', 'your street address'],
    ['town', 'your town or city'],
    ['postcode', 'your postcode'],
    ['website', 'a link to your business online'],
    ['documentBase64', 'a photo or scan of your ID or Companies House certificate'],
    ['documentFilename', 'a photo or scan of your ID or Companies House certificate'],
  ];
  for (const [key, label] of required) {
    if (!d || !String(d[key] || '').trim()) return `Please add ${label}.`;
  }
  if (!/^https?:\/\/\S+\.\S+/i.test(String(d.website).trim())) {
    return 'Please add the full web link, starting with https:// (your website, Facebook page or Checkatrade profile).';
  }
  const approxBytes = Math.floor(String(d.documentBase64).length * 0.75);
  if (approxBytes > MAX_DOCUMENT_BYTES) return 'That file is too big. Please use a photo or a PDF under 10MB.';
  if (d.proofBase64 && Math.floor(String(d.proofBase64).length * 0.75) > MAX_DOCUMENT_BYTES) {
    return 'Your proof of address file is too big. Please use a photo or a PDF under 10MB.';
  }
  return null;
}

// Telnyx's list of what UK local numbers currently need, as
// { id -> { name, type } }. type is one of textual, address, document.
async function getUkLocalRequirementTypes() {
  const params = new URLSearchParams({
    'filter[country_code]': 'GB',
    'filter[phone_number_type]': 'local',
    'filter[action]': 'ordering',
  });
  const result = await telnyxRequest(`/requirements?${params.toString()}`);
  const types = {};
  for (const requirement of (result && result.data) || []) {
    for (const t of requirement.requirements_types || []) {
      if (t && t.id) types[t.id] = { name: String(t.name || ''), type: String(t.type || '') };
    }
  }
  return types;
}

// Name and type of one requirement, e.g. { name: 'Proof of Address (Recent
// Bill or Invoice)', type: 'document' }.
async function getRequirementType(id, cache) {
  if (cache[id]) return cache[id];
  try {
    const result = await telnyxRequest(`/requirement_types/${encodeURIComponent(id)}`);
    const t = (result && result.data) || result || {};
    cache[id] = { name: String(t.name || ''), type: String(t.type || '') };
  } catch (err) {
    cache[id] = { name: '', type: '' };
  }
  return cache[id];
}

async function getGroup(requirementGroupId) {
  const result = await telnyxRequest(`/requirement_groups/${encodeURIComponent(requirementGroupId)}`);
  return (result && result.data) || result || {};
}

function useCaseText(d) {
  const trade = d.trade ? `${d.trade} ` : '';
  return `This number will be sub-allocated to ${d.businessName.trim()}, a UK ${trade}business (the end user named on this order), for use as their main inbound customer phone line. Calls are answered by an AI receptionist provided by Dispatch AI on their behalf.`;
}

function contactText(d) {
  return `Contact: ${d.firstName.trim()} ${d.lastName.trim()} | Business: ${d.businessName.trim()} | ${d.email.trim()} | ${toUkE164(d.phone)}`;
}

// Works out what to put in one requirement, from its name and type.
// Returns null if it's not one this code recognises.
function valueFor(typeInfo, d, ids) {
  const name = typeInfo.name.toLowerCase();
  const type = typeInfo.type.toLowerCase();
  if (type === 'address') return ids.addressId;
  if (type === 'document') {
    if (/address|bill|invoice|utility|statement/.test(name)) return ids.proofDocumentId || ids.documentId;
    return ids.documentId;
  }
  if (/website|url|web page|webpage/.test(name)) return d.website.trim();
  if (/use case|purpose|usage|how .* used/.test(name)) return useCaseText(d);
  if (/^(business|company) name/.test(name)) return d.businessName.trim();
  if (/contact|name|email/.test(name)) return contactText(d);
  return null;
}

// Steps 1-2. Returns { requirementGroupId, missing: [requirement names] }.
// Throws if Telnyx rejects something (the caller shows a friendly message).
async function submitVerification({ clientId, details: d }) {
  const address = await telnyxRequest('/addresses', {
    method: 'POST',
    body: {
      first_name: d.firstName.trim(),
      last_name: d.lastName.trim(),
      business_name: d.businessName.trim(),
      phone_number: toUkE164(d.phone),
      street_address: d.streetAddress.trim(),
      extended_address: d.addressLine2 ? String(d.addressLine2).trim() : undefined,
      locality: d.town.trim(),
      postal_code: d.postcode.trim().toUpperCase(),
      country_code: 'GB',
      customer_reference: `dispatch-${clientId}`,
    },
  });
  const addressId = address && address.data && address.data.id;

  const base64 = String(d.documentBase64).replace(/^data:[^,]*,/, '');
  const document = await telnyxRequest('/documents', {
    method: 'POST',
    body: { file: base64, filename: String(d.documentFilename).slice(0, 120), customer_reference: `dispatch-${clientId}` },
  });
  const documentId = document && document.data && document.data.id;

  let proofDocumentId = null;
  if (d.proofBase64 && d.proofFilename) {
    const proof = await telnyxRequest('/documents', {
      method: 'POST',
      body: {
        file: String(d.proofBase64).replace(/^data:[^,]*,/, ''),
        filename: String(d.proofFilename).slice(0, 120),
        customer_reference: `dispatch-${clientId}`,
      },
    });
    proofDocumentId = proof && proof.data && proof.data.id;
  }

  const group = await telnyxRequest('/requirement_groups', {
    method: 'POST',
    body: { country_code: 'GB', phone_number_type: 'local', action: 'ordering', customer_reference: `dispatch-${clientId}` },
  });
  const groupData = (group && group.data) || group || {};
  const requirementGroupId = groupData.id;
  if (!requirementGroupId) throw new Error('Telnyx did not return a requirement group id');

  // Fill in exactly the requirements Telnyx put on this group -- read back
  // from the group itself, since those ids are the only ones it accepts.
  // Falls back to Telnyx's general UK list if the group comes back empty.
  const typeCache = {};
  let groupRequirements = groupData.regulatory_requirements || [];
  if (!groupRequirements.length) groupRequirements = (await getGroup(requirementGroupId)).regulatory_requirements || [];
  let neededIds = groupRequirements.map((r) => r.requirement_id).filter(Boolean);
  if (!neededIds.length) {
    const types = await getUkLocalRequirementTypes();
    Object.assign(typeCache, types);
    neededIds = Object.keys(types);
  }

  const values = [];
  const missing = [];
  for (const id of neededIds) {
    const fromGroup = groupRequirements.find((r) => r.requirement_id === id) || {};
    const info = await getRequirementType(id, typeCache);
    if (!info.type && fromGroup.field_type) info.type = String(fromGroup.field_type);
    const value = valueFor(info, d, { addressId, documentId, proofDocumentId });
    if (value) values.push({ requirement_id: id, field_value: String(value) });
    else missing.push(info.name || id);
  }
  console.log(
    `Telnyx requirement group ${requirementGroupId}: filling ${values.length} of ${neededIds.length} requirements` +
      (missing.length ? ` (not filled: ${missing.join('; ')})` : '')
  );

  await telnyxRequest(`/requirement_groups/${encodeURIComponent(requirementGroupId)}`, {
    method: 'PATCH',
    body: { regulatory_requirements: values },
  });

  // Check Telnyx actually kept every value, so an empty group is caught
  // here instead of silently stalling the order.
  const saved = await getGroup(requirementGroupId);
  for (const r of saved.regulatory_requirements || []) {
    if (!r.field_value) {
      const info = await getRequirementType(r.requirement_id, typeCache);
      const label = info.name || r.requirement_id;
      if (!missing.includes(label)) missing.push(label);
    }
  }

  // Pre-approval makes the number activate within minutes once approved.
  let submitError = null;
  try {
    await telnyxRequest(`/requirement_groups/${encodeURIComponent(requirementGroupId)}/submit_for_approval`, { method: 'POST' });
  } catch (err) {
    submitError = err.message || String(err);
    console.error('Telnyx pre-approval submit failed:', submitError);
  }

  return { requirementGroupId, missing, submitError };
}

// Picks a number customers will see as local. Tries, in order: the
// business's own landline area code, their town, the main area codes for
// their postcode, then any UK number. Each step quietly moves on if it
// finds nothing or the search errors.
async function findUkNumber({ town, postcode, phone, serviceArea } = {}) {
  const firstNumber = async (extra, mustStartWith) => {
    const params = new URLSearchParams({ 'filter[country_code]': 'GB', 'filter[phone_number_type]': 'local', 'filter[limit]': '5' });
    for (const [key, value] of Object.entries(extra)) params.set(key, value);
    try {
      const result = await telnyxRequest(`/available_phone_numbers?${params.toString()}`);
      const numbers = ((result && result.data) || []).map((n) => n.phone_number).filter(Boolean);
      return numbers.find((n) => !mustStartWith || n.startsWith(mustStartWith)) || null;
    } catch (err) {
      return null;
    }
  };
  const byAreaCode = (code) => firstNumber({ 'filter[national_destination_code]': code }, `+44${code}`);

  const codes = [];
  const own = landlineAreaCode(phone);
  if (own) codes.push(own);
  const tried = new Set();

  for (const code of codes) {
    tried.add(code);
    const n = await byAreaCode(code);
    if (n) return n;
  }
  if (town) {
    const n = await firstNumber({ 'filter[locality]': town });
    if (n) return n;
  }
  for (const code of [...areaCodesForPostcode(postcode), ...areaCodesForPostcode(serviceArea)]) {
    if (tried.has(code)) continue;
    tried.add(code);
    const n = await byAreaCode(code);
    if (n) return n;
  }
  const fallback = await firstNumber(process.env.TELNYX_NUMBER_LOCALITY ? { 'filter[locality]': process.env.TELNYX_NUMBER_LOCALITY } : {});
  if (fallback) return fallback;
  const anyUk = await firstNumber({});
  if (anyUk) return anyUk;
  throw new Error('No UK numbers available from Telnyx right now');
}

// Step 3. Returns { orderId, phoneNumber }.
async function orderNumberForClient({ clientId, requirementGroupId, town, postcode, phone, serviceArea }) {
  const phoneNumber = await findUkNumber({ town, postcode, phone, serviceArea });
  const order = await telnyxRequest('/number_orders', {
    method: 'POST',
    body: {
      phone_numbers: [{ phone_number: phoneNumber, requirement_group_id: requirementGroupId }],
      connection_id: process.env.TELNYX_CONNECTION_ID,
      customer_reference: `dispatch-${clientId}`,
    },
  });
  const orderId = order && order.data && order.data.id;
  if (!orderId) throw new Error('Telnyx did not return a number order id');
  return { orderId, phoneNumber };
}

// Telnyx's review of the business details. Returns 'approved', 'rejected'
// (declined/expired -- the client needs to send details again) or 'pending'.
async function checkGroupStatus(requirementGroupId) {
  const group = await getGroup(requirementGroupId);
  const status = String(group.status || '').toLowerCase();
  if (status === 'approved') return 'approved';
  if (['declined', 'rejected', 'expired', 'unapproved'].includes(status)) return 'rejected';
  return 'pending';
}

// Step 4. Returns 'pending', 'success' or 'failed'.
async function checkNumberOrder(orderId) {
  const order = await telnyxRequest(`/number_orders/${encodeURIComponent(orderId)}`);
  const status = String((order && order.data && order.data.status) || '').toLowerCase();
  if (status === 'success') return 'success';
  if (['failure', 'failed', 'cancelled', 'canceled', 'deleted'].includes(status)) return 'failed';
  return 'pending';
}

module.exports = {
  isConfigured,
  validateDetails,
  submitVerification,
  orderNumberForClient,
  checkNumberOrder,
  checkGroupStatus,
  toUkE164,
};
