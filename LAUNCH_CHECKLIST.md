# Launch Checklist — From This Code to a Live Website

Written for a non-technical founder. No command-line skills required anywhere in this checklist.

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

Sign up at retellai.com and add a payment method. Get your Retell API key from their dashboard and add it to Render's environment variables as `RETELL_API_KEY`. Once a client is on a paid plan, their dashboard card gets a "Create phone agent" button — click it and it pushes their approved script into Retell as a real voice agent, no command line needed. Then, entirely inside Retell's own dashboard (no code), you buy or import a phone number and assign it to that new agent using the agent ID shown on their card. Call the number yourself first to make sure it sounds right, then paste the number into the box on their dashboard card so it's saved for reference before handing it to the client.

## Step 6 — Set up real Stripe payments

The app now has real Stripe subscription billing built in — the dashboard's "Get payment link" buttons generate an actual, working Stripe Checkout link once this is configured. A few one-time setup steps, all inside Stripe's own dashboard (no code):

Create a free account at stripe.com. In the dashboard, go to **Developers → API keys** and copy your **Secret key** (it starts with `sk_test_` while you're testing — you'll switch to a `sk_live_` key later when you're ready to accept real money). Add that to Render as an environment variable named `STRIPE_SECRET_KEY`.

Next, go to **Product catalog** and create two products, priced in GBP — one named "Starter" priced at £119/month (recurring), one named "Growth" priced at £229/month (recurring). (See the separate pricing recommendation doc for how these numbers were chosen and how they compare to competitors — adjust them if you land on different figures, the important part is that they're recurring monthly prices in GBP.) Each one gives you a Price ID that looks like `price_1AbCdEfG...` — copy those and add them to Render as `STRIPE_PRICE_ID_STARTER` and `STRIPE_PRICE_ID_GROWTH`.

Last, go to **Developers → Webhooks**, click "Add endpoint," and enter `https://YOUR-RENDER-URL/api/stripe/webhook` (using your actual Render address) as the endpoint URL. Select **two** events to listen for: `checkout.session.completed` (tells your app when a client has actually paid, flipping their status to "paid" automatically) and `customer.subscription.deleted` (tells your app the moment a subscription actually ends, flipping their status to "cancelled" automatically — this is also your cue to pause or remove their agent in Retell once that's connected, since cancelling billing doesn't by itself turn off a live phone agent). Stripe gives you a **signing secret** starting with `whsec_` — add that to Render as `STRIPE_WEBHOOK_SECRET`.

Once all four of those environment variables are set in Render and the service redeploys, the dashboard's payment link buttons go from showing a demo-mode message to generating real, working Stripe checkout links you can text or email to an approved client.

One more setting makes cancellation self-service for your clients, instead of them having to email you and you cancelling it for them manually: in Stripe, go to **Settings → Billing → Customer portal** and turn it on. Stripe will ask what you want to allow customers to do in that portal — make sure **"Cancel subscriptions"** is switched on (updating the payment method is on by default and worth leaving on too). Save it. That's it — no code, just a one-time toggle. After a client pays, they land on a page with a "Manage my subscription" button that opens this portal; you can also generate the same link for any paid client any time from your dashboard, under a "Get manage-subscription link" button on their card.

## Step 7 — Set your dashboard password

The dashboard is now protected by a login, but it ships with an insecure placeholder password so it doesn't accidentally lock you out before you've configured a real one. In Render's environment variables, add `DASHBOARD_USERNAME` (anything you like, e.g. your name) and `DASHBOARD_PASSWORD` (something real and private — not something you use anywhere else). Once set, visiting `/dashboard` will prompt for that login before showing any client data.

## Step 8 — Make client data actually stick around

Render's **free** plan wipes your app's local files every time it restarts, redeploys, or spins down from inactivity (which happens automatically after about 15 minutes with no visitors). That means client records can vanish without warning — not a bug in the code, just how the free tier works. Fixing this needs two things, both inside Render, no code involved:

First, upgrade your web service off the Free plan to the **Starter** plan (currently $7/month) — from your service's page, look for **Settings** and a plan/instance type option. This alone also removes the ~50 second "waking up" delay visitors hit after the site's been idle.

Second, attach a **Persistent Disk**: still in Settings, find the **Disks** section, and add one. A **1 GB** disk (currently $0.25/month) is far more than enough for a JSON file of client records. When it asks for a **mount path**, enter exactly `/var/data`.

Finally, add one more environment variable so the app actually uses that disk:
- `DATA_DIR` = `/var/data`

Save it, let the service redeploy, and client data will survive from then on — restarts, redeploys, and idle periods included. You can confirm it worked by checking Render's logs after the redeploy: the old warning about `DATA_DIR` not being set should be gone.

## Step 9 — Connect a real email service (so follow-ups can actually send)

The dashboard can now send a real email to a website visitor who chatted but didn't book -- but only once this is set up. Without it, clicking "Send now" on a follow-up draft shows a demo-mode message instead of sending anything. This same setup also powers past-customer outreach (the "Send now" button on a client's own private customer-upload page) -- no separate setup needed for that one, it reuses everything below.

This uses **Resend** (resend.com), chosen because it has a genuinely free tier (3,000 emails/month) and one of the simplest setups of any email service. Sending real emails to real visitors requires owning a domain (not just your Render web address) -- if you don't have one yet, that's covered in Step 4 above; it's no longer purely optional once you want this feature working.

Create a free account at resend.com. Inside it, add and verify the domain you own -- Resend gives you a small number of DNS records (usually 2-3) to add wherever you manage that domain's DNS (the same place you'd go for Step 4's custom domain setup). Verification can take anywhere from a few minutes to a few hours depending on the registrar. Once verified, create an API key from **API Keys** in Resend's dashboard, and add it to Render as `RESEND_API_KEY`.

Then add one more environment variable in Render: `FOLLOWUP_FROM_EMAIL`, set to an address on your newly verified domain (e.g. `hello@yourdomain.com` -- it doesn't need to be a real working inbox, just a valid address on that domain). Optionally, add `FOLLOWUP_REPLY_TO` set to your own real email address, so that if a lead replies to a follow-up, it lands in your inbox instead of nowhere -- you can then forward it to the client by hand.

We'll walk through the Resend signup and domain verification together step by step, with screenshots, whenever you're ready to do this one live -- it's the same pattern as the Stripe and Render setup earlier.

## Step 10 — Connect real-time calendar booking (optional, the most involved step here)

Without this step, a client's AI chat widget still works great -- it just collects a customer's preferred date, time, and contact info, and says a team member will confirm it, exactly like it does today. Once this is connected for a specific client, their widget instead checks their real Google Calendar and books the appointment directly, on the spot, during the chat. It's entirely optional and can wait until you're ready -- this is genuinely the fiddliest setup step in this whole checklist (Google's developer console has more steps than Stripe or Resend), so don't feel like this needs to happen before your first customers. We're happy to walk through it together live, the same as we offered for Resend above.

Go to console.cloud.google.com and create a free account if you don't have one, then create a new Project (top left, name it anything, e.g. "Dispatch AI"). Inside that project:

1. **Turn on the Calendar API.** Go to "APIs & Services" → "Library," search for "Google Calendar API," open it, and click "Enable."
2. **Set up the consent screen.** Go to "APIs & Services" → "OAuth consent screen." Choose "External" as the user type. Fill in an app name (e.g. "Dispatch AI"), your own email as the support email, and your own email again as the developer contact. On the "Scopes" step, add these three: `.../auth/calendar.events`, `.../auth/calendar.freebusy`, and `.../auth/userinfo.email` (search each by typing "calendar" or "userinfo" in the scope search box). Save through to the end.
3. **Add test users.** Still on the OAuth consent screen page, find "Test users" and add your own Google email, plus the Google email of each client as you connect their calendar for them. While your app is in "Testing" status (Google's default, and the right choice while you're starting out), only people on this list can complete the connection -- which is a small extra step per client, but avoids Google's "unverified app" warning screen entirely. This comfortably covers your first 100 clients; only worth revisiting once you're growing well past that, which -- as you said -- is a problem for another day.
4. **Create the credentials.** Go to "APIs & Services" → "Credentials" → "+ Create Credentials" → "OAuth client ID." Choose "Web application" as the type. Under "Authorized redirect URIs," add exactly: `https://YOUR-RENDER-URL/api/google-calendar/oauth-callback` (using your actual Render address from Step 3, e.g. `https://dispatch-ai.onrender.com/api/google-calendar/oauth-callback`). Click "Create." Google shows you a **Client ID** and **Client Secret** -- copy both.
5. **Add them to Render.** In your web service's environment variables, add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` with the values you just copied. Let the service redeploy.
6. **Test it.** On a paid test client's dashboard card, under "Real-time appointment booking," click "Connect Google Calendar." Sign in with a Google account you added as a test user in step 3. Approve access. You should land back on your dashboard with that section now showing "✅ Connected as your@email.com." Try chatting with that client's widget and asking to book something -- it should offer real free times and, once you confirm one, actually create the event on that Google Calendar.

## Before you send this to a single real customer

A couple of things still worth double-checking: make sure you've actually completed Step 7 above (the dashboard ships with a fallback password specifically so it isn't wide open, but that fallback is not something to leave in place), and Step 8 (without it, real customer data can silently disappear). Review the AI-disclosure and outbound-calling compliance notes from the earlier planning document with a real look at your state's specific rules before making any outbound calls. Once Step 8 is done, client data survives restarts and redeploys, but it's still a single JSON file rather than a real database — fine through your first several dozen clients, but worth moving to a proper database once you're relying on this daily with real customers and want protection against two edits happening at the exact same instant.

None of this needs to happen before your first test client — it needs to happen before you're handling real customer phone numbers, addresses, and payment information at any real volume.
