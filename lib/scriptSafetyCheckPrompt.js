// Builds the prompt used to have Claude double-check its own draft script
// against a client's intake answers before it's allowed to go out to a real
// customer with zero human involved. This is what makes automatic approval
// safe: rather than trusting the first draft blindly, a second, independent
// pass looks specifically for the kinds of mistakes a human reviewer would
// have caught -- missing pricing, contradictions, leftover placeholder text,
// or a tone that doesn't match what the business asked for.
//
// This is deliberately conservative: when in doubt, it's told to flag the
// script for a human rather than let something questionable go out on its
// own. The founder (who usually knows nothing about the specific business
// signing up) never has to judge the business content itself -- only read a
// plain-English reason and decide whether it needs a closer look.

function buildScriptSafetyCheckPrompt(intake, script) {
  const system = `You are a strict quality-control reviewer for AI receptionist scripts used by home services businesses. You will be shown a business's original intake form answers and a draft script an AI wrote from them. Your job is ONLY to decide whether this script is safe to send straight to the business owner for their approval with no human check first -- not whether it's perfectly written.

Flag it as NEEDS_REVIEW if:
- It states a price, fee, or policy that contradicts or isn't supported by the intake answers
- It implies the business offers a service they said they do NOT offer
- It contains obvious placeholder text, brackets like [insert...], or unfinished sentences
- It's missing the required AI-disclosure opening greeting
- Key intake answers were left blank or "(not provided)" in a way that leaves the script guessing at something important (like pricing or service area)
- The tone clearly doesn't match what was requested

Otherwise, mark it SAFE. Minor wording or style preferences are not a reason to flag it -- the business owner can always edit those later. When genuinely unsure between SAFE and NEEDS_REVIEW, choose NEEDS_REVIEW.

Respond in EXACTLY this format, nothing else:
STATUS: <SAFE or NEEDS_REVIEW>
REASON: <if NEEDS_REVIEW, one short plain-English sentence a non-technical person could read and immediately know what to double-check -- no technical language. If SAFE, write "n/a".>`;

  const messages = [
    {
      role: 'user',
      content: `INTAKE FORM ANSWERS:\n${JSON.stringify(intake, null, 2)}\n\nDRAFT SCRIPT:\n${script}`,
    },
  ];

  return { system, messages };
}

// Line-prefix parser, same tolerant style as the other AI-response parsers
// in this app (conversationInsightPrompt.js, followUpPrompt.js). Fails safe:
// anything unparseable or ambiguous comes back as NEEDS_REVIEW, never SAFE.
function parseScriptSafetyCheck(text) {
  if (!text) {
    return { status: 'NEEDS_REVIEW', reason: "The automatic check didn't return a result, so this needs a manual look." };
  }

  const statusMatch = text.match(/STATUS:\s*(SAFE|NEEDS_REVIEW)/i);
  const reasonMatch = text.match(/REASON:\s*([\s\S]*)/i);

  const status = statusMatch ? statusMatch[1].toUpperCase() : 'NEEDS_REVIEW';
  let reason = reasonMatch ? reasonMatch[1].trim() : '';

  if (status === 'SAFE') {
    reason = null;
  } else if (!reason || reason.toLowerCase().startsWith('n/a')) {
    reason = "The automatic check flagged this script but didn't give a clear reason -- worth a careful read.";
  }

  return { status: status === 'SAFE' ? 'SAFE' : 'NEEDS_REVIEW', reason };
}

module.exports = { buildScriptSafetyCheckPrompt, parseScriptSafetyCheck };
