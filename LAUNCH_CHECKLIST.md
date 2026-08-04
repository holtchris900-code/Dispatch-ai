# Launch Checklist — From This Code to a Live Website

Written for a non-technical founder. No command-line skills required except one optional step near the end (flagged clearly below), which you can hand to a freelance developer for a quick, cheap task if you'd rather not do it yourself.

## Step 1 — Get your AI API key

Go to console.anthropic.com and create an account. Add a payment method (usage is billed per API call — for testing and your first several clients, this will likely run a few dollars a month, not more). Create an API key and copy it somewhere safe — you'll paste it in during Step 3. This key is what makes the chat demo and script generator give real AI answers instead of placeholder text.

## Step 2 — Put the code on GitHub

GitHub is where the code needs to live for the hosting service in Step 3 to find it. Create a free account at github.com if you don't have one. Click the "+" in the top right and choose "New repository," name it something like `dispatch-ai`, and keep it private. On the new repository's page, use the "uploading an existing file" link and drag every file and folder from this project into it — no command-line git needed for this, it's a drag-and-drop upload in the browser.

## Step 3 — Deploy it so it has a real web address

Go to render.com and create a free account. Click "New +" then "Web Service," and connect the GitHub repository you just created. When it asks for a start command, enter `node server.js` (leave the build command blank — this project has no dependencies to install). In the "Environment Variables" section, add `ANTHROPIC_API_KEY` and paste the key from Step 1. Click deploy. After a minute or two, Render gives you a live web address like `https://dispatch-ai.onrender.com` — that's your real, working website.

Visit that address, try the chat demo, fill out the intake form, and check the dashboard, exactly like we tested it in this session, to confirm everything works on the live version too.

## Step 4 — (Optional) Get a real domain name

Buy a domain (e.g., `dispatchai.com`) from a registrar like Namecheap or Google Domains, usually $10-15/year. In Render's dashboard, under your web service's "Settings," there's a "Custom Domain" option that walks you through pointing your new domain at your Render site. This step can wait until you're ready to actually promote the site.

## Step 5 — Connect a real phone number (when you're ready to take real calls)

This is the one step that genuinely benefits from a technical person, but it's small — maybe 30 minutes for a freelance developer, or doable yourself if you're comfortable following instructions closely. Sign up at retellai.com and add a payment method. Get your Retell API key from their dashboard and add it to Render's environment variables as `RETELL_API_KEY`. Once you've approved a client's script in your dashboard, someone runs one command (`node scripts/create-retell-agent.js <clientId>`) to push that script into Retell as a real voice agent. Then, entirely inside Retell's own dashboard (no code), you buy or import a phone number and assign it to that new agent. Call the number yourself first to make sure it sounds right before handing it to a real client.

## Step 6 — Set up payments (no code needed)

Create a free account at stripe.com. Under Stripe's "Payment Links" feature, create a payment link for each pricing tier (e.g., "Starter — $149/month," "Growth — $299/month") — this is a point-and-click setup, no code required. Stripe gives you a URL for each one; add buttons linking to them on your pricing section. This lets you start collecting real subscription payments before you've built any custom billing logic into the app itself.

## Before you send this to a single real customer

A few things worth doing first, since this is an MVP and not yet hardened for real customer data: add at least a simple password to the `/dashboard` page, since right now anyone with the URL can view every client's info (a developer can add this in well under an hour). Review the AI-disclosure and outbound-calling compliance notes from the earlier planning document with a real look at your state's specific rules before making any outbound calls. And plan to move off the JSON-file storage to a real database once you have more than a handful of clients, since it's fine for testing but not built for scale or simultaneous edits.

None of this needs to happen before your first test client — it needs to happen before you're handling real customer phone numbers, addresses, and payment information at any real volume.
