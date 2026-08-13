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

## Before you send this to a single real customer

A couple of things still worth double-checking: make sure you've actually completed Step 7 above (the dashboard ships with a fallback password specifically so it isn't wide open, but that fallback is not something to leave in place), and Step 8 (without it, real customer data can silently disappear). Review the AI-disclosure and outbound-calling compliance notes from the earlier planning document with a real look at your state's specific rules before making any outbound calls. Once Step 8 is done, client data survives restarts and redeploys, but it's still a single JSON file rather than a real database — fine through your first several dozen clients, but worth moving to a proper database once you're relying on this daily with real customers and want protection against two edits happening at the exact same instant.

None of this needs to happen before your first test client — it needs to happen before you're handling real customer phone numbers, addresses, and payment information at any real volume.

