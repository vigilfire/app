/**
 * Plan + add-on pricing — the source of truth for:
 *  - what each of the 4 named plans includes (seat/role allowances, whether
 *    client-facing PDFs carry Vigil Fire branding)
 *  - what each add-on costs on top of a plan
 *  - `calculateMonthlyPrice()`, used wherever a company's monthly bill needs
 *    computing (always the monthly-equivalent figure, even for an annual
 *    biller — see the comment on that function)
 *
 * admin.html keeps its own copy of these same constants (there's no shared
 * build step to import this file from a static HTML page) — update both
 * files together whenever a price or limit changes.
 */
const PLAN_PRICES = { inspection: 249, starter: 499, growth: 1299, business: 2499 };
const VALID_PLANS = Object.keys(PLAN_PRICES);

// Per-plan built-in allowances. `competentPersons` (the Competent Person /
// "inspector" role, SANS 10105-1 monthly site-control checks) is
// deliberately Inspection-plan-exclusive — there is no add-on anywhere that
// raises it for another plan, by design, not by omission.
const PLAN_LIMITS = {
  inspection: { admins: 1, technicians: 0, competentPersons: 1, traineeLogbooksIncluded: 0, removesBranding: false },
  starter:    { admins: 1, technicians: 1, competentPersons: 0, traineeLogbooksIncluded: 0, removesBranding: false },
  growth:     { admins: 2, technicians: 5, competentPersons: 0, traineeLogbooksIncluded: 0, removesBranding: true },
  business:   { admins: 3, technicians: 10, competentPersons: 0, traineeLogbooksIncluded: 2, removesBranding: true },
};

const ADDON_PRICES = {
  extraTechnician: 249,
  extraAdmin: 149,
  traineeLogbook: 149,
  auditPack: 399,              // includes 1 workshop
  auditPackExtraWorkshop: 279,
};

// Always the monthly-equivalent, regardless of a company's billingCycle —
// an annual biller is charged calculateMonthlyPrice(company) * 10 (2 months
// free) as their actual lump sum, but MRR reporting and this function both
// stay in monthly terms so an annual customer doesn't distort the figure.
function calculateMonthlyPrice(company) {
  const plan = (company && company.plan) || "starter";
  const a = (company && company.addOns) || {};
  let total =
    (PLAN_PRICES[plan] || 0) +
    (a.extraTechnicians || 0) * ADDON_PRICES.extraTechnician +
    (a.extraAdmins || 0) * ADDON_PRICES.extraAdmin +
    (a.traineeLogbooks || 0) * ADDON_PRICES.traineeLogbook;
  if ((a.auditPackWorkshops || 0) > 0) {
    total += ADDON_PRICES.auditPack + Math.max(0, (a.auditPackWorkshops || 0) - 1) * ADDON_PRICES.auditPackExtraWorkshop;
  }
  return total;
}

module.exports = {
  PLAN_PRICES,
  VALID_PLANS,
  PLAN_LIMITS,
  ADDON_PRICES,
  calculateMonthlyPrice,
};
