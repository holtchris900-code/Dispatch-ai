// Thin wrapper around the Anthropic Messages API.
// If no ANTHROPIC_API_KEY is set, this falls back to canned responses so the
// rest of the app (forms, dashboard, routing) can still be tested end-to-end
// before you've plugged in a real key.

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

async function callClaude({ system, messages, maxTokens = 600 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return {
      text: "[DEMO MODE - no ANTHROPIC_API_KEY set] I'd respond here using Claude once you add your API key to .env. For now, here's a placeholder reply so you can confirm the rest of the app works end to end.",
      demoMode: true,
    };
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const text = data.content?.map((block) => block.text || '').join('') || '';
  return { text, demoMode: false };
}

module.exports = { callClaude };
