// Builds the prompt used to draft (never send) a follow-up message for a
// website widget conversation that Claude has already tagged as an
// "unbooked_lead" -- someone who showed real interest but didn't book.
// This is Stage 2 of the "never let a lead go cold" feature: draft a
// message and let the business owner review/edit/approve it, the same
// "you stay in control before anything goes out" pattern used for the main
// AI agent script. Actually sending an approved draft is a later stage.

function buildFollowUpDraftPrompt(client, conversation) {
  const companyName = client.intake?.companyName || 'the business';
  const script = client.script || '';
  const contactName = conversation.contactName;
  const transcriptText = (conversation.messages || [])
    .map((m) => `${m.role === 'user' ? 'Visitor' : 'AI'}: ${m.content}`)
    .join('\n');

  const system = `You are writing a short follow-up email on behalf of ${companyName} to a website visitor who chatted with their AI assistant but didn't end up booking a job. The goal is a warm, low-pressure nudge -- not a sales pitch -- that references what they specifically asked about and makes it easy to take the next step.

Use the business's own approved script below as your source of truth for services, pricing, and tone -- match how this business actually talks to customers. Don't invent details (pricing, availability, services) that aren't in the script or the conversation.

--- APPROVED SCRIPT FOR ${companyName} ---
${script}
--- END OF APPROVED SCRIPT ---

Address the visitor by name if one is known (their name: ${contactName || 'unknown -- use a friendly generic greeting like "Hi there"'}). Keep the body to 2-4 short sentences. Sign off with the company name, not "AI assistant" or any mention of AI -- the visitor should feel like they're hearing from the business itself.

Respond in EXACTLY this format, nothing before or after:
SUBJECT: <a short, plain email subject line, no clickbait>
BODY: <the full email body, starting with a greeting and ending with a sign-off>`;

  return {
    system,
    messages: [{ role: 'user', content: `Conversation transcript:\n\n${transcriptText}` }],
  };
}

// Parses the strict SUBJECT/BODY format above. BODY intentionally captures
// everything after the marker (not just one line), since the body is
// usually a few sentences across multiple lines.
function parseFollowUpDraft(text) {
  const str = String(text || '').trim();
  const subjectMatch = str.match(/SUBJECT:\s*(.*)/);
  const subject = subjectMatch ? subjectMatch[1].trim() : null;

  const bodyIdx = str.indexOf('BODY:');
  const body = bodyIdx !== -1 ? str.slice(bodyIdx + 'BODY:'.length).trim() : null;

  return { subject: subject || null, body: body || null };
}

module.exports = { buildFollowUpDraftPrompt, parseFollowUpDraft };
