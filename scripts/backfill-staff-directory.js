/**
 * One-time, local-only backfill: writes a staffDirectory/{uid} entry for
 * every existing technicians/{uid} doc.
 *
 * The `syncStaffDirectory` Cloud Function keeps staffDirectory in step from
 * then on, but it only fires on a write — staff who already exist get no
 * entry until their doc next changes. Without one, a trainee can't see that
 * technician in the witness dropdown and nobody can invite them to a
 * toolbox talk, once the tightened technicians read rule is deployed.
 *
 * Run it AFTER deploying the functions and BEFORE deploying firestore.rules.
 * Also deactivates (disables the Auth login of) every account whose
 * technicians doc already says active:false — before this change,
 * deactivation only flipped the flag and left the login working — and
 * mirrors each company's status onto companyAddons (for the read-only banner).
 *
 * Safe to re-run: it overwrites each entry with the current values.
 *
 * Usage:
 *   cd scripts
 *   npm install
 *   node backfill-staff-directory.js /path/to/serviceAccountKey.json
 */

const admin = require("firebase-admin");

const keyPath = process.argv[2];
if (!keyPath) {
  console.error("Usage: node backfill-staff-directory.js /path/to/serviceAccountKey.json");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(require("path").resolve(keyPath))),
});
const db = admin.firestore();

// Must match staffDirectoryEntry() in functions/index.js.
function staffDirectoryEntry(t) {
  return {
    name: t.name || "",
    role: t.role || "",
    companyId: t.companyId || null,
    active: t.active !== false,
    saqcc: t.saqcc || "",
  };
}

async function main() {
  console.log("Backfilling staffDirectory...");
  const snap = await db.collection("technicians").get();
  for (let i = 0; i < snap.docs.length; i += 450) {
    const batch = db.batch();
    snap.docs.slice(i, i + 450).forEach((d) => {
      batch.set(db.collection("staffDirectory").doc(d.id), staffDirectoryEntry(d.data()));
    });
    await batch.commit();
  }
  console.log(`  staffDirectory: wrote ${snap.size} entries`);

  const inactive = snap.docs.filter((d) => d.data().active === false);
  let disabled = 0;
  for (const d of inactive) {
    try {
      await admin.auth().updateUser(d.id, { disabled: true });
      await admin.auth().revokeRefreshTokens(d.id);
      disabled++;
    } catch (e) {
      console.warn(`  could not disable ${d.id}: ${e.message}`);
    }
  }
  console.log(`  deactivated accounts: disabled ${disabled} of ${inactive.length} logins`);

  // Mirror each company's billing status onto companyAddons/{id}, which the
  // app can read, so a canceled company sees the read-only banner. admin.html
  // keeps it in step from now on whenever the status changes.
  const companies = await db.collection("companies").get();
  for (let i = 0; i < companies.docs.length; i += 450) {
    const batch = db.batch();
    companies.docs.slice(i, i + 450).forEach((d) => {
      batch.set(db.collection("companyAddons").doc(d.id), { status: d.data().status || "trialing" }, { merge: true });
    });
    await batch.commit();
  }
  console.log(`  companyAddons: mirrored status for ${companies.size} companies`);
  console.log("Done.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
