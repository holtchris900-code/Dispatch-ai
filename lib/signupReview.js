// Self-service script approval for brand-new signups.
//
// The business owner knows their own prices, hours and services; the
// founder doesn't. So instead of holding new signups for a human review,
// every new signup now:
//   1. gets an automatic check that writes plain-English notes TO THE
//      CUSTOMER about anything worth double-checking (missing prices,
//      contradictions, leftover placeholders),
//   2. sees those notes on the sign-up page next to their script, can edit
//      the script there, and
//   3. taps "Approve my script" -- which takes them straight to Stripe to
//      start their free trial (the link is emailed too, as a backup).
//
// Two things are still handled automatically rather than left to the
// customer:
//   - The "you're speaking with an AI" greeting is a compliance
//     requirement, so if it's missing (or the customer deletes it), it's
//     put back (ensureAiDisclosure).
//   - Obvious misuse -- a signup that clearly isn't a real trade or home
//     services business, or abusive, hateful, sexual, deceptive or illegal
//     content -- is BLOCKED: no payment link, and the founder is emailed to
//     take a look, exactly like the old manual review.
//
// server.js calls reviewNewSignup() from POST /api/onboard and
// approveSignup() from POST /api/onboard/approve.

const { normalizePlan, priceIdFor } = require('./plans');
const crypto = require('crypto');

// --- The automatic check --------------------------------------------------

function buildSignupReviewPrompt(intake, script) {
  const system = `You are checking a draft AI receptionist script for a UK home services business (plumbers, heating engineers, electricians and similar trades). It was written by an AI from the owner's sign-up form answers. The owner will read your notes and approve the script themselves, so your notes are written TO THE BUSINESS OWNER.

Do two things.

1. Decide whether this signup must be BLOCKED for a human to look at. Block ONLY for clear misuse:
- the business is clearly not a real trade or home services business (for example it's a test of something unrelated, gibberish, or a different kind of business pretending to be one), or
- the form answers or script contain abusive, hateful, sexual, threatening, deceptive or illegal content, or instructions for the AI to mislead or pressure callers.
Ordinary mistakes, gaps or odd wording are NOT a reason to block. When unsure, do not block.

2. Write up to 4 short notes for the owner about things worth double-checking before they approve, such as:
- a price, fee or policy in the script that isn't supported by their answers, or contradicts them
- a service mentioned that they said they don't offer
- placeholder text like [insert...] or unfinished sentences
- something important left blank on the form that the script has to guess at (prices, area covered, hours, what counts as an emergency) -- say what the AI will do instead, e.g. "it will say someone will call back with a price"
Each note: one plain-English sentence, starting with what to check, no jargon. If nothing needs checking, write no notes.

Respond in EXACTLY this format and nothing else:
BLOCK: <YES or NO>
BLOCK_REASON: <if YES, one short sentence for the founder; if NO, write n/a>
NOTES:
- <note>
- <note>`;

  const messages = [
    {
      role: 'user',
      content: `SIGN-UP FORM ANSWERS:\n${JSON.stringify(intake, null, 2)}\n\nDRAFT SCRIPT:\n${script}`,
    },
  ];
  return { system, messages };
}

// Tolerant parser. If the reply can't be read at all, it doesn't block the
// customer (blocking is only for clear misuse) -- it just gives them a
// general reminder to read the script through.
function parseSignupReview(text) {
  const t = String(text || '');
  const block = /BLOCK:\s*YES/i.test(t);
  const reasonMatch = t.match(/BLOCK_REASON:\s*(.*)/i);
  const blockReason = block && reasonMatch && !/^n\/?a\b/i.test(reasonMatch[1].trim())
    ? reasonMatch[1].trim()
    : block
      ? 'The automatic check flagged this signup for a human look.'
      : null;
  const notesPart = t.split(/NOTES:/i)[1] || '';
  const notes = notesPart
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•\d.)]+\s*/, '').trim())
    .filter((l) => l && !/^none\b|^n\/?a\b/i.test(l))
    .slice(0, 4);
  const parsed = /BLOCK:/i.test(t);
  return { block, blockReason, notes, parsed };
}

async function runSignupReview({ intake, script, callClaude }) {
  try {
    const { system, messages } = buildSignupReviewPrompt(intake, script);
    const result = await callClaude({ system, messages, maxTokens: 400 });
    if (result.demoMode) return { block: false, blockReason: null, notes: [], checked: false };
    const review = parseSignupReview(result.text);
    if (!review.parsed) {
      review.notes = ['Our automatic check could not finish, so please read your script through carefully before approving.'];
    }
    return { ...review, checked: true };
  } catch (err) {
    return {
      block: false,
      blockReason: null,
      notes: ['Our automatic check could not finish, so please read your script through carefully before approving.'],
      checked: false,
    };
  }
}

// --- AI disclosure guard -----------------------------------------------------

const AI_DISCLOSURE_PATTERN = /\b(AI|A\.I\.|artificial intelligence|virtual assistant|automated assistant|digital assistant)\b/i;

function ensureAiDisclosure(script, companyName) {
  const text = String(script || '');
  const opening = text.slice(0, 900);
  if (AI_DISCLOSURE_PATTERN.test(opening)) return { script: text, added: false };
  const name = String(companyName || 'the business').trim();
  const greeting = `## Opening greeting (required)\n\n"Hi, thanks for calling ${name}. Just so you know, you're speaking with an AI assistant. How can I help today?"\n\n---\n\n`;
  return { script: greeting + text, added: true };
}

// --- Step 1: a new signup's script has just been written ---------------------

async function reviewNewSignup({ id, intake, script, demoMode, db, notifyFounder, callClaude }) {
  // Demo mode (no AI key): no real script to check -- keep the original
  // manual flow untouched.
  if (demoMode) return db.getClient(id);

  const disclosure = ensureAiDisclosure(script, intake.companyName);
  const review = await runSignupReview({ intake, script: disclosure.script, callClaude });

  if (review.block) {
    const updated = db.updateClient(id, {
      script: disclosure.script,
      status: 'draft',
      reviewMode: 'manual',
      reviewReason: review.blockReason,
      signupStage: 'held_for_founder',
    });
    await notifyFounder({ companyName: intake.companyName, reason: review.blockReason });
    return updated;
  }

  return db.updateClient(id, {
    script: disclosure.script,
    status: 'draft',
    reviewMode: 'customer',
    reviewReason: null,
    reviewNotes: review.notes,
    signupStage: 'awaiting_customer_approval',
    signupReviewToken: crypto.randomBytes(24).toString('hex'),
  });
}

// --- Step 2: the customer taps "Approve my script" ----------------------------

function tokensMatch(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function approveSignup({ body, baseUrl, db, callClaude, createCheckoutSession, sendEmail, notifyFounder, freeTrialDays }) {
  const { id, token } = body || {};
  const clientRecord = id ? db.getClient(String(id)) : null;
  if (!clientRecord || !tokensMatch(token, clientRecord.signupReviewToken)) {
    return { status: 404, body: { error: 'We could not find this signup. Please refresh the page or contact us.' } };
  }
  if (clientRecord.status === 'paid') {
    return { status: 400, body: { error: 'This account is already active. Sign in from the homepage.' } };
  }
  if (clientRecord.signupStage === 'held_for_founder') {
    return { status: 200, body: { held: true, message: "Thanks. We need to take a quick look at this one before it goes live, and we'll email you as soon as it's ready." } };
  }

  const intake = clientRecord.intake || {};
  let script = typeof body.script === 'string' ? body.script.trim() : clientRecord.script;
  if (!script || script.length < 40) {
    return { status: 400, body: { error: 'Your script looks empty. Please add some wording before approving.' } };
  }
  if (script.length > 20000) {
    return { status: 400, body: { error: 'Your script is too long. Please shorten it a little.' } };
  }

  // If they edited it, check the new wording for misuse only (their own
  // business details are theirs to decide).
  if (script !== clientRecord.script) {
    const recheck = await runSignupReview({ intake, script, callClaude });
    if (recheck.block) {
      db.updateClient(clientRecord.id, {
        pendingScriptEdit: script,
        reviewMode: 'manual',
        reviewReason: recheck.blockReason,
        signupStage: 'held_for_founder',
      });
      await notifyFounder({ companyName: intake.companyName, reason: `After editing their script: ${recheck.blockReason}` });
      return { status: 200, body: { held: true, message: "Thanks. We need to take a quick look at your changes before this goes live, and we'll email you as soon as it's ready." } };
    }
  }
  script = ensureAiDisclosure(script, intake.companyName).script;

  const plan = normalizePlan(intake.plan);
  const checkout = await createCheckoutSession({
    clientId: clientRecord.id,
    priceId: priceIdFor(plan),
    companyName: intake.companyName,
    trialDays: clientRecord.paidAt ? 0 : freeTrialDays,
    successUrl: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${baseUrl}/onboard?checkout=cancelled`,
  });

  db.updateClient(clientRecord.id, {
    script,
    status: 'approved',
    approvedAt: new Date().toISOString(),
    reviewMode: 'customer',
    signupStage: 'customer_approved',
    pendingPlan: plan,
  });

  if (checkout.demoMode) {
    await notifyFounder({
      companyName: intake.companyName,
      reason: `The customer approved their script, but a payment link couldn't be created (${checkout.message}). Send one from the dashboard once Stripe is set up.`,
    });
    return { status: 200, body: { held: true, message: "Thanks, your script is approved. We'll email you a link to start your free trial shortly." } };
  }

  // Backup copy of the link by email, in case they close the payment page.
  try {
    const emailResult = await sendEmail({
      to: intake.contactEmail,
      subject: `${intake.companyName || 'Your business'} -- your link to start your free trial`,
      text: `Hi,\n\nThanks for approving your AI agent's script.\n\nIf you didn't finish setting up payment, you can start your 14-day free trial here:\n${checkout.url}\n\nYou won't be charged until the trial ends, and you can cancel any time before then.\n\n-- Dispatch AI`,
      fromName: 'Dispatch AI',
    });
    db.updateClient(clientRecord.id, {
      customerEmailSentAt: emailResult.demoMode ? null : new Date().toISOString(),
      customerEmailDemoMode: !!emailResult.demoMode,
    });
  } catch (err) {
    // The customer is being sent straight to the payment page anyway.
  }

  return { status: 200, body: { checkoutUrl: checkout.url } };
}

module.exports = { reviewNewSignup, approveSignup, ensureAiDisclosure, parseSignupReview };
