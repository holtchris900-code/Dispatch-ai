// Sends real emails via Resend's HTTP API (https://resend.com), using plain
// `fetch` -- no SDK, consistent with how lib/stripeClient.js and lib/claude.js
// talk to their APIs. Resend was chosen for its simple REST API and a free
// tier (3,000 emails/month) that comfortably covers an MVP's volume.
//
// Sending a real email to a real visitor (not just a test address) requires
// a verified sending domain in Resend, which in turn requires owning a
// domain -- see LAUNCH_CHECKLIST.md. Until RESEND_API_KEY and
// FOLLOWUP_FROM_EMAIL are both set, this falls back to a demo-mode message
// instead of attempting to send, the same pattern used everywhere else in
// this app (Claude, Stripe) when a service isn't configured yet.

const API_URL = 'https://api.resend.com/emails';

async function sendEmail({ to, subject, text, fromName }) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.FOLLOWUP_FROM_EMAIL;

  if (!apiKey || !fromEmail) {
    return {
      demoMode: true,
      message:
        'RESEND_API_KEY and/or FOLLOWUP_FROM_EMAIL are not set yet -- see LAUNCH_CHECKLIST.md to connect a real email service before follow-ups can actually send.',
    };
  }

  const body = {
    from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
    to: [to],
    subject,
    text,
  };

  const replyTo = process.env.FOLLOWUP_REPLY_TO;
  if (replyTo) {
    body.reply_to = replyTo;
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return { demoMode: false, id: data.id };
}

module.exports = { sendEmail };
