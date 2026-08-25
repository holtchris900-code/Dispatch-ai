// Thin wrapper around Google's OAuth 2.0 and Calendar REST APIs -- no SDK,
// just fetch + Node's built-in Intl (for timezone-correct datetimes),
// consistent with how lib/stripeClient.js and lib/retellClient.js talk to
// their own APIs.
//
// This lets a paying client's AI chat widget check REAL availability and
// create a REAL appointment directly on that client's own Google Calendar,
// instead of just collecting details for someone to confirm later.
//
// Deliberately requests the narrower `calendar.events` + `calendar.freebusy`
// scopes rather than the full `calendar` scope -- this app only ever needs
// to read free/busy status and create events, never touch calendar settings
// or other calendars, and the narrower scopes are also easier for Google to
// verify. See LAUNCH_CHECKLIST.md for the full Google Cloud Console setup.
//
// Like every other integration in this app, this stays a pure API wrapper:
// it doesn't know about client records or how tokens are stored -- the
// caller (server.js) passes in a `getAccessToken()` function and handles
// all persistence itself.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const SCOPE = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function redirectUriFor(baseUrl) {
  return `${baseUrl}/api/google-calendar/oauth-callback`;
}

// Builds the URL to send a business owner to so they can approve calendar
// access for one specific client record. `state` carries that client's ID
// through the redirect so the callback knows whose tokens to save.
// `prompt: consent` + `access_type: offline` together guarantee Google
// returns a refresh token every time, not just on someone's very first
// approval ever.
//
// `returnTo` is optional and lets a caller other than the founder's
// dashboard (specifically: a client's own self-service portal) start this
// same flow and land back where they came from afterwards, instead of
// always bouncing to /dashboard -- encoded into `state` alongside the
// client ID (clientId can never contain "::", so this is a safe delimiter)
// since state is the only thing Google round-trips back to the callback.
function getAuthUrl({ clientId, baseUrl, returnTo }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUriFor(baseUrl),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: returnTo ? `${clientId}::${returnTo}` : clientId,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens({ code, baseUrl }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUriFor(baseUrl),
      grant_type: 'authorization_code',
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, scope, token_type }
}

// Refresh tokens don't expire on their own schedule -- this is called
// whenever a cached access token has (or is about to) expire. Google does
// NOT return a new refresh_token on this grant type, only a fresh access
// token, so the caller keeps using the same refresh_token indefinitely
// until the business owner disconnects or revokes access.
async function refreshAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed (${res.status}): ${await res.text()}`);
  }
  return res.json(); // { access_token, expires_in, scope, token_type } -- no refresh_token here
}

// Purely so the dashboard can show "Connected as owner@gmail.com" instead of
// just a generic "Connected" -- makes it obvious which calendar it actually
// is. Best-effort: returns null rather than throwing if this fails, since
// it's a nice-to-have, not something that should ever block a connection.
async function getConnectedEmail(accessToken) {
  try {
    const res = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.email || null;
  } catch (err) {
    return null;
  }
}

// --- Timezone-safe datetime helpers ----------------------------------------
// Node's Date object always interprets a bare "YYYY-MM-DDTHH:MM" string in
// the SERVER's own timezone, not the client business's -- a real bug risk
// for a server that might run anywhere. Every datetime this file sends to
// Google instead carries its own explicit UTC offset, computed for the
// business's actual IANA timeZone on the specific date involved (so
// daylight saving is handled correctly, including on the two days a year it
// actually changes).

function offsetStringFor(timeZone, atInstantMs) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(atInstantMs));
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  const match = (tzPart?.value || 'GMT').match(/GMT([+-]\d{2}:\d{2})?/);
  return (match && match[1]) || '+00:00';
}

// Combines a "YYYY-MM-DD" + "HH:MM" as understood in `timeZone` into a full
// RFC3339 string with an explicit offset, e.g. "2026-08-24T14:00:00+01:00".
// The offset is resolved by treating the wall-clock time as a rough UTC
// guess just to land on the right calendar date/season -- accurate except
// within the one ambiguous or skipped hour on the two days a year clocks
// actually change, which is an inherent ambiguity in any calendar system
// (Google's own UI has the same edge case), not something worth solving for
// a home services booking widget.
function toRfc3339(dateStr, timeStr, timeZone) {
  const roughInstantMs = Date.parse(`${dateStr}T${timeStr}:00Z`);
  const offset = offsetStringFor(timeZone, roughInstantMs);
  return `${dateStr}T${timeStr}:00${offset}`;
}

// Adds real elapsed minutes to an RFC3339-with-offset string and re-expresses
// the result in the same timeZone. Unlike toRfc3339, this always has a real,
// unambiguous instant to work from (no guessing), so it stays correct even
// when the added duration crosses a daylight-saving change.
function addMinutesRfc3339(rfc3339, minutes, timeZone) {
  const instantMs = new Date(rfc3339).getTime() + minutes * 60000;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(instantMs).map((p) => [p.type, p.value]));
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const timeStr = `${parts.hour}:${parts.minute}`;
  const offset = offsetStringFor(timeZone, instantMs);
  return `${dateStr}T${timeStr}:00${offset}`;
}

// --- Live calendar operations ----------------------------------------------
// Both take a `getAccessToken()` async function rather than a raw token, so
// the caller decides how to fetch/refresh/persist it -- this file stays a
// pure API wrapper with no knowledge of how clients or their tokens are
// stored.

async function checkAvailability({ getAccessToken, date, startTime, durationMinutes, timeZone }) {
  const accessToken = await getAccessToken();
  const startRfc = toRfc3339(date, startTime, timeZone);
  const endRfc = addMinutesRfc3339(startRfc, durationMinutes, timeZone);

  const res = await fetch(`${CALENDAR_API}/freeBusy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ timeMin: startRfc, timeMax: endRfc, items: [{ id: 'primary' }] }),
  });
  if (!res.ok) {
    throw new Error(`Google Calendar freeBusy check failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  const busy = data.calendars?.primary?.busy || [];
  return { free: busy.length === 0, busy, startRfc, endRfc };
}

// Re-checks availability immediately before writing the event (a cheap,
// best-effort defense against two simultaneous chats booking the same slot
// -- not a real lock, but worthwhile insurance for a single shared calendar
// on an MVP). Returns { booked:false, conflict:true } rather than throwing
// if that last-second check finds it's no longer free.
async function createAppointment({ getAccessToken, date, startTime, durationMinutes, timeZone, summary, description }) {
  const accessToken = await getAccessToken();
  const startRfc = toRfc3339(date, startTime, timeZone);
  const endRfc = addMinutesRfc3339(startRfc, durationMinutes, timeZone);

  const freeBusyRes = await fetch(`${CALENDAR_API}/freeBusy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ timeMin: startRfc, timeMax: endRfc, items: [{ id: 'primary' }] }),
  });
  if (freeBusyRes.ok) {
    const freeBusyData = await freeBusyRes.json();
    const busy = freeBusyData.calendars?.primary?.busy || [];
    if (busy.length > 0) {
      return { booked: false, conflict: true };
    }
  }
  // If the re-check itself fails to reach Google, fall through and attempt
  // the booking anyway rather than blocking a customer over a transient
  // read error -- the write below still fails loudly if something's
  // seriously wrong.

  const res = await fetch(`${CALENDAR_API}/calendars/primary/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      summary,
      description,
      start: { dateTime: startRfc, timeZone },
      end: { dateTime: endRfc, timeZone },
    }),
  });
  if (!res.ok) {
    throw new Error(`Google Calendar event creation failed (${res.status}): ${await res.text()}`);
  }
  const event = await res.json();
  return { booked: true, eventId: event.id, htmlLink: event.htmlLink };
}

module.exports = {
  isConfigured,
  getAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getConnectedEmail,
  checkAvailability,
  createAppointment,
};
