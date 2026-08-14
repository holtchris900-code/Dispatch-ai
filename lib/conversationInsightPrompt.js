// Builds the prompt used to review a single website-widget conversation
// after it's gone idle, so the business owner can see -- without reading
// every transcript themselves -- whether it turned into a booking, a lead
// that didn't convert, a simple answered question, or something unclear.
// This is Stage 1 of the "never let a lead go cold" feature: remember and
// tag every conversation. Stages 2+ (drafting and sending an actual
// follow-up message to unbooked leads) build on top of this later.

function buildConversationInsightPrompt(client, messages) {
  const companyName = client.intake?.companyName || 'this business';
  const transcriptText = messages
    .map((m) => `${m.role === 'user' ? 'Visitor' : 'AI'}: ${m.content}`)
    .join('\n');

  const system = `You are reviewing a finished website chat conversation between a visitor and ${companyName}'s AI chat assistant, on behalf of the business owner. Your job is to summarize what happened so they don't have to read the full transcript themselves.

Respond in EXACTLY this format, with nothing before or after it and no extra commentary:
OUTCOME: <one of: booked, unbooked_lead, resolved_question, unclear>
NAME: <the visitor's name if they gave one, otherwise "none">
EMAIL: <the visitor's email address if they gave one, otherwise "none">
PHONE: <the visitor's phone number if they gave one, otherwise "none">
SUMMARY: <one short sentence, in plain English, summarizing what the visitor wanted and what happened>

Definitions:
- booked: the AI confirmed an appointment, job, or callback, or clearly said the visitor would be scheduled.
- unbooked_lead: the visitor showed real interest (asked about pricing, availability, or described a specific problem) but the conversation ended without a confirmed booking.
- resolved_question: the visitor only asked a general question (hours, service area, what's offered, etc.) with no apparent booking need.
- unclear: there isn't enough information in the transcript to tell.`;

  return {
    system,
    messages: [{ role: 'user', content: `Conversation transcript:\n\n${transcriptText}` }],
  };
}

// Parses the strict-format response above back into a plain object. Uses
// simple line-prefix matching rather than JSON so a slightly-off model
// response (extra whitespace, a stray blank line) still parses instead of
// throwing -- worst case, individual fields come back as null.
function parseConversationInsight(text) {
  const lines = String(text || '').split('\n');
  const get = (label) => {
    const line = lines.find((l) => l.trim().toUpperCase().startsWith(label + ':'));
    if (!line) return null;
    const value = line.slice(line.indexOf(':') + 1).trim();
    return !value || value.toLowerCase() === 'none' ? null : value;
  };

  const allowedOutcomes = ['booked', 'unbooked_lead', 'resolved_question', 'unclear'];
  const rawOutcome = (get('OUTCOME') || '').toLowerCase();
  const outcome = allowedOutcomes.includes(rawOutcome) ? rawOutcome : 'unclear';

  return {
    outcome,
    contactName: get('NAME'),
    contactEmail: get('EMAIL'),
    contactPhone: get('PHONE'),
    summary: get('SUMMARY'),
  };
}

module.exports = { buildConversationInsightPrompt, parseConversationInsight };
