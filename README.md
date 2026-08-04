# Dispatch AI — MVP Prototype

A working prototype of the AI chat/call agent platform: a landing page with a live AI chat demo, a client intake form, an AI script generator, and a review/approve dashboard.

## What's actually working right now

The landing page (`/`) has a real chat widget wired to Claude. The intake form (`/onboard`) saves a new client and calls Claude to draft their agent's script from the answers. The dashboard (`/dashboard`) lists every client, lets you edit the draft script, and approve it. Everything runs as a single Node.js process with **zero npm dependencies** — no `npm install` step is required to run it, only Node.js itself (version 18 or newer).

Without an `ANTHROPIC_API_KEY` set, the app runs in "demo mode": every AI response is a canned placeholder, but the entire flow (forms, saving, dashboard, editing, approving) is fully testable. This was verified end-to-end before this file was handed to you — every route was tested and the pages were screenshotted to confirm they render correctly.

## Running it locally

1. Install Node.js 18+ if you don't have it (nodejs.org).
2. Open a terminal in this folder.
3. Copy `.env.example` to `.env` and fill in `ANTHROPIC_API_KEY` (get one at console.anthropic.com) to get real AI responses instead of placeholders.
4. Run `node server.js`.
5. Open `http://localhost:3000` in a browser.

## What's NOT built yet (by design, for an MVP)

There's no real database (client data lives in `data/clients.json` — fine for testing and your first handful of clients, not for scale). There's no login/authentication — anyone with the URL can view `/dashboard`, so don't put this on the public internet as-is without adding at least a basic password. There's no billing/payment integration (see the launch checklist for the no-code way to start taking payments with Stripe Payment Links). There's no live phone number yet — `scripts/create-retell-agent.js` is a ready-to-run helper for connecting an approved script to Retell AI once you have a Retell account, but it's a manual step, not automatic yet.

## File guide

`server.js` is the entire backend — routes, static file serving, all in one file for easy reading. `lib/claude.js` calls the Anthropic API (and falls back to placeholder text if no key is set). `lib/scriptPrompt.js` builds the prompt that turns intake answers into a draft script — this is the actual "product" logic worth iterating on as you learn what makes a good script. `lib/db.js` is the JSON-file storage. `public/` has the three pages (landing, onboard, dashboard) as plain HTML/CSS/JS — no framework, no build step. `scripts/create-retell-agent.js` pushes an approved script live to Retell AI (run manually, not from the dashboard).

See `LAUNCH_CHECKLIST.md` for the non-technical, step-by-step path from this code to a real URL real customers can use.
