// A small wrapper around ServiceM8's REST API (developer.servicem8.com), used
// so a client's jobs show up automatically in the job-management software
// they already run their business from, if they've connected it. Each client
// pastes their own personal API key into their portal (see the /service-m8
// portal route in server.js) -- there's no shared app-level credential here,
// unlike Google Calendar, since ServiceM8's API-key mode needs no app
// registration or approval, just a key from the client's own account.

const API_BASE = 'https://api.servicem8.com/api_1.0';

async function serviceM8Request(apiKey, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ServiceM8 API error on ${path} (${res.status}): ${detail}`);
  }
  // ServiceM8 hands back a successful create's new record id in a response
  // header, not the body -- the body itself is empty on a 200 here.
  const recordUuid = res.headers.get('x-record-uuid') || null;
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (err) {
    json = null;
  }
  return { json, recordUuid };
}

// Used by the portal's "Connect ServiceM8" box to confirm a pasted key
// actually works before saving it -- a harmless read-only call.
async function testApiKey(apiKey) {
  try {
    await serviceM8Request(apiKey, '/company.json');
    return true;
  } catch (err) {
    return false;
  }
}

// Pushes one job into the client's own ServiceM8 account as a new company
// (customer) plus a job, so it shows up in the software they already run
// their business from -- not just in Dispatch AI's own portal. Never throws:
// this is always called AFTER a job is already safely saved in Dispatch AI's
// own records, so a ServiceM8 hiccup must never affect a live call or chat,
// and must never stop the job from being logged here either way.
async function createServiceM8Job(apiKey, { customerName, customerPhone, customerEmail, jobDescription, preferredTime } = {}) {
  try {
    const { recordUuid: companyUuid } = await serviceM8Request(apiKey, '/company.json', {
      method: 'POST',
      body: {
        name: customerName || 'Phone enquiry',
        email: customerEmail || '',
        mobile: customerPhone || '',
      },
    });
    if (!companyUuid) return { success: false, error: 'ServiceM8 did not return a new company id' };

    const descriptionParts = [jobDescription || '(No details captured)'];
    if (preferredTime) descriptionParts.push(`Customer's preferred time: ${preferredTime}`);
    const { recordUuid: jobUuid } = await serviceM8Request(apiKey, '/job.json', {
      method: 'POST',
      body: {
        company_uuid: companyUuid,
        status: 'Quote',
        job_description: descriptionParts.join(' -- '),
      },
    });
    if (!jobUuid) return { success: false, error: 'ServiceM8 did not return a new job id' };

    if (customerName || customerPhone || customerEmail) {
      await serviceM8Request(apiKey, '/jobcontact.json', {
        method: 'POST',
        body: {
          job_uuid: jobUuid,
          type: 'JOB',
          first: customerName || '',
          phone: customerPhone || '',
          email: customerEmail || '',
        },
      }).catch(() => {});
    }

    return { success: true, jobUuid, companyUuid };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

module.exports = { testApiKey, createServiceM8Job };
