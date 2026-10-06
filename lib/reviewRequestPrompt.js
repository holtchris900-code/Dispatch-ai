// Builds the prompt used to draft a short review-request message to one of
// a business's own PAST customers, after a completed job -- separate from
// lib/pastCustomerOutreachPrompt.js (which nudges someone it might be time
// for their NEXT service): this message has one job, asking for a review,
// and nothing else. Short on purpose -- it's usually sent as a text message
// (see server.js's outreach/send route), not an email, so it needs to read
// well in a couple of sentences. Uses the exact same SUBJECT:/BODY: output
// format as buildPastCustomerOutreachPrompt so the existing parsing
// (parsePastCustomerOutreach) and the existing draft/edit/approve/send UI
// in public/customer-portal.html can be reused as-is -- SUBJECT ends up
// unused when this goes out by text, but keeps one shared format either way.

function buildReviewRequestPrompt(client, pastCustomer) {
  const companyName = client.intake?.companyName || 'the business';
  const script = client.script || '';
  const reviewLink = client.reviewLink || null;

  const system = `You are writing a short, warm message on behalf of ${companyName}, asking a customer whose job was just completed to leave a review. This is not a sales pitch -- it's a quick, genuine thank-you with a simple ask, the kind of message a well-run local company sends right after finishing a job.

Use the business's own approved script below only for tone -- don't invent services, pricing, or policy details from it, this message isn't about any of that.

--- APPROVED SCRIPT FOR ${companyName} (for tone only) ---
${script}
--- END OF APPROVED SCRIPT ---

Customer's name: ${pastCustomer.name || 'unknown -- use a friendly generic greeting like "Hi there"'}
Their service: ${pastCustomer.serviceType || 'a recent service'}.
${reviewLink ? `Review link to include exactly as given: ${reviewLink}` : 'No review link is on file yet -- just ask for a review in general terms, without a link.'}

Keep the BODY to 2-3 short sentences, suitable for a text message (not an email). Thank them, ask for a review, and include the review link if one was given. Sign off with the company name, not "AI assistant" or any mention of AI.

Respond in EXACTLY this format, nothing before or after:
SUBJECT: <a short label, not actually used when this goes out as a text -- just keep it brief>
BODY: <the full message, ready to send as-is>`;

  return {
    system,
    messages: [{ role: 'user', content: 'Draft the review-request message now.' }],
  };
}

module.exports = { buildReviewRequestPrompt };
