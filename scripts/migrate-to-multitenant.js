/**
 * One-time, local-only migration: backfills the multi-tenant data model onto
 * the existing single-tenant Vigil Fire project.
 *
 * What it does:
 *   1. Creates a `companies/default` document (or reuses it if this has
 *      already been run once) using the existing `settings/company`
 *      letterhead's name, plan "business" (unlimited seats — this project
 *      predates the seat-limit feature), status "active".
 *   2. Copies `settings/company` to `settings/default` (the new, per-tenant
 *      path index.html reads/writes going forward).
 *   3. Adds `companyId: "default"` to every existing document in
 *      technicians, sites, equipment, logbookEntries, traineeAssignments,
 *      calibrations, monthlyChecks, serviceEvents, emailLog and
 *      traineeCompetencies that doesn't already have a companyId — so
 *      nothing already in the database is orphaned by the new tenant-scoped
 *      firestore.rules, and admin list queries (which now must filter on
 *      companyId explicitly — Firestore rejects a whole query it can't
 *      statically prove satisfies the rule) keep returning results.
 *
 * Safe to re-run: every write only touches documents missing a companyId, so
 * running it twice is a no-op the second time.
 *
 * Not deployed anywhere — this is a developer-run script, never a Cloud
 * Function. It needs a service account key with access to the vigil-fire
 * Firebase project (Firebase Console → Project settings → Service accounts
 * → Generate new private key), which is NOT checked into git.
 *
 * Usage:
 *   cd scripts
 *   npm install
 *   node migrate-to-multitenant.js /path/to/serviceAccountKey.json
 */

const admin = require("firebase-admin");

const keyPath = process.argv[2];
if (!keyPath) {
  console.error("Usage: node migrate-to-multitenant.js /path/to/serviceAccountKey.json");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(require("path").resolve(keyPath))),
});
const db = admin.firestore();

const DEFAULT_COMPANY_ID = "default";

// [collection name, id field style] — all are auto-ID docs except where noted.
const COMPANY_ID_COLLECTIONS = [
  "technicians",
  "sites",
  "equipment",
  "logbookEntries",
  "traineeAssignments",
  "calibrations",
  "monthlyChecks",
  "serviceEvents",
  "emailLog",
  "traineeCompetencies",
];

async function backfillCollection(collectionName) {
  const snap = await db.collection(collectionName).get();
  const toUpdate = snap.docs.filter((d) => !d.data().companyId);
  if (toUpdate.length === 0) {
    console.log(`  ${collectionName}: nothing to do (${snap.size} docs, all already tagged)`);
    return;
  }
  // Firestore batches cap at 500 writes.
  for (let i = 0; i < toUpdate.length; i += 450) {
    const batch = db.batch();
    toUpdate.slice(i, i + 450).forEach((d) => batch.update(d.ref, { companyId: DEFAULT_COMPANY_ID }));
    await batch.commit();
  }
  console.log(`  ${collectionName}: tagged ${toUpdate.length} of ${snap.size} docs`);
}

async function main() {
  console.log(`Migrating vigil-fire to multi-tenant under company "${DEFAULT_COMPANY_ID}"...`);

  const companyRef = db.collection("companies").doc(DEFAULT_COMPANY_ID);
  const companySnap = await companyRef.get();
  if (!companySnap.exists) {
    let letterheadName = "My Company";
    try {
      const legacySettings = await db.collection("settings").doc("company").get();
      if (legacySettings.exists && legacySettings.data().name) {
        letterheadName = legacySettings.data().name;
      }
    } catch (e) {
      /* fine — fall back to the default name */
    }
    await companyRef.set({
      name: letterheadName,
      plan: "business",
      seatLimit: null,
      status: "active",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      notes: "Created by migrate-to-multitenant.js from pre-existing single-tenant data.",
      usage: { storageBytes: 0, emailsSentThisMonth: 0 },
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`  companies/${DEFAULT_COMPANY_ID}: created ("${letterheadName}")`);
  } else {
    console.log(`  companies/${DEFAULT_COMPANY_ID}: already exists, leaving as-is`);
  }

  const newSettingsRef = db.collection("settings").doc(DEFAULT_COMPANY_ID);
  const newSettingsSnap = await newSettingsRef.get();
  if (!newSettingsSnap.exists) {
    const legacySettings = await db.collection("settings").doc("company").get();
    if (legacySettings.exists) {
      await newSettingsRef.set(legacySettings.data());
      console.log(`  settings/${DEFAULT_COMPANY_ID}: copied from settings/company`);
    } else {
      console.log(`  settings/${DEFAULT_COMPANY_ID}: no legacy settings/company to copy — skipped`);
    }
  } else {
    console.log(`  settings/${DEFAULT_COMPANY_ID}: already exists, leaving as-is`);
  }

  for (const collectionName of COMPANY_ID_COLLECTIONS) {
    await backfillCollection(collectionName);
  }

  console.log("Done. The legacy settings/company document was left in place (unused) — delete it manually once you've confirmed the app reads settings/" + DEFAULT_COMPANY_ID + " correctly.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
