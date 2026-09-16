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
 *   - A few things are deliberately left *unfinished* rather than fully
 *     seeded, so you have something real to click through as each demo
 *     account: the technician/trainee/Competent Person accounts start with
 *     an INCOMPLETE profile (so you see the profile-completion gate), the
 *     trainee has one unsigned draft logbook entry, the Competent Person has
 *     no monthly check for the current month yet, one condemned unit has no
 *     action plan recorded, and one site has an outstanding recharge
 *     blocking its register. Everything else is pre-filled so reports have
 *     real content to show immediately.
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
  await db.collection("companies").doc(COMPANY_ID).set({
    name: "Vigil Fire Demo (Pty) Ltd",
    plan: "business",
    seatLimit: null,
    status: "trialing",
    createdAt: ts(NOW),
    notes: "Seeded by scripts/seed-demo.js — safe to wipe and rebuild at any time.",
    usage: { storageBytes: 0, emailsSentThisMonth: 0 },
    lastActivityAt: ts(NOW),
  });
  await db.collection("companyAddons").doc(COMPANY_ID).set({ audit: true });
  await db.collection("settings").doc(COMPANY_ID).set({
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
  console.log("Company, add-on flag and settings created.");
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
    { daysBack: 65, type: "on-the-job", site: "Blue Harbour Warehouse", work: "Assisted with de-pressurising and disassembly of a 9kg DCP unit for servicing." },
    { daysBack: 50, type: "workshop", site: "Riverside Office Park", work: "Practised internal/external cylinder inspection and identifying condemning criteria." },
    { daysBack: 35, type: "on-the-job", site: "Riverside Office Park", work: "Assisted reassembly and re-pressurising of two extinguishers after service." },
    { daysBack: 3, type: "workshop", site: "Blue Harbour Warehouse", work: "Observed final inspection and labelling of serviced units — awaiting witness sign-off." },
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
async function buildAuditData(techUid, competentUid) {
  const branchRef = db.collection("branches").doc();
  await branchRef.set({
    companyId: COMPANY_ID, name: "Head Office Workshop — Cape Town",
    address: "12 Protea Road, Century City, Cape Town, 7441", phone: "021 555 0134",
    markPermitNo: "SABS-MP-00234-B1", markPermitIssueDate: iso(monthsAgo(20)), markPermitExpiryDate: iso(monthsFromNow(16)),
    notes: "Permanent workshop — hydrostatic and high-pressure test bays, powder refill station.",
    markPermitFileURL: "", updatedAt: ts(NOW), createdAt: ts(monthsAgo(20)), active: true,
  });
  const branchId = branchRef.id;

  await db.collection("vehicles").doc().set({
    companyId: COMPANY_ID, registrationNo: "CA 123-456", description: "Toyota Hilux service vehicle",
    branchId, assignedTechnicianId: techUid,
    licenceDiskExpiry: iso(monthsFromNow(5)), roadworthyDate: iso(monthsAgo(3)),
    mobileWorkshopApprovalRef: "SABS-MW-00981", mobileWorkshopApprovalExpiry: iso(monthsFromNow(10)),
    carriedExtinguisherSerial: "VF-CARR-0042", carriedExtinguisherServiceDate: iso(monthsAgo(3)),
    notes: "", licenceDiskFileURL: "", approvalLetterFileURL: "",
    updatedAt: ts(NOW), createdAt: ts(monthsAgo(20)), active: true,
  });

  await db.collection("technicians").doc(techUid).update({
    branchId, saqccRegExpiry: iso(monthsFromNow(7)), medicalCertExpiry: iso(monthsFromNow(9)),
  });
  await db.collection("technicians").doc(competentUid).update({
    branchId, saqccRegExpiry: iso(monthsFromNow(3)), medicalCertExpiry: iso(daysFromNow(25)),
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

  await db.collection("calibrationCertificates").doc().set({
    companyId: COMPANY_ID, instrumentType: "master", instrument: "Master pressure gauge #1", instrumentSerial: "MPG-001",
    labName: "SANAS Test Lab (Pty) Ltd", labAccreditationNo: "T0999",
    calibrationDate: iso(monthsAgo(10)), nextDueDate: iso(monthsFromNow(2)),
    certificateNumber: "CAL-2025-0134", notes: "", certificateFileURL: "",
    updatedAt: ts(monthsAgo(10)), createdAt: ts(monthsAgo(10)),
  });
  await db.collection("calibrationCertificates").doc().set({
    companyId: COMPANY_ID, instrumentType: "scale", instrument: "Digital platform scale", instrumentSerial: "SCL-014",
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
      action: isFail ? "Gauge withdrawn from service, replaced with spare, workshop notified for recalibration." : "",
      technicianName: TECH_NAME, technicianSaqcc: TECH_SAQCC,
      createdBy: techUid, companyId: COMPANY_ID, createdAt: ts(checkDate),
    });
  }

  const tools = [
    ["Hydrostatic low-pressure test unit", "workshop", "HLP-2201"],
    ["Acceptable high-pressure test unit", "workshop", "HHP-1187"],
    ["2mm sieve", "workshop", "SV-004"],
    ["Drying cabinet", "workshop", "DC-002"],
    ["Inspection light", "workshop", "IL-011"],
    ["Calibrated reference masspieces set", "workshop", "RM-006"],
    ["Massmeter (0.1kg accuracy)", "technician", "MM-0.1-009"],
  ];
  const toolIds = [];
  for (const [name, ownerType, serial] of tools) {
    const ref = db.collection("tools").doc();
    await ref.set({
      companyId: COMPANY_ID, name, ownerType, serial,
      branchId: ownerType === "workshop" ? branchId : "",
      assignedTechnicianId: ownerType === "technician" ? techUid : "",
      responsibleTechnicianId: ownerType === "workshop" ? techUid : "",
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
  const audit = await buildAuditData(techUid, competentUid);
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
