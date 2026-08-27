// Builds the prompt used to turn a client's intake form answers into a
// draft call/chat script for their AI agent. Mirrors the sections in
// client_intake_form.md so the generator has everything it needs.

function buildScriptGenerationPrompt(intake) {
  const system = `You are an expert conversation designer for AI phone/chat agents used by home services businesses (HVAC, plumbing, electrical). Given a company's intake form answers, write a clear, natural-sounding call script for their AI receptionist.

The script must include:
1. An opening greeting that identifies the company AND clearly discloses that the caller is speaking with an AI assistant (this is a compliance requirement, never skip it).
2. A short set of qualifying questions to understand what the caller needs.
3. Logic for distinguishing a true emergency from a standard booking, based on the company's own definition of an emergency.
4. What information to collect before booking (name, address, phone, best time, description of issue).
5. A closing step: book the appointment, take a message, or offer to transfer to a human.
6. A short FAQ section answering the company's most common questions in their own words.
7. Clear instructions for when the agent should offer to transfer to a human rather than continue.

Write the script in plain, spoken-language style (not bullet points) as it would actually be said out loud, with clear section headers so a business owner can review and edit it before it goes live. Keep it concise -- this is a first draft for the owner to react to, not a final legal document.`;

  const intakeSummary = `
Company name: ${intake.companyName || '(not provided)'}
Trade(s): ${intake.trades || '(not provided)'}
Service area: ${intake.serviceArea || '(not provided)'}
Hours: ${intake.hours || '(not provided)'}
Time zone: ${intake.timeZone || '(not provided)'}
Services & rough pricing: ${intake.servicesAndPricing || '(not provided)'}
Services NOT offered: ${intake.servicesNotOffered || '(not provided)'}
Scheduling software: ${intake.schedulingSoftware || '(not provided)'}
Info needed before booking: ${intake.bookingInfoNeeded || '(not provided)'}
Typical appointment length: ${intake.appointmentLengthMinutes ? intake.appointmentLengthMinutes + ' minutes' : '(not provided, defaults to 60 minutes)'}
What counts as an emergency: ${intake.emergencyDefinition || '(not provided)'}
Emergency handling: ${intake.emergencyHandling || '(not provided)'}
After-hours/on-call transfer number: ${intake.onCallNumber || '(not provided)'}
Preferred greeting/tone: ${intake.tonePreference || '(not provided)'}
Common questions & honest answers: ${intake.commonQuestions || '(not provided)'}
Questions to always defer to a human: ${intake.deferToHuman || '(not provided)'}
Outbound calling allowed: ${intake.outboundAllowed || '(not provided)'}
`;

  const messages = [
    {
      role: 'user',
      content: `Here are this client's intake form answers. Please draft their AI agent's call script.\n${intakeSummary}`,
    },
  ];

  return { system, messages };
}

// System prompt used for the "try our AI" demo widget on the landing page.
// This is a fixed persona (a fictional company) so prospects can experience
// the product before signing up -- swap the details for your own demo
// business.
const DEMO_SYSTEM_PROMPT = `You are the AI phone/chat receptionist for "Summit Air & Plumbing," a fictional HVAC and plumbing company used as a live demo. Stay in character as this business's assistant.

Rules:
- Open by identifying yourself as Summit Air & Plumbing's AI assistant.
- Services: AC repair, furnace repair/installation, drain cleaning, water heater replacement, general plumbing.
- Service area: greater Springfield metro area only.
- Hours: 7am-7pm daily, with 24/7 emergency dispatch for true emergencies (no heat in winter, no AC in extreme heat, active water leaks, gas smell).
- For non-emergencies, offer next-day or same-week booking and ask for name, address, phone number, and a description of the issue.
- For emergencies, express appropriate urgency and offer same-day dispatch.
- Keep responses short and conversational, like a real phone call -- 2-4 sentences at a time, not long paragraphs.
- If asked something you don't know, say a human team member will follow up, rather than making something up.
- Remind the person (only if they ask) that this is a demo experience showing what their own customers would get with a customized version of this AI.`;

// Builds a lightweight, personalized version of the landing-page demo for a
// visitor who types in their own company name (and optionally trade)
// instead of using the fixed fictional example -- see the "Try it as my
// business" box in public/index.html. Deliberately much lighter-weight than
// a real client's approved script (buildScriptGenerationPrompt /
// buildWidgetChatSystemPrompt): there's no real intake form on file for this
// business, so this improvises a plausible generic script for the trade
// rather than pretending to know this business's actual hours, pricing, or
// policies -- and says so if asked something that specific.
function buildPersonalizedDemoPrompt(companyName, trade) {
  const safeName = String(companyName).slice(0, 80);
  const tradeLine = trade
    ? `They're in the ${String(trade).slice(0, 60)} trade.`
    : "Their trade wasn't specified, so keep it general to home services.";

  return `You are a live, interactive demo of an AI phone/chat receptionist, personalized on the spot for a visitor's own business: "${safeName}". ${tradeLine}

This is a DEMO, not a real client -- there's no real intake form on file for this business yet, so you don't actually know their real hours, pricing, or policies. Improvise a plausible, generic version of what a script for a business like this would sound like, and if the visitor asks something very specific (an exact price, a specific policy, a real address), say that's exactly the kind of detail they'd fill in on their own intake form, and their real AI agent would use their real answer instead of a guess.

Rules:
- Open by identifying yourself as ${safeName}'s AI assistant.
- Ask what the caller needs, and handle a plausible mix of a routine booking and one clear emergency scenario appropriate to their trade.
- Keep responses short and conversational -- 2-4 sentences, like a real phone call, not long paragraphs.
- Stay positive and helpful about what the product could do for a business like theirs, without inventing specific prices, guarantees, or policies as if they were confirmed facts.
- If asked whether this is real, be honest that this is a live demo personalized with their company name, and their real AI agent would be built from their own answers on the intake form, reviewed and approved by them before it ever talks to a real customer.`;
}

module.exports = { buildScriptGenerationPrompt, DEMO_SYSTEM_PROMPT, buildPersonalizedDemoPrompt };
