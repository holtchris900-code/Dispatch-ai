// One place for every self-serve plan's price, minutes and features, so the
// pricing page, checkout, usage billing and support chat can't drift apart.
// Change a number here and in the pricing sections of index.html,
// plumbers.html and electricians.html (plus the onboard.html plan choice).
//
// Each plan's Stripe price lives in Render as an environment variable
// (priceEnv below) -- create the price in Stripe first (Products > Add
// product > recurring monthly, GBP), then paste its price_... id there.

const PLANS = {
  solo: {
    label: 'Solo',
    priceGbp: 49,
    minutes: 150,
    overageGbp: 0.25,
    priceEnv: 'STRIPE_PRICE_ID_SOLO',
    calendarBooking: false,
    websiteChat: false,
  },
  starter: {
    label: 'Starter',
    priceGbp: 119,
    minutes: 400,
    overageGbp: 0.25,
    priceEnv: 'STRIPE_PRICE_ID_STARTER',
    calendarBooking: true,
    websiteChat: true,
  },
  growth: {
    label: 'Growth',
    priceGbp: 229,
    minutes: 1000,
    overageGbp: 0.25,
    priceEnv: 'STRIPE_PRICE_ID_GROWTH',
    calendarBooking: true,
    websiteChat: true,
  },
};

// Anything unrecognised is treated as Starter, matching the old behaviour.
function normalizePlan(plan) {
  return Object.prototype.hasOwnProperty.call(PLANS, plan) ? plan : 'starter';
}

function priceIdFor(plan) {
  return process.env[PLANS[normalizePlan(plan)].priceEnv];
}

// Clients with no plan on record (e.g. from before plans were tracked) get
// every feature, so nothing is taken away from an existing customer.
function planAllows(plan, feature) {
  if (!plan || !PLANS[plan]) return true;
  return !!PLANS[plan][feature];
}

const PLAN_MINUTES = Object.fromEntries(Object.entries(PLANS).map(([k, p]) => [k, p.minutes]));
const PLAN_OVERAGE_RATE_GBP = Object.fromEntries(Object.entries(PLANS).map(([k, p]) => [k, p.overageGbp]));

module.exports = { PLANS, normalizePlan, priceIdFor, planAllows, PLAN_MINUTES, PLAN_OVERAGE_RATE_GBP };
