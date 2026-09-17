/**
 * One-time, local-only migration: backfills every existing company onto the
 * Vigil Core + 4 feature modules (Client / Trainee / Workshop / Auditing)
 * pricing model.
 *
 * What it does, for every companies/{id} doc that has no `modules` field
 * yet (i.e. every company that existed before this pricing model shipped):
 *   1. Sets `modules: { clientModule: true, traineeModule: true,
 *      workshopModule: true, auditingModule: true }` — every module on, so
 *      nobody already using a module's features loses them the moment the
 *      new plan-gating rules/functions go live.
 *   2. Sets a deliberately generous `addOns` object — far beyond what any
 *      real company should need — so seat/workshop counts don't suddenly
 *      block anyone either. This is a one-time grandfathering gesture, not
 *      a real plan: { extraTechnicians: 50, extraAdmins: 10,
 *      extraTrainees: 50, extraWorkshops: 20 }
 *   3. Removes old fields superseded by this model (`plan`, `billingCycle`,
 *      `seatLimit`) — nothing reads them any more.
 *   4. Mirrors `{ modules, addOns }` onto companyAddons/{id} — the doc each
 *      company's own signed-in users can actually read client-side (see
 *      firestore.rules' companyModules()/hasAuditAddon() and index.html's
 *      hasClientModule()/hasTraineeModule()/hasWorkshopModule()/
 *      hasAuditPack()).
 *
 * Safe to re-run: only companies missing `modules` are touched, so running
 * it twice is a no-op the second time.
 *
 * Usage:
 *   cd scripts
 *   npm install
 *   node migrate-to-addons-pricing.js /path/to/serviceAccountKey.json
 */

const admin = require("firebase-admin");

const keyPath = process.argv[2];
if (!keyPath) {
  console.error("Usage: node migrate-to-addons-pricing.js /path/to/serviceAccountKey.json");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(require("path").resolve(keyPath))),
});
const db = admin.firestore();

const BACKFILL_MODULES = {
  clientModule: true,
  traineeModule: true,
  workshopModule: true,
  auditingModule: true,
};
const BACKFILL_ADDONS = {
  extraTechnicians: 50,
  extraAdmins: 10,
  extraTrainees: 50,
  extraWorkshops: 20,
};

async function main() {
  console.log("Migrating existing companies onto Core + module pricing...");
  const snap = await db.collection("companies").get();
  const toMigrate = snap.docs.filter((d) => !("modules" in d.data()));
  if (toMigrate.length === 0) {
    console.log(`  companies: nothing to do (${snap.size} companies, all already migrated)`);
    return;
  }

  for (let i = 0; i < toMigrate.length; i += 450) {
    const batch = db.batch();
    toMigrate.slice(i, i + 450).forEach((d) => {
      batch.update(d.ref, {
        modules: BACKFILL_MODULES,
        addOns: BACKFILL_ADDONS,
        plan: admin.firestore.FieldValue.delete(),
        billingCycle: admin.firestore.FieldValue.delete(),
        seatLimit: admin.firestore.FieldValue.delete(),
      });
      batch.set(db.collection("companyAddons").doc(d.id), {
        modules: BACKFILL_MODULES,
        addOns: BACKFILL_ADDONS,
        plan: admin.firestore.FieldValue.delete(),
      }, { merge: true });
    });
    await batch.commit();
  }
  console.log(`  companies: migrated ${toMigrate.length} of ${snap.size}`);
  console.log("Done.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
