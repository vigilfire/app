/**
 * Vigil Core + module pricing — the source of truth for:
 *  - what Core includes (seat allowances) and what each of the 4 feature
 *    modules unlocks and includes
 *  - what each add-on costs on top
 *  - `calculateMonthlyPrice()`, used wherever a company's monthly bill needs
 *    computing
 *
 * admin.html keeps its own copy of these same constants (there's no shared
 * build step to import this file from a static HTML page) — update both
 * files together whenever a price or allowance changes.
 *
 * There is only one base tier (Core) now — no named plans. Every company
 * starts on Core and independently buys whichever of the 4 modules it
 * needs, each priced and gated on its own. Prices below are placeholders
 * (no Rand figures were given for this pricing round) — replace with real
 * pricing before relying on the MRR figure, same caveat every pricing
 * constants file in this project has carried since the first one.
 */
const CORE_PRICE = 499;
const CORE_INCLUDED_ADMINS = 1;
const CORE_INCLUDED_TECHNICIANS = 3;

const CLIENT_MODULE_PRICE = 349;

const TRAINEE_MODULE_PRICE = 249;
const TRAINEE_MODULE_INCLUDED_TRAINEES = 2;

const WORKSHOP_MODULE_PRICE = 349;

const AUDITING_MODULE_PRICE = 399;
const AUDITING_MODULE_INCLUDED_WORKSHOPS = 1;

const ADDON_PRICES = {
  extraTechnician: 249,
  extraAdmin: 149,
  extraTrainee: 99,
  extraWorkshop: 279,
};

function calculateMonthlyPrice(company) {
  const m = (company && company.modules) || {};
  const a = (company && company.addOns) || {};
  let total =
    CORE_PRICE +
    (a.extraTechnicians || 0) * ADDON_PRICES.extraTechnician +
    (a.extraAdmins || 0) * ADDON_PRICES.extraAdmin;
  if (m.clientModule) total += CLIENT_MODULE_PRICE;
  if (m.traineeModule) total += TRAINEE_MODULE_PRICE + (a.extraTrainees || 0) * ADDON_PRICES.extraTrainee;
  if (m.workshopModule) total += WORKSHOP_MODULE_PRICE;
  if (m.auditingModule) total += AUDITING_MODULE_PRICE + (a.extraWorkshops || 0) * ADDON_PRICES.extraWorkshop;
  return total;
}

module.exports = {
  CORE_PRICE,
  CORE_INCLUDED_ADMINS,
  CORE_INCLUDED_TECHNICIANS,
  CLIENT_MODULE_PRICE,
  TRAINEE_MODULE_PRICE,
  TRAINEE_MODULE_INCLUDED_TRAINEES,
  WORKSHOP_MODULE_PRICE,
  AUDITING_MODULE_PRICE,
  AUDITING_MODULE_INCLUDED_WORKSHOPS,
  ADDON_PRICES,
  calculateMonthlyPrice,
};
