// Builds the prompt used to draft (never send) a repeat/seasonal-work
// reminder to one of a business's own PAST customers -- the "reaching out
// to past customers" feature. Different situation from
// lib/followUpPrompt.js (which nudges a website visitor who chatted but
// didn't book): here there's no conversation to reference, just a past job
// and however long it's been since then. The goal is a warm, low-pressure
// "it might be time for your next service" note, not a sales pitch --
// same review-before-anything-goes-out pattern as everywhere else in this
// app, just reviewed by the client themselves on their own private page
// (see public/customer-portal.html) rather than by the founder, since they
// know their own past customers and the founder doesn't.

function monthsSince(dateStr) {
  const then = new Date(dateStr);
  if (isNaN(then.getTime())) return null;
  const now = new Date();
  const months = (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
  return Math.max(0, months);
}

function buildPastCustomerOutreachPrompt(client, pastCustomer) {
  const companyName = client.intake?.companyName || 'the business';
  const script = client.script || '';
  const months = monthsSince(pastCustomer.lastServiceDate);
  const timeAgo =
    months === null ? 'a while' : months === 0 ? 'less than a month' : months === 1 ? '1 month' : `about ${months} months`;

  const system = `You are writing a short, warm email on behalf of ${companyName} to one of their PAST customers, reminding them it might be time for their next service. This is not a sales pitch and not urgent-sounding -- it's a friendly, low-pressure nudge from a business that already knows this customer, the kind of note a well-run local company sends to stay top of mind.

Use the business's own approved script below as your source of truth for services, pricing, and tone -- match how this business actually talks to customers. Don't invent details (pricing, availability, specific services) that aren't in the script.

--- APPROVED SCRIPT FOR ${companyName} ---
${script}
--- END OF APPROVED SCRIPT ---

Customer's name: ${pastCustomer.name || 'unknown -- use a friendly generic greeting like "Hi there"'}
Their last service with this business: ${pastCustomer.serviceType || 'a past service'}, roughly ${timeAgo} ago.
${pastCustomer.notes ? `Extra notes about this customer: ${pastCustomer.notes}` : ''}

Keep the body to 2-4 short sentences. Reference the specific past service if one is known. Make it easy to reply or book, without being pushy. Sign off with the company name, not "AI assistant" or any mention of AI -- the customer should feel like they're hearing from the business itself.

Respond in EXACTLY this format, nothing before or after:
SUBJECT: <a short, plain email subject line, no clickbait>
BODY: <the full email body, starting with a greeting and ending with a sign-off>`;

  return {
    system,
    messages: [{ role: 'user', content: 'Draft the reminder email now.' }],
  };
}

// Same tolerant SUBJECT:/BODY: parsing style used by lib/followUpPrompt.js.
function parsePastCustomerOutreach(text) {
  const str = String(text || '').trim();
  const subjectMatch = str.match(/SUBJECT:\s*(.*)/);
  const subject = subjectMatch ? subjectMatch[1].trim() : null;

  const bodyIdx = str.indexOf('BODY:');
  const body = bodyIdx !== -1 ? str.slice(bodyIdx + 'BODY:'.length).trim() : null;

  return { subject: subject || null, body: body || null };
}

module.exports = { buildPastCustomerOutreachPrompt, parsePastCustomerOutreach, monthsSince };
