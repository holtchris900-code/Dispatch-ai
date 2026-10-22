// lib/emailMarketingPrompt.js
//
// Builds the prompt sent to Claude to draft a marketing/nurture email for a
// given client record, and parses the strict SUBJECT:/BODY: response format
// back out. Mirrors the pattern used by lib/followUpPrompt.js.
//
// Two "kinds" of email are supported:
//   - 'stalled_draft_reminder': a lead who started signing up (status 'draft')
//     but never finished / never went live. Low-risk, friendly nudge.
//   - 'win_back_cancelled': a former paying client who cancelled. Higher
//     stakes (don't want to annoy someone who left for a reason), so these
//     are drafted but held for the founder to approve before sending.
//
// The AI is never allowed to write the unsubscribe line itself -- that is
// always appended programmatically after parsing, so it can never be
// garbled or omitted by the model.

function buildEmailMarketingPrompt(client, kind) {
  const companyName = (client.intake && client.intake.companyName) || 'there';
  const trade = (client.intake && client.intake.trade) || 'home services';
  const contactName = (client.intake && client.intake.contactName) || null;

  let situationText = '';
  if (kind === 'stalled_draft_reminder') {
    situationText =
      `This business (trade: ${trade}) started signing up for Dispatch AI -- an AI phone/chat assistant for home-services ` +
      `businesses that answers calls and website chats, books jobs, and follows up with leads -- but never finished setting ` +
      `up or never went live. Write a short, warm, no-pressure nudge email reminding them they started, reminding them of ` +
      `the 14-day free trial, and inviting them to finish setting up or ask any question they're stuck on. Do not be pushy ` +
      `or use urgency/scarcity language. Do not invent any discount, offer, or deadline that wasn't mentioned here.`;
  } else if (kind === 'win_back_cancelled') {
    situationText =
      `This business (trade: ${trade}) was a paying Dispatch AI client but cancelled their subscription. Write a short, ` +
      `genuinely low-pressure "we'd love to have you back" email. Acknowledge they may have had a good reason to leave, ` +
      `briefly mention what Dispatch AI does (AI phone/chat assistant that answers calls and books jobs for home-services ` +
      `businesses), and invite them to get back in touch if anything's changed or if there was a problem that could be ` +
      `fixed. Do not guilt-trip them, do not invent any discount or offer, and keep it brief.`;
  } else {
    situationText =
      `Write a short, friendly, low-pressure email to this home-services business (trade: ${trade}) about Dispatch AI, ` +
      `an AI phone/chat assistant that answers calls and books jobs. Do not invent any discount, offer, or deadline.`;
  }

  const system =
    `You are writing a short marketing/nurture email on behalf of Dispatch AI, a company that sells an AI phone and ` +
    `chat assistant to home-services businesses (plumbers, electricians, and similar trades). ${situationText} ` +
    `Address the recipient${contactName ? ` as ${contactName}` : ''} if a name is given, otherwise keep the greeting ` +
    `generic and friendly. Keep the whole email under 150 words. Sign off as "The Dispatch AI team". Do not add an ` +
    `unsubscribe line or footer of any kind -- that is handled separately. Respond in EXACTLY this format, nothing ` +
    `before or after:\nSUBJECT: <a short, plain email subject line, no clickbait, no emojis>\nBODY: <the full email ` +
    `body, starting with a greeting and ending with the sign-off>`;

  return {
    system,
    messages: [
      {
        role: 'user',
        content: `Business name: ${companyName}\nKind of email: ${kind}\nWrite the email now.`,
      },
    ],
  };
}

function parseEmailMarketingDraft(text) {
  const str = String(text || '').trim();
  const subjectMatch = str.match(/SUBJECT:\s*(.*)/);
  const subject = subjectMatch ? subjectMatch[1].trim() : null;
  const bodyIdx = str.indexOf('BODY:');
  const body = bodyIdx !== -1 ? str.slice(bodyIdx + 'BODY:'.length).trim() : null;
  return { subject: subject || null, body: body || null };
}

module.exports = { buildEmailMarketingPrompt, parseEmailMarketingDraft };
