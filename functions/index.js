/**
 * Vigil Fire — Cloud Functions
 *
 * emailSiteDocuments: an admin-only callable that renders the site register
 * and/or service certificate (HTML built by the web app) to PDF with headless
 * Chromium, emails them to the site as attachments via Resend, and writes an
 * audit entry to the `emailLog` collection.
 *
 * Setup and deploy steps are in ../SETUP.md ("Emailing the register &
 * certificate").
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { PLAN_SEAT_LIMITS, VALID_PLANS } = require("./planConstants");

// NB: @sparticuz/chromium, puppeteer-core and resend are require()d lazily
// inside the handler, not here. Loading them at module scope pushes cold-start /
// deploy-time source analysis past Firebase's 10s discovery budget.

admin.initializeApp();

// Secret — set with: firebase functions:secrets:set RESEND_API_KEY
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// Non-secret config, read at runtime from functions/.env (git-ignored) with
// sensible defaults. Until a domain is verified in Resend, EMAIL_FROM stays as
// the Resend onboarding sender and mail only reaches the Resend account owner's
// own address; after verifying e.g. vigilfire.co.za, set
//   EMAIL_FROM="Vigil Fire <certificates@vigilfire.co.za>"
// in functions/.env and redeploy. EMAIL_REPLY_TO blank => use the company email
// from settings/company (so a client's reply reaches the servicing company).
const DEFAULT_EMAIL_FROM = "Vigil Fire <onboarding@resend.dev>";
function emailFrom() {
  return (process.env.EMAIL_FROM || "").trim() || DEFAULT_EMAIL_FROM;
}
function emailReplyToOverride() {
  return (process.env.EMAIL_REPLY_TO || "").trim();
}

const MAX_DOCUMENTS = 3;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB of HTML per document

// Same fabricated domain the app has always used for a technician-number
// login (there's no real inbox behind it — sign-in resolves the number to
// this address via `technicianLookup`, never by the user typing an email).
const TECH_EMAIL_DOMAIN = "technicians.invalid";

// The one account allowed to ever hold the `superadmin` custom claim, i.e.
// the only account that can reach the internal /admin section. Set via
// SUPERADMIN_EMAIL in functions/.env if you ever need to change it without
// editing source.
function superadminEmail() {
  return (process.env.SUPERADMIN_EMAIL || "").trim() || "vigilfire1@gmail.com";
}

async function requireSuperadmin(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  if (request.auth.token.role !== "superadmin") {
    throw new HttpsError(
      "permission-denied",
      "This account is not authorised for the admin section."
    );
  }
}

async function renderPdf(html, landscape) {
  const chromium = require("@sparticuz/chromium");
  const puppeteer = require("puppeteer-core");

  // Skip the WebGL / graphics stack — we only render static HTML, and this
  // keeps the Chromium memory footprint down. Harmless if not supported.
  try {
    chromium.setGraphicsMode = false;
  } catch (e) {
    /* older @sparticuz/chromium — ignore */
  }

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    defaultViewport: { width: 1240, height: 1754 },
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    return await page.pdf({
      format: "A4",
      landscape: !!landscape,
      printBackground: true,
      margin: { top: "12mm", bottom: "14mm", left: "10mm", right: "10mm" },
    });
  } finally {
    await browser.close();
  }
}

exports.emailSiteDocuments = onCall(
  // Chromium needs headroom: it extracts a ~150 MB binary to /tmp and renders
  // in-process. 2 GiB keeps this reliable; the function only runs on demand.
  { secrets: [RESEND_API_KEY], memory: "2GiB", timeoutSeconds: 120 },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Sign in first.");
    }

    const db = admin.firestore();

    const techSnap = await db.collection("technicians").doc(uid).get();
    if (!techSnap.exists || techSnap.data().role !== "admin") {
      throw new HttpsError(
        "permission-denied",
        "Only an administrator can email site documents."
      );
    }
    const techData = techSnap.data();

    const data = request.data || {};
    const siteId = String(data.siteId || "").trim();
    const to = String(data.to || "").trim();
    const message = String(data.message || "").slice(0, 2000);
    const documents = Array.isArray(data.documents) ? data.documents : [];

    if (!siteId) {
      throw new HttpsError("invalid-argument", "Missing siteId.");
    }
    if (!/^\S+@\S+\.\S+$/.test(to)) {
      throw new HttpsError("invalid-argument", "Invalid recipient address.");
    }
    if (documents.length === 0) {
      throw new HttpsError("invalid-argument", "No documents to send.");
    }
    if (documents.length > MAX_DOCUMENTS) {
      throw new HttpsError("invalid-argument", "Too many documents in one email.");
    }

    const siteSnap = await db.collection("sites").doc(siteId).get();
    if (!siteSnap.exists) {
      throw new HttpsError("not-found", "Site not found.");
    }
    const site = siteSnap.data();
    if (site.companyId !== techData.companyId) {
      // An admin may only email documents for a site in their own company —
      // otherwise this callable would let any company's admin reach any
      // other company's sites, since role alone isn't tenant-scoped.
      throw new HttpsError(
        "permission-denied",
        "Only an administrator can email site documents."
      );
    }

    let company = {};
    try {
      const c = await db.collection("settings").doc(site.companyId || "").get();
      if (c.exists) company = c.data();
    } catch (e) {
      logger.warn("Could not read the company letterhead for the sender name", e);
    }

    // Render each document to a PDF attachment.
    const attachments = [];
    const kinds = [];
    for (const d of documents) {
      const html = String(d.html || "");
      const kind = String(d.kind || "document");
      const filename = String(d.filename || `${kind}.pdf`).replace(
        /[^\w.\-]+/g,
        "_"
      );
      if (!html || Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
        throw new HttpsError(
          "invalid-argument",
          `Document "${filename}" is missing or too large.`
        );
      }
      let pdf;
      try {
        pdf = await renderPdf(html, d.landscape);
      } catch (e) {
        logger.error("PDF render failed", { kind, error: e.message });
        throw new HttpsError(
          "internal",
          `Could not render the ${kind} to PDF.`
        );
      }
      attachments.push({ filename, content: Buffer.from(pdf) });
      kinds.push(kind);
    }

    const companyName = company.name || "Vigil Fire";
    const subject =
      `${companyName} — ${site.name || "site"} — fire equipment ` +
      kinds.join(" & ");
    const bodyText = [
      message ||
        `Please find attached the fire equipment ${kinds.join(" and ")} for ` +
          `${site.name || "your site"}.`,
      "",
      companyName,
      [company.phone, company.email].filter(Boolean).join("  ·  "),
    ]
      .join("\n")
      .trim();

    const replyTo = emailReplyToOverride() || company.email || undefined;

    const { Resend } = require("resend");
    const resend = new Resend(RESEND_API_KEY.value());
    let providerMessageId = null;
    let status = "sent";
    let errorText = null;

    try {
      const sendRes = await resend.emails.send({
        from: emailFrom(),
        to: [to],
        replyTo,
        subject,
        text: bodyText,
        attachments,
      });
      if (sendRes.error) {
        status = "failed";
        errorText = sendRes.error.message || String(sendRes.error);
      } else {
        providerMessageId = (sendRes.data && sendRes.data.id) || null;
      }
    } catch (e) {
      status = "failed";
      errorText = e.message || String(e);
    }

    // Audit entry — written whether or not the provider accepted the message.
    const logRef = await db.collection("emailLog").add({
      siteId,
      companyId: site.companyId || null,
      siteName: site.name || "",
      sentBy: uid,
      sentByName: techData.name || "",
      recipients: [to],
      documents: kinds,
      provider: "resend",
      providerMessageId,
      status,
      error: errorText,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      sentAtMs: Date.now(),
    });

    if (status === "failed") {
      throw new HttpsError(
        "internal",
        errorText || "The email provider rejected the message."
      );
    }

    return { status, emailLogId: logRef.id, providerMessageId };
  }
);

/* ========================================================================
   Internal /admin section (separate admin.html, superadmin-only — see
   SETUP.md). Three callables: grant the one-time custom claim to the
   operator's own account, provision a new tenant company, and provision a
   technician while enforcing that company's seat limit.
   ======================================================================== */

exports.grantSuperadmin = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const email = (request.auth.token.email || "").toLowerCase();
  if (email !== superadminEmail().toLowerCase()) {
    throw new HttpsError(
      "permission-denied",
      "This account is not authorised for the admin section."
    );
  }
  await admin.auth().setCustomUserClaims(request.auth.uid, { role: "superadmin" });
  return { granted: true };
});

exports.createCompany = onCall({ secrets: [RESEND_API_KEY] }, async (request) => {
  await requireSuperadmin(request);

  const data = request.data || {};
  const name = String(data.name || "").trim();
  const adminEmail = String(data.adminEmail || "").trim();
  const adminName = String(data.adminName || "").trim();
  const plan = String(data.plan || "starter").trim();

  if (!name) throw new HttpsError("invalid-argument", "Company name is required.");
  if (!/^\S+@\S+\.\S+$/.test(adminEmail)) {
    throw new HttpsError("invalid-argument", "A valid admin email is required.");
  }
  if (!adminName) throw new HttpsError("invalid-argument", "Admin name is required.");
  if (!VALID_PLANS.includes(plan)) throw new HttpsError("invalid-argument", "Unknown plan.");

  const db = admin.firestore();
  const companyRef = db.collection("companies").doc();
  const companyId = companyRef.id;

  // Never emailed or returned to the caller — the admin sets their own
  // password via the reset link sent below, same as a normal "forgot
  // password" flow.
  const tempPassword = crypto.randomBytes(24).toString("base64url");
  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email: adminEmail,
      password: tempPassword,
      displayName: adminName,
    });
  } catch (e) {
    throw new HttpsError(
      "already-exists",
      e.message || "Could not create the admin account — that email may already be in use."
    );
  }
  await admin.auth().setCustomUserClaims(userRecord.uid, { companyId, role: "admin" });

  const batch = db.batch();
  batch.set(companyRef, {
    name,
    plan,
    seatLimit: PLAN_SEAT_LIMITS[plan],
    status: "trialing",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    notes: "",
    usage: { storageBytes: 0, emailsSentThisMonth: 0 },
    lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  batch.set(db.collection("technicians").doc(userRecord.uid), {
    name: adminName,
    email: adminEmail,
    role: "admin",
    companyId,
    active: true,
    canCalibrate: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await batch.commit();

  // Best-effort: the company and account already exist even if this send
  // fails — the operator can trigger a normal Firebase Console password
  // reset instead.
  let emailWarning = null;
  try {
    const resetLink = await admin.auth().generatePasswordResetLink(adminEmail);
    const { Resend } = require("resend");
    const resend = new Resend(RESEND_API_KEY.value());
    const sendRes = await resend.emails.send({
      from: emailFrom(),
      to: [adminEmail],
      subject: `You're set up on Vigil Fire — ${name}`,
      text: [
        `Hi ${adminName},`,
        "",
        `An administrator account for "${name}" has been created on Vigil Fire.`,
        "Set your password here, then sign in at the app with this email address:",
        resetLink,
      ].join("\n"),
    });
    if (sendRes.error) emailWarning = sendRes.error.message || String(sendRes.error);
  } catch (e) {
    emailWarning = e.message || String(e);
    logger.error("createCompany: could not email the new admin", e);
  }

  return { companyId, uid: userRecord.uid, emailWarning };
});

exports.createTechnician = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const db = admin.firestore();

  const callerSnap = await db.collection("technicians").doc(uid).get();
  if (!callerSnap.exists || callerSnap.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Only an administrator can add technicians.");
  }
  const companyId = callerSnap.data().companyId;
  if (!companyId) {
    throw new HttpsError("failed-precondition", "Your account has no company on file.");
  }

  const data = request.data || {};
  const name = String(data.name || "").trim();
  const techNumber = String(data.techNumber || "").trim();
  const password = String(data.password || "");
  const saqcc = String(data.saqcc || "").trim();
  const phone = String(data.phone || "").trim();
  const canCalibrate = !!data.canCalibrate;
  const role = data.role === "trainee" ? "trainee" : "technician";
  const traineeRegisteredDate = role === "trainee" ? data.traineeRegisteredDate || null : null;

  if (!name || !techNumber) {
    throw new HttpsError("invalid-argument", "Name and technician number are required.");
  }
  if (!password || password.length < 6) {
    throw new HttpsError("invalid-argument", "Set a password of at least 6 characters.");
  }

  const lookupRef = db.collection("technicianLookup").doc(techNumber);
  const lookupSnap = await lookupRef.get();
  if (lookupSnap.exists) {
    throw new HttpsError("already-exists", "That technician number is already in use.");
  }

  // Seat-limit check. This has to live here, not in a Firestore rule: a rule
  // can restrict a single write but can't reliably count how many
  // technicians a company already has before allowing the next one.
  // Only active technicians occupy a seat — deactivating someone (the app's
  // "remove a technician" action) keeps their Firestore doc for compliance
  // history but must free up their seat immediately, or a company could
  // never replace someone they let go without upgrading their plan.
  const companySnap = await db.collection("companies").doc(companyId).get();
  const seatLimit = companySnap.exists ? companySnap.data().seatLimit : undefined;
  if (seatLimit !== null && seatLimit !== undefined) {
    const countSnap = await db
      .collection("technicians")
      .where("companyId", "==", companyId)
      .where("active", "==", true)
      .count()
      .get();
    if (countSnap.data().count >= seatLimit) {
      throw new HttpsError(
        "resource-exhausted",
        `Seat limit reached (${seatLimit}). Upgrade the plan or deactivate a technician first.`
      );
    }
  }

  const email = `tech${techNumber}@${TECH_EMAIL_DOMAIN}`;
  let userRecord;
  try {
    userRecord = await admin.auth().createUser({ email, password, displayName: name });
  } catch (e) {
    throw new HttpsError("already-exists", e.message || "Could not create the account.");
  }

  const batch = db.batch();
  batch.set(db.collection("technicians").doc(userRecord.uid), {
    name,
    techNumber,
    email,
    role,
    saqcc,
    phone,
    active: true,
    canCalibrate,
    companyId,
    ...(traineeRegisteredDate ? { traineeRegisteredDate } : {}),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  batch.set(lookupRef, { email });
  await batch.commit();

  return { uid: userRecord.uid };
});

/* ---------- Company `lastActivityAt` ----------
   Bumped whenever any user in a company writes to one of these tenant-scoped
   collections, so /admin's "active this month" figure reflects real usage.
   `companies` itself is superadmin/Cloud-Function-only (see firestore.rules),
   so this can't be a client write — it has to be a trigger. One handler
   registered per collection; each is a cheap no-op unless the written
   document carries a companyId. */
const ACTIVITY_COLLECTIONS = [
  "sites", "equipment", "logbookEntries", "calibrations",
  "monthlyChecks", "serviceEvents", "traineeAssignments",
  "technicians", "emailLog", "traineeCompetencies",
];
ACTIVITY_COLLECTIONS.forEach((collectionId) => {
  exports[`bumpActivity_${collectionId}`] = onDocumentWritten(
    `${collectionId}/{docId}`,
    async (event) => {
      const after = event.data && event.data.after;
      const before = event.data && event.data.before;
      const doc =
        (after && after.exists && after.data()) ||
        (before && before.exists && before.data());
      const companyId = doc && doc.companyId;
      if (!companyId) return;
      await admin
        .firestore()
        .collection("companies")
        .doc(companyId)
        .set({ lastActivityAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
  );
});
