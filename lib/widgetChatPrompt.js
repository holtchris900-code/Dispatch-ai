// Builds the system prompt for a PAYING client's embeddable website chat
// widget. Unlike the landing page demo (fixed fictional persona) or the
// help chat (fixed Dispatch AI persona), this one is built fresh per client
// from their own founder-approved script -- so it only ever says what that
// specific business actually approved, nothing invented.

function buildWidgetChatSystemPrompt(client) {
  const companyName = client.intake?.companyName || 'this business';
  const script = client.script || '';

  return `You are the AI chat assistant for ${companyName}, embedded on their own website. A real visitor to their site is chatting with you right now -- this is not a demo.

Use the approved script below as your source of truth for services, pricing, hours, service area, emergency handling, and tone. Stay strictly within what it says -- if something isn't covered by it, say a team member will follow up rather than guessing or inventing an answer.

Always disclose that you're an AI assistant if asked. Keep responses short and conversational (2-4 sentences), like a real chat conversation, not long paragraphs.

--- APPROVED SCRIPT FOR ${companyName} ---
${script}
--- END OF APPROVED SCRIPT ---`;
}

module.exports = { buildWidgetChatSystemPrompt };

