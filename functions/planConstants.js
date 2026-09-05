/**
 * Plan pricing and default seat limits — the source of truth for:
 *  - the seat limit a new company gets by default when it's created on a plan
 *  - the per-plan monthly price used to compute MRR on the /admin dashboard
 *
 * admin.html keeps its own copy of these same two objects (there's no shared
 * build step to import this file from a static HTML page) — update both
 * files together whenever a price or seat default changes. Values below are
 * placeholders; replace with real pricing before relying on the MRR figure.
 */
const PLAN_SEAT_LIMITS = {
  starter: 3,
  growth: 10,
  business: null, // null = unlimited seats
};

const PLAN_MONTHLY_PRICE = {
  starter: 499,
  growth: 1299,
  business: 2999,
};

const VALID_PLANS = Object.keys(PLAN_SEAT_LIMITS);

module.exports = { PLAN_SEAT_LIMITS, PLAN_MONTHLY_PRICE, VALID_PLANS };
