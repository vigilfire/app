/**
 * Vigil Fire — demo tenant seed script.
 *
 * Creates (or rebuilds) a self-contained demo company — companyId "demo-co"
 * — with one admin, one technician, one trainee and one Competent Person
 * account, two sites, and a full spread of equipment/audit/training records,
 * so every report and workflow in the app can be exercised end to end
 * without touching any real client's data.
 *
 * Design notes:
 *   - Everything this script writes carries companyId "demo-co", so wiping
 *     is always a full, safe, scoped delete — it can never reach another
 *     company's data.
 *   - Dates are computed relative to when the script actually runs (months/
 *     days ago or from now), not hard-coded calendar dates, so the demo
 *     stays realistic (overdue items overdue, due-soon items due soon) no
 *     matter when you (re)run it.
 *   - The company is created with every feature module switched on
 *     (clientModule / traineeModule / workshopModule / auditingModule), and
 *     with its Facilities & audit scope declared — workshop, pressure test,
 *     charging, reconditioning, hose reels and above-ground hydrants, but NOT
 *     underground hydrants or site-servicing-only — so the Audit tab shows a
 *     real spread: rows on file, partly ticked, empty, marked not applicable,
 *     and greyed out because a facility isn't declared. It also seeds three
 *     vehicles (one per Annex A purpose, with an assignment history), delegates
 *     for each employee, the materials/PPE/modification/label/complaints/
 *     documents registers, checklist ticks, and reconditioning jobs.
 *   - A few things are deliberately left *unfinished* rather than fully
 *     seeded, so you have something real to click through as each demo
 *     account: the technician/trainee/Competent Person accounts start with
 *     an INCOMPLETE profile (so you see the profile-completion gate), the
 *     trainee has one unsigned draft logbook entry, the Competent Person has
 *     no monthly check for the current month yet, one condemned unit has no
 *     action plan recorded, one site has an outstanding recharge blocking
 *     its register, the delivery vehicle has no roadworthy date, one
 *     complaint is still open, and a few procedure rows (topping-up, control
 *     of cartridges, protection of product quality) have no document tagged.
 *     Everything else is pre-filled so reports have real content to show
 *     immediately.
 *
 * Setup (one time):
 *   1. Firebase Console -> vigil-fire project -> Project settings -> Service
 *      accounts -> Generate new private key. Save the JSON file somewhere
 *      OUTSIDE this repo (it's a live, unrevoked credential — see .gitignore,
 *      which already refuses to let a *serviceAccount*.json / *.key.json
 *      file under scripts/ be committed, but keeping it outside the repo
 *      entirely is safer still).
 *   2. cd scripts && npm install   (installs firebase-admin — shared
 *      package.json with migrate-to-multitenant.js, nothing new to add)
 *
 * Usage:
 *   node seed-demo.js /path/to/serviceAccountKey.json --email you@example.com
 *     Builds (or rebuilds — it wipes any previous demo-co first) the demo
 *     tenant. --email is the address the two demo sites use as their site
 *     contact — that's where "Email to site" sends will actually land, and
 *     it's the only personal detail this script touches, never committed.
 *
 *   node seed-demo.js /path/to/serviceAccountKey.json --wipe
 *     Deletes the demo tenant (companies/companyAddons/settings docs, every
 *     companyId="demo-co" record in every collection, the three demo Auth
 *     accounts, and their technicianLookup entries) and does nothing else.
 */

const admin = require("firebase-admin");

const keyPath = process.argv[2];
const emailFlagIdx = process.argv.indexOf("--email");
const contactEmail = emailFlagIdx !== -1 ? process.argv[emailFlagIdx + 1] : null;
const wipeOnly = process.argv.includes("--wipe");

if (!keyPath || (!wipeOnly && !contactEmail)) {
  console.error("Usage:");
  console.error("  node seed-demo.js /path/to/serviceAccountKey.json --email you@example.com");
  console.error("  node seed-demo.js /path/to/serviceAccountKey.json --wipe");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(require("path").resolve(keyPath))),
});
const db = admin.firestore();
const auth = admin.auth();

const COMPANY_ID = "demo-co";
const DEMO_PASSWORD = "VigilDemo2026!";
const ADMIN_EMAIL = "admin@demo.vigilfire.invalid";
const TECH_NUMBER = "DEMO-TECH";
const TRAINEE_NUMBER = "DEMO-TRAIN";
const COMPETENT_NUMBER = "DEMO-CP";
const TECH_NAME = "Thabo Nkosi";
const TECH_SAQCC = "SAQCC-DT4471";
const TRAINEE_NAME = "Naledi Dlamini";
const COMPETENT_NAME = "Pieter van Wyk";

/* ---------------------------- date helpers ---------------------------- */
function monthsAgo(n) { const d = new Date(); d.setMonth(d.getMonth() - n); return d; }
function monthsFromNow(n) { return monthsAgo(-n); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function daysFromNow(n) { return daysAgo(-n); }
function iso(d) { return d.toISOString().slice(0, 10); }          // YYYY-MM-DD
function ym(d) { return iso(d).slice(0, 7); }                     // YYYY-MM
function addYearsYm(d, years) {
  const [y, mm] = ym(d).split("-");
  return String(Number(y) + years).padStart(4, "0") + "-" + mm;
}
function ts(d) { return admin.firestore.Timestamp.fromDate(d); }
const NOW = new Date();

/* ------------------------------ wipe ----------------------------------- */
const COMPANY_SCOPED_COLLECTIONS = [
  "technicians", "sites", "equipment", "serviceEvents", "logbookEntries",
  "traineeAssignments", "traineeCompetencies", "monthlyChecks", "toolboxTalks",
  "calibrations", "calibrationCertificates", "companyDocuments", "vehicles",
  "branches", "tools", "toolChecks", "mandatoryTopics", "emailLog",
  "sans1475Checklist", "sans1475RegisterEntries", "reconditioningJobs",
];

async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const batch = db.batch();
    ops.slice(i, i + 450).forEach((op) => batch.delete(op));
    await batch.commit();
  }
}

async function wipeCompany() {
  console.log(`Wiping demo company "${COMPANY_ID}"...`);

  const techSnap = await db.collection("technicians").where("companyId", "==", COMPANY_ID).get();
  for (const doc of techSnap.docs) {
    try { await auth.deleteUser(doc.id); } catch (e) {
      if (e.code !== "auth/user-not-found") console.warn(`  auth delete failed for ${doc.id}: ${e.message}`);
    }
  }
  console.log(`  auth users: deleted ${techSnap.size}`);

  for (const num of [TECH_NUMBER, TRAINEE_NUMBER, COMPETENT_NUMBER]) {
    await db.collection("technicianLookup").doc(num).delete().catch(() => {});
  }

  for (const col of COMPANY_SCOPED_COLLECTIONS) {
    const snap = await db.collection(col).where("companyId", "==", COMPANY_ID).get();
    if (snap.empty) continue;
    if (col === "toolboxTalks") {
      for (const doc of snap.docs) {
        const attSnap = await doc.ref.collection("attendees").get();
        await commitInChunks(attSnap.docs.map((d) => d.ref));
      }
    }
    await commitInChunks(snap.docs.map((d) => d.ref));
    console.log(`  ${col}: deleted ${snap.size}`);
  }

  await db.collection("companyAddons").doc(COMPANY_ID).delete().catch(() => {});
  await db.collection("settings").doc(COMPANY_ID).delete().catch(() => {});
  await db.collection("companies").doc(COMPANY_ID).delete().catch(() => {});
  console.log("Done — demo company fully removed.\n");
}

/* --------------------------- account helpers --------------------------- */
async function upsertAuthUser({ email, password, displayName }) {
  try {
    const existing = await auth.getUserByEmail(email);
    await auth.updateUser(existing.uid, { password, displayName });
    return existing.uid;
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw e;
    const created = await auth.createUser({ email, password, displayName });
    return created.uid;
  }
}

/* ------------------------------- build ---------------------------------- */
async function buildCompany() {
  // Vigil Core + 4 feature modules, all switched on so every screen of the demo
  // works (the app and firestore.rules read `modules`; the old `plan` /
  // `seatLimit` / `{ audit: true }` shape was retired by migrate-to-addons-pricing.js).
  // The add-on allowances are the same generous ones that migration grandfathers in.
  const modules = { clientModule: true, traineeModule: true, workshopModule: true, auditingModule: true };
  const addOns = { extraTechnicians: 50, extraAdmins: 10, extraTrainees: 50, extraWorkshops: 20 };
  await db.collection("companies").doc(COMPANY_ID).set({
    name: "Vigil Fire Demo (Pty) Ltd",
    modules, addOns,
    status: "trialing",
    createdAt: ts(NOW),
    notes: "Seeded by scripts/seed-demo.js — safe to wipe and rebuild at any time.",
    usage: { storageBytes: 0, emailsSentThisMonth: 0 },
    lastActivityAt: ts(NOW),
  });
  await db.collection("companyAddons").doc(COMPANY_ID).set({ modules, addOns });
  await db.collection("settings").doc(COMPANY_ID).set({
    // Facilities & audit scope (Company profile -> Facilities & audit scope).
    // The demo runs a workshop, pressure-test bay, charging area, reconditioning
    // and services hose reels and above-ground hydrants — but NOT underground
    // hydrants, so those rows show greyed out as "Not applicable" on the Audit tab.
    facilities: {
      workshop: true, pressuretest: true, charging: true, reconditioning: true,
      hosereels: true, aghydrants: true, ughydrants: false, siteservicing: false,
    },
    name: "Vigil Fire Demo (Pty) Ltd",
    reg: "2019/123456/07",
    address: "12 Protea Road, Century City, Cape Town, 7441",
    phone: "021 555 0134",
    email: "info@demo.vigilfire.invalid",
    signatoryName: "Demo Admin",
    signatoryTitle: "Compliance Manager",
    logo: "",
    signature: "",
    calibrationLabName: "SANAS Test Lab (Pty) Ltd",
    calibrationLabAccreditationNo: "T0999",
    calibrationLabContact: "lab@sanastestlab.example",
    updatedAt: ts(NOW),
  });
  console.log("Company, modules, facilities and settings created.");
}

async function buildAccounts() {
  const adminUid = await upsertAuthUser({ email: ADMIN_EMAIL, password: DEMO_PASSWORD, displayName: "Demo Admin" });
  await db.collection("technicians").doc(adminUid).set({
    name: "Demo Admin", email: ADMIN_EMAIL, role: "admin", companyId: COMPANY_ID,
    active: true, canCalibrate: false, createdAt: ts(monthsAgo(20)),
  });

  const techEmail = `${TECH_NUMBER}@technicians.invalid`;
  const techUid = await upsertAuthUser({ email: techEmail, password: DEMO_PASSWORD, displayName: TECH_NAME });
  await db.collection("technicians").doc(techUid).set({
    name: TECH_NAME, techNumber: TECH_NUMBER, email: techEmail, role: "technician",
    saqcc: TECH_SAQCC, phone: "082 555 0111", active: true,
    canCalibrate: true, canRunToolboxTalks: true, companyId: COMPANY_ID,
    consentConfirmedBy: adminUid, consentConfirmedAt: ts(monthsAgo(11)),
    createdAt: ts(monthsAgo(11)),
  });
  await db.collection("technicianLookup").doc(TECH_NUMBER).set({ email: techEmail, companyId: COMPANY_ID });

  const traineeEmail = `${TRAINEE_NUMBER}@technicians.invalid`;
  const traineeUid = await upsertAuthUser({ email: traineeEmail, password: DEMO_PASSWORD, displayName: TRAINEE_NAME });
  await db.collection("technicians").doc(traineeUid).set({
    name: TRAINEE_NAME, techNumber: TRAINEE_NUMBER, email: traineeEmail, role: "trainee",
    saqcc: "", phone: "083 555 0122", active: true,
    canCalibrate: false, canRunToolboxTalks: false, companyId: COMPANY_ID,
    traineeRegisteredDate: iso(monthsAgo(4)),
    consentConfirmedBy: adminUid, consentConfirmedAt: ts(monthsAgo(4)),
    createdAt: ts(monthsAgo(4)),
  });
  await db.collection("technicianLookup").doc(TRAINEE_NUMBER).set({ email: traineeEmail, companyId: COMPANY_ID });

  const competentEmail = `${COMPETENT_NUMBER}@technicians.invalid`;
  const competentUid = await upsertAuthUser({ email: competentEmail, password: DEMO_PASSWORD, displayName: COMPETENT_NAME });
  await db.collection("technicians").doc(competentUid).set({
    name: COMPETENT_NAME, techNumber: COMPETENT_NUMBER, email: competentEmail, role: "competent",
    saqcc: "", phone: "084 555 0133", active: true,
    canCalibrate: false, canRunToolboxTalks: false, companyId: COMPANY_ID,
    consentConfirmedBy: adminUid, consentConfirmedAt: ts(monthsAgo(9)),
    createdAt: ts(monthsAgo(9)),
  });
  await db.collection("technicianLookup").doc(COMPETENT_NUMBER).set({ email: competentEmail, companyId: COMPANY_ID });

  console.log("Accounts created: 1 admin, 1 technician, 1 trainee, 1 Competent Person.");
  return { adminUid, techUid, traineeUid, competentUid };
}

async function buildSites(techUid, competentUid) {
  const siteARef = db.collection("sites").doc();
  await siteARef.set({
    name: "Riverside Office Park", address: "45 Riverside Drive, Rondebosch, Cape Town, 7700",
    notes: "Multi-tenant office block, 4 floors. Main entry code at security desk.",
    email: contactEmail, contactPerson: "Sarah Adams", contactPhone: "021 555 7710",
    serviceType: "minor", category: "servicing",
    assignedTo: [techUid], assignedCompetentPersons: [competentUid],
    companyId: COMPANY_ID, createdAt: ts(monthsAgo(14)),
  });

  const siteBRef = db.collection("sites").doc();
  await siteBRef.set({
    name: "Blue Harbour Warehouse", address: "8 Dockside Road, Paarden Eiland, Cape Town, 7405",
    notes: "Single-storey warehouse and loading bay.",
    email: contactEmail, contactPerson: "Johan Pretorius", contactPhone: "021 555 8820",
    serviceType: "annual", category: "servicing",
    assignedTo: [techUid], assignedCompetentPersons: [],
    companyId: COMPANY_ID, createdAt: ts(monthsAgo(14)),
    completed: true, completedAt: ts(monthsAgo(2)),
    lastCompletedDate: iso(monthsAgo(2)), lastCompletedBy: TECH_NAME,
  });

  console.log("Sites created: Riverside Office Park (active), Blue Harbour Warehouse (completed).");
  return { siteAId: siteARef.id, siteBId: siteBRef.id };
}

/* ----------------------------- equipment -------------------------------- */
const CHECKLIST_DEFS = {
  default: ["gauge", "seal", "damage", "hose", "labelAffixed", "ptLabel", "signage", "access"],
  co2: ["weight", "seal", "damage", "hose", "labelAffixed", "ptLabel", "signage", "access"],
  hosereel: ["hose", "nozzle", "reel", "pressure", "label", "signage", "access"],
  blanket: ["pouch", "pull", "label", "signage", "access"],
  hydrant: ["valve", "couplings", "damage", "flow", "label", "signage", "access"],
  siren: ["sound", "damage", "mount", "power", "label", "signage", "access"],
};
const TYPE_CATEGORY = {
  "1.5kg DCP": "default", "2kg DCP": "default", "4.5kg DCP": "default", "9kg DCP": "default",
  "2kg CO2": "co2", "5kg CO2": "co2", "10kg CO2": "co2",
  "9L Water": "default", "9L Foam": "default", "Lithium": "default", "Trolley": "default",
  "Hydrant": "hydrant", "Hose reel": "hosereel", "Siren": "siren", "Fire Blanket": "blanket",
};
function passChecklist(type) {
  const keys = CHECKLIST_DEFS[TYPE_CATEGORY[type] || "default"];
  const out = {}; keys.forEach((k) => { out[k] = "pass"; }); return out;
}

function baseEquipment(techUid, siteId, overrides) {
  return Object.assign({
    make: "Kevron", serial: "", location: "", mfgDate: null,
    serviceDate: null, inspectionDate: null, nextServiceDue: null,
    pressureTestDate: null, pressureTestDue: null,
    checklist: {}, status: "pass", notes: "", photoURL: null,
    serviceMass: "", tareMass: "", weightCheckDate: null, weightCheckDue: null,
    hoseReplacedDate: null, hoseReplacedDue: null,
    condemned: false, condemnedDate: null, condemnedReason: "", condemnedCriteria: {}, replacedBy: "",
    condemnedActionPlan: "", condemnedActionPlanNotes: "", condemnedActionPlanDate: null,
    mediumReplaceDue: null,
    rechargeRequired: false, rechargeDate: null,
    ptPerformed: false, ptPrevDate: null, ptTestPressure: "", ptResult: "", ptTechnicianName: "", ptTechnicianSaqcc: "",
    ptChecklist: {}, ptNotes: "",
    rechargeMedium: "", rechargePressureBefore: "", rechargePressureAfter: "",
    rechargeTechnicianName: "", rechargeTechnicianSaqcc: "", rechargeChecklist: {}, rechargeNotes: "",
    schemaVersion: 2,
    technicianId: techUid, technicianName: TECH_NAME, saqcc: TECH_SAQCC,
    updatedAt: ts(NOW), siteId, companyId: COMPANY_ID, createdBy: techUid, createdAt: ts(NOW),
  }, overrides);
}

async function addEquipment(techUid, siteId, overrides) {
  const ref = db.collection("equipment").doc();
  const data = baseEquipment(techUid, siteId, overrides);
  await ref.set(data);
  return { id: ref.id, ...data };
}

// Equipment's own date fields (service/inspection/next-due/pressure-test/
// weight-check/hose-replaced/recharge/condemned) are all HTML `type="month"`
// pickers in the app — they need "YYYY-MM", not a full "YYYY-MM-DD", or the
// field would silently render blank when someone opens the record to edit
// it. `ym()` (not `iso()`) is the correct helper for every one of them.
async function logHistory(eq, kind, when) {
  await db.collection("serviceEvents").add({
    equipmentId: eq.id, siteId: eq.siteId, companyId: COMPANY_ID, kind,
    type: eq.type, make: eq.make, serial: eq.serial, location: eq.location,
    mfgDate: eq.mfgDate, serviceDate: eq.serviceDate, inspectionDate: eq.inspectionDate,
    nextServiceDue: eq.nextServiceDue, pressureTestDate: eq.pressureTestDate, pressureTestDue: eq.pressureTestDue,
    weightCheckDate: eq.weightCheckDate, hoseReplacedDate: eq.hoseReplacedDate,
    rechargeDate: eq.rechargeDate, condemnedDate: eq.condemnedDate,
    recordedBy: eq.technicianId, recordedByName: eq.technicianName, recordedAt: ts(when),
  });
}
// `when` here is a month string ("YYYY-MM") — pad a day-of-month so it's a
// valid ISO date-time for the Timestamp above.
function monthDateTime(monthStr) { return new Date((monthStr || ym(NOW)) + "-01T09:00:00Z"); }

async function buildEquipment(techUid, siteAId, siteBId) {
  const siteA = [];

  siteA.push(await addEquipment(techUid, siteAId, {
    type: "4.5kg DCP", serial: "FE-1001", location: "Reception — ground floor",
    serviceDate: ym(monthsAgo(11)), inspectionDate: ym(monthsAgo(11)), nextServiceDue: ym(monthsFromNow(1)),
    pressureTestDate: ym(monthsAgo(11)), pressureTestDue: addYearsYm(monthsAgo(11), 5),
    checklist: passChecklist("4.5kg DCP"), status: "pass",
  }));

  siteA.push(await addEquipment(techUid, siteAId, {
    type: "9kg DCP", serial: "FE-1002", location: "Loading bay — ground floor",
    serviceDate: ym(monthsAgo(14)), inspectionDate: ym(monthsAgo(14)), nextServiceDue: ym(monthsAgo(2)),
    pressureTestDate: ym(monthsAgo(14)), pressureTestDue: addYearsYm(monthsAgo(14), 5),
    checklist: passChecklist("9kg DCP"), status: "pass",
  }));

  siteA.push(await addEquipment(techUid, siteAId, {
    type: "2kg CO2", serial: "FE-1003", location: "Server room — 1st floor",
  }));

  siteA.push(await addEquipment(techUid, siteAId, {
    type: "10kg CO2", serial: "FE-1004", location: "Kitchen — 1st floor",
    serviceDate: ym(monthsAgo(3)), inspectionDate: ym(monthsAgo(3)), nextServiceDue: ym(monthsFromNow(9)),
    weightCheckDate: ym(monthsAgo(7)), weightCheckDue: ym(monthsAgo(1)),
    checklist: passChecklist("10kg CO2"), status: "attention",
    notes: "Content weight slightly below tolerance at last check — monitor at next visit.",
  }));

  const waterRecharge = monthsAgo(56);
  siteA.push(await addEquipment(techUid, siteAId, {
    type: "9L Water", serial: "FE-1005", location: "Corridor — 2nd floor",
    serviceDate: ym(monthsAgo(5)), inspectionDate: ym(monthsAgo(5)), nextServiceDue: ym(monthsFromNow(7)),
    pressureTestDate: ym(monthsAgo(5)), pressureTestDue: addYearsYm(monthsAgo(5), 5),
    checklist: passChecklist("9L Water"), status: "pass",
    rechargeRequired: true, rechargeDate: ym(waterRecharge), mediumReplaceDue: addYearsYm(waterRecharge, 5),
  }));

  const foamRecharge = monthsAgo(63);
  siteA.push(await addEquipment(techUid, siteAId, {
    type: "9L Foam", serial: "FE-1006", location: "Plant room — 2nd floor",
    serviceDate: ym(monthsAgo(6)), inspectionDate: ym(monthsAgo(6)), nextServiceDue: ym(monthsFromNow(6)),
    pressureTestDate: ym(monthsAgo(6)), pressureTestDue: addYearsYm(monthsAgo(6), 5),
    checklist: passChecklist("9L Foam"), status: "pass",
    rechargeRequired: true, rechargeDate: ym(foamRecharge), mediumReplaceDue: addYearsYm(foamRecharge, 5),
  }));

  siteA.push(await addEquipment(techUid, siteAId, {
    type: "2kg DCP", serial: "FE-1007", location: "Boardroom — 3rd floor",
    condemned: true, condemnedDate: ym(monthsAgo(1)), status: "fail",
    condemnedReason: "Severe corrosion and pitting to cylinder body found during inspection.",
    condemnedCriteria: { corrosion: true },
  }));

  siteA.push(await addEquipment(techUid, siteAId, {
    type: "1.5kg DCP", serial: "FE-1008", location: "Stairwell A — 3rd floor",
    condemned: true, condemnedDate: ym(monthsAgo(1)), status: "fail",
    condemnedReason: "Damaged cylinder valve threads.",
    condemnedCriteria: { threads: true },
    condemnedReportSentAt: ts(daysAgo(3)),
  }));

  siteA.push(await addEquipment(techUid, siteAId, {
    type: "Trolley", serial: "FE-1009", location: "Basement parking",
    condemned: true, condemnedDate: ym(monthsAgo(2)), status: "fail",
    condemnedReason: "Cylinder exposed to fire during a workshop incident on the premises.",
    condemnedCriteria: { fire: true },
    condemnedReportSentAt: ts(daysAgo(10)),
  }));

  siteA.push(await addEquipment(techUid, siteAId, {
    type: "Lithium", serial: "FE-1010", location: "EV charging bay — basement",
    condemned: true, condemnedDate: ym(monthsAgo(2)), status: "fail",
    condemnedReason: "Obsolete type, beyond serviceable life.",
    condemnedCriteria: { obsolete: true }, replacedBy: "FE-1010-B",
    condemnedReportSentAt: ts(daysAgo(20)),
    condemnedActionPlan: "replace-company",
    condemnedActionPlanNotes: "Client confirmed replacement via our workshop — new unit on order.",
    condemnedActionPlanDate: iso(daysAgo(13)),
  }));

  siteA.push(await addEquipment(techUid, siteAId, {
    type: "Hose reel", serial: "HR-2001", location: "Stairwell B — every floor",
    serviceDate: ym(monthsAgo(2)), inspectionDate: ym(monthsAgo(2)), nextServiceDue: ym(monthsFromNow(10)),
    hoseReplacedDate: ym(monthsAgo(74)), hoseReplacedDue: ym(monthsAgo(2)),
    checklist: passChecklist("Hose reel"), status: "pass",
  }));

  siteA.push(await addEquipment(techUid, siteAId, {
    type: "Hydrant", serial: "HY-3001", location: "External — north wall",
    serviceDate: ym(monthsAgo(4)), inspectionDate: ym(monthsAgo(4)), nextServiceDue: ym(monthsFromNow(8)),
    checklist: passChecklist("Hydrant"), status: "pass",
  }));

  siteA.push(await addEquipment(techUid, siteAId, {
    type: "Siren", serial: "SR-4001", location: "External — main entrance",
    serviceDate: ym(monthsAgo(2)), inspectionDate: ym(monthsAgo(2)), nextServiceDue: ym(monthsFromNow(10)),
    checklist: passChecklist("Siren"), status: "pass",
  }));

  siteA.push(await addEquipment(techUid, siteAId, {
    type: "Fire Blanket", serial: "FB-5001", location: "Kitchen — 1st floor",
    serviceDate: ym(monthsAgo(1)), inspectionDate: ym(monthsAgo(1)), nextServiceDue: ym(monthsFromNow(11)),
    checklist: passChecklist("Fire Blanket"), status: "pass",
  }));

  siteA.push(await addEquipment(techUid, siteAId, {
    type: "4.5kg DCP", serial: "FE-1011", location: "Gym — 4th floor",
    serviceDate: ym(monthsAgo(1)), inspectionDate: ym(monthsAgo(1)), nextServiceDue: ym(monthsFromNow(11)),
    checklist: passChecklist("4.5kg DCP"), status: "attention",
    notes: "Discharged during use — recharge required.",
    rechargeRequired: true, rechargeDate: null,
  }));

  for (const eq of siteA) {
    await logHistory(eq, eq.condemned ? "condemned" : (eq.rechargeDate ? "recharge" : "service"),
      monthDateTime(eq.condemnedDate || eq.serviceDate));
  }

  const siteB = [];
  siteB.push(await addEquipment(techUid, siteBId, {
    type: "4.5kg DCP", serial: "BH-2101", location: "Office — front",
    serviceDate: ym(monthsAgo(2)), inspectionDate: ym(monthsAgo(2)), nextServiceDue: ym(monthsFromNow(10)),
    pressureTestDate: ym(monthsAgo(2)), pressureTestDue: addYearsYm(monthsAgo(2), 5),
    checklist: passChecklist("4.5kg DCP"), status: "pass",
  }));
  siteB.push(await addEquipment(techUid, siteBId, {
    type: "9kg DCP", serial: "BH-2102", location: "Warehouse floor — bay 1",
    serviceDate: ym(monthsAgo(2)), inspectionDate: ym(monthsAgo(2)), nextServiceDue: ym(monthsFromNow(10)),
    pressureTestDate: ym(monthsAgo(2)), pressureTestDue: addYearsYm(monthsAgo(2), 5),
    checklist: passChecklist("9kg DCP"), status: "pass",
  }));
  siteB.push(await addEquipment(techUid, siteBId, {
    type: "5kg CO2", serial: "BH-2103", location: "Warehouse floor — bay 2",
    serviceDate: ym(monthsAgo(2)), inspectionDate: ym(monthsAgo(2)), nextServiceDue: ym(monthsFromNow(10)),
    weightCheckDate: ym(monthsAgo(2)), weightCheckDue: ym(monthsFromNow(4)),
    pressureTestDate: ym(monthsAgo(2)), pressureTestDue: addYearsYm(monthsAgo(2), 10),
    checklist: passChecklist("5kg CO2"), status: "pass",
  }));
  siteB.push(await addEquipment(techUid, siteBId, {
    type: "9L Water", serial: "BH-2104", location: "Loading dock",
    serviceDate: ym(monthsAgo(2)), inspectionDate: ym(monthsAgo(2)), nextServiceDue: ym(monthsFromNow(10)),
    pressureTestDate: ym(monthsAgo(2)), pressureTestDue: addYearsYm(monthsAgo(2), 5),
    checklist: passChecklist("9L Water"), status: "pass",
    mediumReplaceDue: addYearsYm(monthsAgo(2), 5),
  }));
  siteB.push(await addEquipment(techUid, siteBId, {
    type: "Hydrant", serial: "BH-HY01", location: "External — yard",
    serviceDate: ym(monthsAgo(2)), inspectionDate: ym(monthsAgo(2)), nextServiceDue: ym(monthsFromNow(10)),
    checklist: passChecklist("Hydrant"), status: "pass",
  }));
  for (const eq of siteB) {
    await logHistory(eq, "service", monthDateTime(eq.serviceDate));
  }

  console.log(`Equipment created: ${siteA.length} at Riverside Office Park, ${siteB.length} at Blue Harbour Warehouse.`);
  return { siteA, siteB };
}

/* ------------------------- logbook / trainee ----------------------------- */
async function buildTraineeRecords(adminUid, techUid, traineeUid) {
  await db.collection("traineeAssignments").doc(traineeUid).set({
    status: "active", companyId: COMPANY_ID,
    traineeName: TRAINEE_NAME, traineeNumber: TRAINEE_NUMBER,
    supervisorId: techUid, supervisorName: TECH_NAME, supervisorSaqcc: TECH_SAQCC,
    startDate: iso(monthsAgo(4)), endDateExpected: iso(monthsFromNow(2)),
    createdAt: ts(monthsAgo(4)), createdBy: adminUid, updatedAt: ts(monthsAgo(4)), updatedBy: adminUid,
  });

  function obs(n, monthsBackStart) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ date: iso(monthsAgo(monthsBackStart - i)), comment: "Observed during a site visit — performed correctly under supervision.", markedBy: techUid, markedByName: TECH_NAME });
    }
    return out;
  }
  await db.collection("traineeCompetencies").doc(traineeUid).set({
    companyId: COMPANY_ID,
    items: {
      ext_safety: { observations: obs(4, 4) },
      ext_docs: { observations: obs(4, 4) },
      ext_components_stp: { observations: obs(4, 3) },
      ext_inspect: { observations: obs(2, 2) },
      ext_depressurise: { observations: obs(1, 1) },
      co2_markings: { observations: obs(1, 1) },
    },
  });

  const entries = [
    { daysBack: 110, type: "workshop", site: "Riverside Office Park", work: "Assisted with inspection and maintenance of 6x DCP units, observed pressure gauge checks." },
    { daysBack: 95, type: "on-the-job", site: "Riverside Office Park", work: "Carried out visual inspections under supervision; recorded findings on maintenance labels." },
    { daysBack: 80, type: "workshop", site: "Blue Harbour Warehouse", work: "Observed CO2 weight check procedure and cylinder handling safety precautions." },
    { daysBack: 65, type: "on-the-job", site: "Blue Harbour Warehouse", work: "Assisted with de-pressurising and disassembly of a 9kg DCP unit for maintenance." },
    { daysBack: 50, type: "workshop", site: "Riverside Office Park", work: "Practised internal/external cylinder inspection and identifying condemning criteria." },
    { daysBack: 35, type: "on-the-job", site: "Riverside Office Park", work: "Assisted reassembly and re-pressurising of two extinguishers after maintenance." },
    { daysBack: 3, type: "workshop", site: "Blue Harbour Warehouse", work: "Observed final inspection and labelling of maintained units — awaiting witness sign-off." },
  ];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const created = daysAgo(e.daysBack);
    const isDraft = i === entries.length - 1;
    const payload = {
      traineeId: traineeUid, traineeName: TRAINEE_NAME, traineeNumber: TRAINEE_NUMBER,
      date: iso(created), trainingType: e.type, siteClient: e.site, workPerformed: e.work,
      technicianId: techUid, technicianName: TECH_NAME, technicianSaqcc: isDraft ? "" : TECH_SAQCC,
      status: isDraft ? "draft" : "signed",
      companyId: COMPANY_ID, createdAt: ts(created), createdBy: traineeUid, updatedAt: ts(created),
      createdIp: "102.65.10.24", createdDeviceId: "demo-device-trainee", createdUserAgent: "Mozilla/5.0 (seed script)",
    };
    if (!isDraft) {
      const signedAt = new Date(created.getTime() + 24 * 3600 * 1000);
      Object.assign(payload, {
        technicianComments: "Work observed and performed to standard.",
        signedAt: ts(signedAt), signedBy: techUid,
        signedIp: "102.65.10.55", signedDeviceId: "demo-device-tech", signedUserAgent: "Mozilla/5.0 (seed script)",
      });
    }
    await db.collection("logbookEntries").add(payload);
  }
  console.log("Trainee records created: assignment, competency progress, 6 signed + 1 draft logbook entries.");
}

/* ------------------------------ monthly checks --------------------------- */
async function buildMonthlyChecks(siteAId, siteAEquipment, competentUid) {
  const activeIds = siteAEquipment.filter((e) => !e.condemned).map((e) => e.id);
  for (let m = 3; m >= 1; m--) {
    const monthDate = monthsAgo(m);
    const month = ym(monthDate);
    const results = {}, faultNotes = {};
    activeIds.forEach((id, idx) => {
      const isFault = m === 2 && idx === 1;
      results[id] = isFault ? "fault" : "ok";
      if (isFault) faultNotes[id] = "Pressure indicator slightly low — flagged for maintenance company.";
    });
    await db.collection("monthlyChecks").doc(`${siteAId}_${month}`).set({
      siteId: siteAId, companyId: COMPANY_ID, month,
      checkedByName: COMPETENT_NAME, checkedBy: competentUid, recordedByName: COMPETENT_NAME,
      results, faultNotes, notes: m === 2 ? "One unit flagged, reported to maintenance company." : "",
      updatedAt: ts(monthDate),
    });
  }
  console.log("Monthly checks created for the past 3 months (current month left open for a live check-in).");
}

/* -------------------------------- audit tab ------------------------------ */
async function buildAuditData(techUid, competentUid, adminUid) {
  const branchRef = db.collection("branches").doc();
  await branchRef.set({
    companyId: COMPANY_ID, name: "Head Office Workshop — Cape Town",
    address: "12 Protea Road, Century City, Cape Town, 7441", phone: "021 555 0134",
    markPermitNo: "SABS-MP-00234-B1", markPermitIssueDate: iso(monthsAgo(20)), markPermitExpiryDate: iso(monthsFromNow(16)),
    notes: "Permanent workshop — hydrostatic and high-pressure test bays, powder refill station.",
    markPermitFileURL: "", updatedAt: ts(NOW), createdAt: ts(monthsAgo(20)), active: true,
  });
  const branchId = branchRef.id;

  // One vehicle of each Annex A.8.2 purpose. `assignments` is the automatic
  // assignment history the app keeps ({staffId, name, from, to} — a blank `to`
  // means "still assigned"). The delivery vehicle is deliberately left without a
  // roadworthy date or a driver, so A.8.2.5 "Management of vehicles" shows as
  // not yet on file and there is something to fix.
  await db.collection("vehicles").doc().set({
    companyId: COMPANY_ID, registrationNo: "CA 123-456", description: "Toyota Hilux mobile workshop",
    purpose: "mobileworkshop", branchId, assignedTechnicianId: techUid,
    assignments: [
      { staffId: competentUid, name: COMPETENT_NAME, from: iso(monthsAgo(20)), to: iso(monthsAgo(6)) },
      { staffId: techUid, name: TECH_NAME, from: iso(monthsAgo(6)), to: "" },
    ],
    licenceDiskExpiry: iso(monthsFromNow(5)), roadworthyDate: iso(monthsAgo(3)),
    mobileWorkshopApprovalRef: "SABS-MW-00981", mobileWorkshopApprovalExpiry: iso(monthsFromNow(10)),
    carriedExtinguisherSerial: "VF-CARR-0042", carriedExtinguisherServiceDate: iso(monthsAgo(3)),
    notes: "", licenceDiskFileURL: "", approvalLetterFileURL: "",
    updatedAt: ts(NOW), createdAt: ts(monthsAgo(20)), active: true,
  });
  await db.collection("vehicles").doc().set({
    companyId: COMPANY_ID, registrationNo: "CA 654-321", description: "Isuzu NPR delivery truck",
    purpose: "delivery", branchId, assignedTechnicianId: "", assignments: [],
    licenceDiskExpiry: iso(monthsFromNow(6)), roadworthyDate: "",
    mobileWorkshopApprovalRef: "", mobileWorkshopApprovalExpiry: "",
    carriedExtinguisherSerial: "", carriedExtinguisherServiceDate: "",
    notes: "Roadworthy certificate still to be captured.", licenceDiskFileURL: "", approvalLetterFileURL: "",
    updatedAt: ts(NOW), createdAt: ts(monthsAgo(14)), active: true,
  });
  await db.collection("vehicles").doc().set({
    companyId: COMPANY_ID, registrationNo: "CA 987-654", description: "Toyota Quantum maintenance van",
    purpose: "maintenance", branchId, assignedTechnicianId: techUid,
    assignments: [{ staffId: techUid, name: TECH_NAME, from: iso(monthsAgo(9)), to: "" }],
    licenceDiskExpiry: iso(monthsFromNow(8)), roadworthyDate: iso(monthsAgo(2)),
    mobileWorkshopApprovalRef: "", mobileWorkshopApprovalExpiry: "",
    carriedExtinguisherSerial: "VF-CARR-0051", carriedExtinguisherServiceDate: iso(monthsAgo(2)),
    notes: "", licenceDiskFileURL: "", approvalLetterFileURL: "",
    updatedAt: ts(NOW), createdAt: ts(monthsAgo(9)), active: true,
  });

  // Designation, authorities and ONE delegate each (who is in charge when
  // they are absent). The trainee has no delegate — trainees work under
  // supervision — so the Delegations view shows a mix of set and covered.
  await db.collection("technicians").doc(techUid).update({
    branchId, saqccRegExpiry: iso(monthsFromNow(7)), medicalCertExpiry: iso(monthsFromNow(9)),
    designation: "Senior Technician", appointments: "Workshop Supervisor", delegateId: competentUid,
  });
  await db.collection("technicians").doc(competentUid).update({
    branchId, saqccRegExpiry: iso(monthsFromNow(3)), medicalCertExpiry: iso(daysFromNow(25)),
    designation: "Competent Person", appointments: "Responsible Person, SHE Rep", delegateId: techUid,
  });
  await db.collection("technicians").doc(adminUid).update({
    designation: "Compliance Manager", appointments: "SAQCC company contact", delegateId: techUid,
  });

  const companyDocs = [
    ["sabs-mark-permit", "SABS 1475 Mark Permit", "SABS-MP-00234", monthsAgo(20), monthsFromNow(16)],
    ["saqcc-company-registration", "SAQCC Fire company registration", "SAQCC-CO-8821", monthsAgo(30), monthsFromNow(6)],
    ["tax-clearance", "Tax clearance certificate", "TCC-2025-9911", monthsAgo(12), null],
    ["public-liability-insurance", "Public liability insurance", "PLI-4471203", monthsAgo(6), monthsFromNow(9)],
    ["coida-good-standing", "COIDA letter of good standing", "COIDA-2025-330", monthsAgo(11), null],
    ["bbbee-certificate", "B-BBEE certificate", "BEE-2025-77", monthsAgo(9), monthsFromNow(11)],
  ];
  const expiryOverrides = { "tax-clearance": daysAgo(10), "coida-good-standing": daysFromNow(20) };
  for (const [type, title, ref, issue, expiry] of companyDocs) {
    const expiryDate = expiryOverrides[type] || expiry;
    await db.collection("companyDocuments").doc().set({
      companyId: COMPANY_ID, type, title, referenceNo: ref,
      issueDate: iso(issue), expiryDate: iso(expiryDate), notes: "", fileURL: "",
      updatedAt: ts(NOW), createdAt: ts(issue),
    });
  }

  // Only mass pieces are reference instruments; scales and gauges are
  // production control equipment and are seeded as Production tools below.
  await db.collection("calibrationCertificates").doc().set({
    companyId: COMPANY_ID, instrumentType: "masspieces", instrument: "Reference mass piece set", instrumentSerial: "RM-006",
    labName: "SANAS Test Lab (Pty) Ltd", labAccreditationNo: "T0999",
    calibrationDate: iso(monthsAgo(10)), nextDueDate: iso(monthsFromNow(2)),
    certificateNumber: "CAL-2025-0134", notes: "", certificateFileURL: "",
    updatedAt: ts(monthsAgo(10)), createdAt: ts(monthsAgo(10)),
  });
  await db.collection("calibrationCertificates").doc().set({
    companyId: COMPANY_ID, instrumentType: "masspieces", instrument: "Reference mass piece 20 kg", instrumentSerial: "RM-007",
    labName: "SANAS Test Lab (Pty) Ltd", labAccreditationNo: "T0999",
    calibrationDate: iso(monthsAgo(14)), nextDueDate: iso(monthsAgo(2)),
    certificateNumber: "CAL-2024-0876", notes: "Overdue for renewal.", certificateFileURL: "",
    updatedAt: ts(monthsAgo(14)), createdAt: ts(monthsAgo(14)),
  });

  for (let i = 1; i <= 5; i++) {
    const checkDate = daysAgo(7 * i);
    const isFail = i === 3;
    await db.collection("calibrations").add({
      checkDate: iso(checkDate), type: i % 2 === 0 ? "gauge" : "scale",
      equipment: i % 2 === 0 ? "Working pressure gauge WG-02" : "Digital platform scale",
      reference: "Master pressure gauge MPG-001", reading: isFail ? "off by 4%" : "within tolerance",
      deviation: isFail ? "4%" : "<1%", result: isFail ? "fail" : "pass",
      action: isFail ? "Gauge withdrawn from use, replaced with spare, workshop notified for recalibration." : "",
      technicianName: TECH_NAME, technicianSaqcc: TECH_SAQCC,
      createdBy: techUid, companyId: COMPANY_ID, createdAt: ts(checkDate),
    });
  }

  // ownerType: workshop → Workshop tools, technician → Maintenance vehicle
  // tools, production → Production tools (production control equipment).
  const tools = [
    ["Hydrostatic low-pressure test unit", "production", "HLP-2201"],
    ["Acceptable high-pressure test unit", "production", "HHP-1187"],
    ["2mm sieve", "workshop", "SV-004"],
    ["Drying cabinet", "workshop", "DC-002"],
    ["Inspection light", "workshop", "IL-011"],
    ["Digital platform scale", "production", "SCL-014"],
    ["Master pressure gauge #1", "production", "MPG-001"],
    ["Massmeter (0.1kg accuracy)", "technician", "MM-0.1-009"],
  ];
  const toolIds = [];
  for (const [name, ownerType, serial] of tools) {
    const ref = db.collection("tools").doc();
    await ref.set({
      companyId: COMPANY_ID, name, ownerType, serial,
      branchId: ownerType !== "technician" ? branchId : "",
      assignedTechnicianId: ownerType === "technician" ? techUid : "",
      responsibleTechnicianId: ownerType !== "technician" ? techUid : "",
      notes: "", updatedAt: ts(NOW), createdAt: ts(monthsAgo(18)), active: true,
    });
    toolIds.push({ id: ref.id, name });
  }
  for (let i = 0; i < 3; i++) {
    const tool = toolIds[i];
    await db.collection("toolChecks").add({
      companyId: COMPANY_ID, toolId: tool.id, toolName: tool.name,
      checkDate: iso(daysAgo(7 * (i + 1))), result: "ok", notes: "",
      checkedBy: techUid, checkedByName: TECH_NAME, createdAt: ts(daysAgo(7 * (i + 1))),
    });
  }

  const topicARef = db.collection("mandatoryTopics").doc();
  await topicARef.set({ companyId: COMPANY_ID, name: "Fire safety & PPE induction", recurrenceMonths: 12, notes: "", updatedAt: ts(NOW), createdAt: ts(monthsAgo(20)), active: true });
  const topicBRef = db.collection("mandatoryTopics").doc();
  await topicBRef.set({ companyId: COMPANY_ID, name: "Manual handling & lifting", recurrenceMonths: 12, notes: "", updatedAt: ts(NOW), createdAt: ts(monthsAgo(20)), active: true });

  async function talk(topicId, topicName, when, presenterName, attendeeUids) {
    const ref = db.collection("toolboxTalks").doc();
    await ref.set({
      companyId: COMPANY_ID, topic: topicName, date: iso(when), presenterName, notes: "",
      invitedIds: attendeeUids, mandatoryTopicId: topicId, mandatoryTopicName: topicName,
      createdBy: techUid, createdByName: TECH_NAME, createdAt: ts(when), updatedAt: ts(when),
    });
    return ref;
  }
  async function signAttendee(ref, uid, name, role, topicId, when) {
    await ref.collection("attendees").doc(uid).set({
      companyId: COMPANY_ID, name, role, mandatoryTopicId: topicId,
      signedAt: ts(when), signedIp: "102.65.10.90", signedDeviceId: "demo-device-" + uid.slice(0, 6), signedUserAgent: "Mozilla/5.0 (seed script)",
    });
  }

  return { branchId, topicARef, topicBRef, signAttendee, talk };
}

async function buildToolboxTalks(techUid, traineeUid, competentUid, audit) {
  const { topicARef, topicBRef, talk, signAttendee } = audit;

  const talkA = await talk(topicARef.id, "Fire safety & PPE induction", monthsAgo(2), "Demo Admin", [techUid, competentUid, traineeUid]);
  await signAttendee(talkA, techUid, TECH_NAME, "technician", topicARef.id, monthsAgo(2));
  await signAttendee(talkA, competentUid, COMPETENT_NAME, "competent", topicARef.id, monthsAgo(2));
  await signAttendee(talkA, traineeUid, TRAINEE_NAME, "trainee", topicARef.id, monthsAgo(2));

  const talkB = await talk(topicBRef.id, "Manual handling & lifting", monthsAgo(14), "Demo Admin", [techUid, competentUid, traineeUid]);
  await signAttendee(talkB, techUid, TECH_NAME, "technician", topicBRef.id, monthsAgo(14));
  // competentUid and traineeUid deliberately left unsigned on Topic B — shows
  // "overdue" / "never completed" states on the training compliance report.

  console.log("Toolbox talks created: 2 mandatory topics, 2 talks (mixed signed/unsigned attendance).");
}

/* ------------------------ SANS 1475 audit categories --------------------- */
// The Audit tab's category tables (Facilities & safety, Reconditioning &
// production, Labels & marking, Hose reels & hydrants, Documents & complaints…)
// read from three collections; this seeds enough in each to show every state:
// rows fully on file, partly ticked, empty, marked not applicable and greyed out.
const tick = (...keys) => Object.fromEntries(keys.map((k) => [k, true]));
// Mirrors index.html's sans1475SafeKey(): dots become underscores.
const safeClauseKey = (clause) => clause.replace(/\./g, "_");

async function buildSans1475Data(adminUid, techUid, competentUid) {
  // 1. Per-clause checklist / notes / not-applicable records: sans1475Checklist,
  //    doc id `${companyId}_${clause with dots as underscores}`.
  const clauseDocs = [
    // Facilities & safety — 4.1 ticked but for ventilation; 4.5 barely started.
    ["4.1", { checklist: tick("intake", "emptying", "inprocess", "dispatch", "walkways"), notes: "Site plan v3 lodged with the SABS Mark Permit application." }],
    ["4.3", { checklist: tick("shielded", "operator", "relief", "cordoned", "signage", "cylinders", "ignition") }],
    ["4.5", { checklist: tick("secured", "regulators") }],
    ["4.7", { checklist: tick("dry", "sealed", "contamination", "fifo", "spill") }],
    ["4.8.1", { checklist: tick("cage", "ppe", "spill") }],
    // Reconditioning & production — safe working and charging checklists.
    ["5.2.1", { checklist: tick("depressurise", "ppe", "stable", "areaclear") }],
    ["5.2.5", { checklist: tick("depressurise", "dustmask") }],
    ["4.8.2", { checklist: tick("weighed", "noflame", "secured") }],
    // Marked not applicable by the business (shows as "Not applicable", not greyed).
    ["5.1.8", { status: "na", notes: "We don't re-coat aluminium cylinders — they are sent to a specialist." }],
    // Hose reels & hydrants (Part 2). Draft-worded checklists — see the app.
    ["P2-6.1.3", { checklist: tick("present", "condition") }],
    ["P2-6.1.4", { checklist: tick("operates", "leaks", "condition", "coupling") }],
    ["P2-6.1.9", { checklist: tick("available", "isolating") }],
    ["P2-6.2.2", { checklist: tick("standpipe", "valvebody") }],
  ];
  for (const [clause, data] of clauseDocs) {
    await db.collection("sans1475Checklist").doc(`${COMPANY_ID}_${safeClauseKey(clause)}`).set({
      companyId: COMPANY_ID, clause, status: "", notes: "", checklist: {}, ...data, updatedAt: ts(NOW),
    });
  }

  // 2. Dated register entries: sans1475RegisterEntries, tagged by clause.
  const entry = (clause, fields, when) => db.collection("sans1475RegisterEntries").add({
    companyId: COMPANY_ID, clause, ...fields, createdAt: ts(when), createdByName: "Demo Admin",
  });

  // Materials & components log (clause 4.4 / Annex A.4) — includes a disposal,
  // which is what clause 4.7.2 (discarded powder) looks for.
  await entry("4.4", { entryType: "Purchase / restock", medType: "DCP", standardRef: "SANS 1910", supplier: "Cape Fire Supplies", batchNo: "DCP-24-0871", certRef: "COC-5521", testDate: iso(monthsAgo(5)), notes: "" }, monthsAgo(5));
  await entry("4.4", { entryType: "Purchase / restock", medType: "Foam", standardRef: "", supplier: "Cape Fire Supplies", batchNo: "FM-24-0233", certRef: "COC-5540", testDate: iso(monthsAgo(3)), notes: "" }, monthsAgo(3));
  await entry("4.4", { entryType: "Purchase / restock", medType: "Component (valve, seal, gauge, cartridge…)", standardRef: "", supplier: "Valve & Seal Co", batchNo: "V-2291", certRef: "", testDate: iso(monthsAgo(4)), notes: "Cylinder valves and O-ring kits." }, monthsAgo(4));
  await entry("4.4", { entryType: "Disposal", medType: "DCP", standardRef: "", supplier: "", batchNo: "DCP-23-0412", certRef: "DISP-0316", testDate: iso(monthsAgo(2)), notes: "Contaminated with moisture — collected by a licensed waste handler." }, monthsAgo(2));

  // PPE register (clause 4.9 protection of workmen; also serves Part 2 4.3).
  await entry("4.9", { staffId: techUid, itemType: "Gloves", issueDate: iso(monthsAgo(4)), condition: "Good", replaceBy: iso(monthsFromNow(8)), notes: "" }, monthsAgo(4));
  await entry("4.9", { staffId: techUid, itemType: "Goggles / face shield", issueDate: iso(monthsAgo(4)), condition: "Good", replaceBy: iso(monthsFromNow(20)), notes: "" }, monthsAgo(4));
  await entry("4.9", { staffId: techUid, itemType: "Respirator / dust mask", issueDate: iso(monthsAgo(7)), condition: "Needs replacement", replaceBy: iso(daysFromNow(10)), notes: "Filter due." }, monthsAgo(7));
  await entry("4.9", { staffId: competentUid, itemType: "Safety boots", issueDate: iso(monthsAgo(6)), condition: "Good", replaceBy: iso(monthsFromNow(6)), notes: "" }, monthsAgo(6));

  // Conversion & modification register (5.1.4 / 5.1.6 / Part 2 5.4).
  await entry("5.1.6", { serial: "VF-0007", workType: "Conversion", fromType: "9L Foam", toType: "9L Water", description: "Foam extinguisher converted to water; cylinder flushed, refilled and relabelled.", workDate: iso(monthsAgo(3)), technician: TECH_NAME, approvedBy: COMPETENT_NAME, notes: "" }, monthsAgo(3));
  await entry("5.1.6", { serial: "HR-2003", workType: "Repair", fromType: "", toType: "", description: "Hose reel swing arm bracket replaced.", workDate: iso(monthsAgo(1)), technician: TECH_NAME, approvedBy: COMPETENT_NAME, notes: "" }, monthsAgo(1));

  // Label photos (clause 6.1 register, tagged by what the label is used on) —
  // one photo set serves Part 1 6.1 and the Part 2 label rows. No underground
  // hydrant label: the demo doesn't service them. (No files are attached: this
  // script can't upload to Storage, so the entries are dated descriptions only.)
  await entry("6.1", { labelFor: "Extinguisher", description: "Standard maintenance label, 2026 stock", photoDate: iso(monthsAgo(2)), notes: "" }, monthsAgo(2));
  await entry("6.1", { labelFor: "Fire hose reel", description: "Hose reel maintenance label", photoDate: iso(monthsAgo(2)), notes: "" }, monthsAgo(2));
  await entry("6.1", { labelFor: "Above-ground hydrant", description: "Hydrant maintenance label", photoDate: iso(monthsAgo(1)), notes: "" }, monthsAgo(1));
  await entry("6.2", { description: "Pressure test label, current design", photoDate: iso(monthsAgo(2)), notes: "" }, monthsAgo(2));

  // Complaints register (Annex A.7.1): one closed, one still open.
  await entry("A-7.1", { complaintDate: iso(monthsAgo(3)), complainant: "Riverside Office Park", reference: "Cert CM-0412", description: "Extinguisher on the 3rd floor found without its tamper seal after maintenance.", actionTaken: "Revisited within 24 hours, seal fitted and unit re-inspected.", staffId: competentUid, status: "Closed", closedDate: iso(daysAgo(87)) }, monthsAgo(3));
  await entry("A-7.1", { complaintDate: iso(daysAgo(6)), complainant: "Bellville Depot", reference: "Cert CM-0519", description: "Maintenance certificate issued with the wrong serial number.", actionTaken: "Corrected certificate requested from the workshop.", staffId: techUid, status: "Open", closedDate: "" }, daysAgo(6));

  // Documents register (Annex A.7.2 / A.7.3): one row per procedure, tagged with
  // the clauses it covers so it shows up against each of them. 5.1.5, 5.5.3 and
  // A.6.3 are deliberately left untagged — those rows show "No evidence yet".
  // (Reference standard has no version, so document control reads 4 of 5.)
  const docs = [
    { title: "Quality manual", docType: "Policy", docRef: "QM-001", version: "3", issueDate: iso(monthsAgo(8)), reviewDate: iso(monthsFromNow(4)), owner: "Demo Admin", covers: "A-1,A-6.1" },
    { title: "Reconditioning procedure", docType: "Procedure", docRef: "RP-002", version: "2", issueDate: iso(monthsAgo(10)), reviewDate: iso(monthsFromNow(2)), owner: COMPETENT_NAME, covers: "5.1.7,P2-6.1.1,P2-6.2.1" },
    { title: "Final inspection procedure", docType: "Procedure", docRef: "FI-003", version: "1", issueDate: iso(monthsAgo(10)), reviewDate: iso(monthsFromNow(2)), owner: COMPETENT_NAME, covers: "A-6.2" },
    { title: "Reconditioning frequency schedule", docType: "Procedure", docRef: "RF-004", version: "1", issueDate: iso(monthsAgo(6)), reviewDate: iso(monthsFromNow(6)), owner: TECH_NAME, covers: "5.1.3,P2-5.3" },
    { title: "SANS 1475 reference copies", docType: "Reference standard", docRef: "REF-005", version: "", issueDate: "", reviewDate: "", owner: "Demo Admin", covers: "" },
  ];
  for (const d of docs) await entry("A-7.2", d, monthsAgo(6));

  // 3. Reconditioning jobs (drive A.6.2 final inspection and clause 5.1 / 5.4 /
  //    Part 2 5.1 & 8). Two carry the final-inspection step; one is a hose reel.
  const done = tick("stripped", "inspectcylinder", "inspectvalve", "seals", "recharged", "tested", "reassembled", "finalinspect");
  const jobs = [
    { serial: "VF-0101", equipmentType: "9kg DCP", status: "complete", received: daysAgo(40), completed: daysAgo(36), checklist: done, notes: "" },
    { serial: "VF-0102", equipmentType: "2kg CO2", status: "complete", received: daysAgo(25), completed: daysAgo(21), checklist: done, notes: "" },
    { serial: "HR-2001", equipmentType: "Hose reel", status: "complete", received: daysAgo(18), completed: daysAgo(15), checklist: done, notes: "New hose and nozzle fitted." },
    { serial: "VF-0104", equipmentType: "9L Foam", status: "in-progress", received: daysAgo(4), completed: null, checklist: tick("stripped", "inspectcylinder"), notes: "Awaiting replacement valve." },
  ];
  for (const j of jobs) {
    await db.collection("reconditioningJobs").add({
      companyId: COMPANY_ID, serial: j.serial, equipmentType: j.equipmentType,
      assignedTechnicianId: techUid, receivedDate: iso(j.received), completedDate: j.completed ? iso(j.completed) : "",
      status: j.status, checklist: j.checklist, notes: j.notes,
      createdAt: ts(j.received), updatedAt: ts(j.completed || j.received),
    });
  }

  console.log("SANS 1475 audit data created: 13 clause records, 7 registers (21 entries), 4 reconditioning jobs.");
}

/* --------------------------------- main ---------------------------------- */
async function main() {
  await wipeCompany();
  if (wipeOnly) return;

  await buildCompany();
  const { adminUid, techUid, traineeUid, competentUid } = await buildAccounts();
  const { siteAId, siteBId } = await buildSites(techUid, competentUid);
  const { siteA } = await buildEquipment(techUid, siteAId, siteBId);
  await buildTraineeRecords(adminUid, techUid, traineeUid);
  await buildMonthlyChecks(siteAId, siteA, competentUid);
  const audit = await buildAuditData(techUid, competentUid, adminUid);
  await buildSans1475Data(adminUid, techUid, competentUid);
  await buildToolboxTalks(techUid, traineeUid, competentUid, audit);

  console.log("\n=== Demo tenant ready ===");
  console.log(`Company: Vigil Fire Demo (Pty) Ltd  (companyId: ${COMPANY_ID})`);
  console.log(`Site contact / "email to site" recipient: ${contactEmail}`);
  console.log("\nLogins (all use the same password):");
  console.log(`  Admin              — email:  ${ADMIN_EMAIL}`);
  console.log(`  Technician         — number: ${TECH_NUMBER}   (${TECH_NAME})`);
  console.log(`  Trainee            — number: ${TRAINEE_NUMBER}   (${TRAINEE_NAME})`);
  console.log(`  Competent Person   — number: ${COMPETENT_NUMBER}   (${COMPETENT_NAME})`);
  console.log(`  Password (all four): ${DEMO_PASSWORD}`);
  console.log("\nRe-run this script any time to rebuild from scratch, or run with --wipe to remove it.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
