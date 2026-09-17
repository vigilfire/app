/**
 * One-time, local-only migration: backfills every existing company onto the
 * 4-plan (inspection/starter/growth/business) + à la carte add-ons pricing
 * model.
 *
 * What it does, for every companies/{id} doc that has no `addOns` field yet
 * (i.e. every company that existed before this pricing model shipped):
 *   1. Sets `plan: 'business'` (the most generous named plan) and
 *      `billingCycle: 'monthly'`.
 *   2. Sets a deliberately generous `addOns` object — far beyond what any
 *      real company should need — so nobody already using the app loses
 *      access to anything the moment the new plan-gating rules/functions
 *      go live. This is a one-time grandfathering gesture, not a real plan:
 *      { extraTechnicians: 50, extraAdmins: 10, traineeLogbooks: 50,
 *        auditPackWorkshops: 20 }
 *   3. Removes the old flat `seatLimit` field (superseded by plan +
 *      add-ons; nothing reads it any more).
 *   4. Mirrors `{ plan, addOns }` onto companyAddons/{id} — the doc each
 *      company's own signed-in users can actually read client-side (see
 *      firestore.rules' companyAddOns()/hasAuditAddon() and index.html's
 *      hasAuditPack()/brandingRemoved()).
 *
 * One real gap worth knowing about: the Business plan's built-in
 * `competentPersons` allowance is 0 (that role is deliberately
 * Inspection-plan-exclusive, with no add-on route to raise it elsewhere —
 * see functions/pricing.js). If a company already has an active Competent
 * Person account, this migration does NOT touch or deactivate it — existing
 * accounts keep working regardless of plan, since the limit is only checked
 * at account-*creation* time. It just means that company couldn't create a
 * *new* one, or reactivate a deactivated one, without a superadmin
 * switching it to the Inspection plan first (which would then conflict
 * with any technicians the same company has, since Inspection has none).
 * Flag this to whoever owns pricing if it's a real company, not just a demo.
 *
 * Safe to re-run: only companies missing `addOns` are touched, so running
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

const BACKFILL_ADDONS = {
  extraTechnicians: 50,
  extraAdmins: 10,
  traineeLogbooks: 50,
  auditPackWorkshops: 20,
};
const BACKFILL_PLAN = "business";

async function main() {
  console.log("Migrating existing companies onto plan + add-ons pricing...");
  const snap = await db.collection("companies").get();
  const toMigrate = snap.docs.filter((d) => !("addOns" in d.data()));
  if (toMigrate.length === 0) {
    console.log(`  companies: nothing to do (${snap.size} companies, all already migrated)`);
    return;
  }

  for (let i = 0; i < toMigrate.length; i += 450) {
    const batch = db.batch();
    toMigrate.slice(i, i + 450).forEach((d) => {
      batch.update(d.ref, {
        plan: BACKFILL_PLAN,
        billingCycle: "monthly",
        addOns: BACKFILL_ADDONS,
        seatLimit: admin.firestore.FieldValue.delete(),
      });
      batch.set(db.collection("companyAddons").doc(d.id), {
        plan: BACKFILL_PLAN,
        addOns: BACKFILL_ADDONS,
      }, { merge: true });
    });
    await batch.commit();
  }
  console.log(`  companies: migrated ${toMigrate.length} of ${snap.size}`);
  console.log("Done.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
