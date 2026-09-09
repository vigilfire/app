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

function isValidEmail(s) {
  return /^\S+@\S+\.\S+$/.test(s);
}

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
    if (!isValidEmail(to)) {
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
  if (!isValidEmail(adminEmail)) {
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

// Shared by createTechnician and reactivateTechnician — both need "is this
// caller an admin, and which company are they admin of."
async function requireCompanyAdmin(db, uid) {
  const snap = await db.collection("technicians").doc(uid).get();
  if (!snap.exists || snap.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Only an administrator can do this.");
  }
  const companyId = snap.data().companyId;
  if (!companyId) {
    throw new HttpsError("failed-precondition", "Your account has no company on file.");
  }
  return companyId;
}

// Shared seat-limit check — throws if the company has no free seat. Only
// active technicians occupy a seat, so deactivating someone frees theirs
// immediately; reactivating is charged against the limit exactly like
// creating a new technician is.
async function requireSeatAvailable(db, companyId) {
  const companySnap = await db.collection("companies").doc(companyId).get();
  const seatLimit = companySnap.exists ? companySnap.data().seatLimit : undefined;
  if (seatLimit === null || seatLimit === undefined) return;
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

exports.createTechnician = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const db = admin.firestore();
  const companyId = await requireCompanyAdmin(db, uid);

  const data = request.data || {};
  const name = String(data.name || "").trim();
  const techNumber = String(data.techNumber || "").trim();
  const password = String(data.password || "");
  const saqcc = String(data.saqcc || "").trim();
  const phone = String(data.phone || "").trim();
  const canCalibrate = !!data.canCalibrate;
  const VALID_TECH_ROLES = ["technician", "trainee", "competent"];
  const role = VALID_TECH_ROLES.includes(data.role) ? data.role : "technician";
  const traineeRegisteredDate = role === "trainee" ? data.traineeRegisteredDate || null : null;

  if (!name || !techNumber) {
    throw new HttpsError("invalid-argument", "Name and technician number are required.");
  }
  if (!password || password.length < 6) {
    throw new HttpsError("invalid-argument", "Set a password of at least 6 characters.");
  }
  // POPIA: the admin creating this account attests the person has been
  // informed and consents (see the Privacy notice link next to the checkbox
  // in index.html) — checked here too, not just in the client, since this is
  // the actual account-creation path.
  if (!data.consentConfirmed) {
    throw new HttpsError(
      "failed-precondition",
      "Confirm the technician has been informed and consents before creating their account."
    );
  }

  const lookupRef = db.collection("technicianLookup").doc(techNumber);
  const lookupSnap = await lookupRef.get();
  if (lookupSnap.exists) {
    throw new HttpsError("already-exists", "That technician number is already in use.");
  }

  // Seat-limit check. This has to live here, not in a Firestore rule: a rule
  // can restrict a single write but can't reliably count how many
  // technicians a company already has before allowing the next one.
  await requireSeatAvailable(db, companyId);

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
    consentConfirmedBy: uid,
    consentConfirmedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  batch.set(lookupRef, { email, companyId });
  await batch.commit();

  return { uid: userRecord.uid };
});

exports.reactivateTechnician = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const db = admin.firestore();
  const companyId = await requireCompanyAdmin(db, uid);

  const targetId = String((request.data || {}).id || "").trim();
  if (!targetId) {
    throw new HttpsError("invalid-argument", "Missing technician id.");
  }
  const targetRef = db.collection("technicians").doc(targetId);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists || targetSnap.data().companyId !== companyId) {
    throw new HttpsError("not-found", "Technician not found.");
  }
  if (targetSnap.data().active !== false) {
    return { reactivated: false }; // already active — nothing to do
  }

  // Reactivating occupies a seat exactly like creating a new technician does
  // — this is why firestore.rules blocks the active:false→true transition
  // for a plain client update and routes it here instead.
  await requireSeatAvailable(db, companyId);
  await targetRef.update({ active: true });
  return { reactivated: true };
});

// The caller's real IP/user-agent — only trustworthy read here, server-side
// off the raw request, never from a client-supplied field (which would be
// trivial to fake and would defeat the point of capturing it at all).
function getCallerIp(request) {
  const req = request.rawRequest;
  if (!req) return "unknown";
  const xff = req.headers && req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.ip || "unknown";
}
function getUserAgent(request) {
  const req = request.rawRequest;
  return (req && req.headers && req.headers["user-agent"]) || "unknown";
}

async function requireProfileComplete(snap, actionLabel) {
  if (!snap.exists || !snap.data().profileCompletedAt) {
    throw new HttpsError(
      "failed-precondition",
      `Complete your profile (ID number, cell number, email and both photos) on this device before you can ${actionLabel}.`
    );
  }
}

/* ---------- Fraud-tracking profile completion ----------
   The admin creates the account with just name/SAQCC number; the technician
   or trainee fills in the rest (ID number, cell, email, profile photo, SAQCC
   card photo) themselves, once, on the device they'll actually use. This
   callable stamps the caller's real IP and a client-generated device id onto
   their own record as a baseline — signLogbookEntry / createLogbookEntry
   later capture the same two things again, so the training centre can
   compare "the device that set up this account" against "the device that
   actually signed this entry." Re-completing (e.g. a genuine new phone)
   keeps working, but the previous device/IP is archived into deviceHistory
   rather than silently overwritten, since a profile "moving" between devices
   is itself something worth being able to review. */
exports.completeMyProfile = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const db = admin.firestore();
  const selfRef = db.collection("technicians").doc(uid);
  const selfSnap = await selfRef.get();
  if (!selfSnap.exists) {
    throw new HttpsError("not-found", "Profile not found.");
  }

  const existing = selfSnap.data();
  const isTrainee = existing.role === "trainee";
  const isCompetent = existing.role === "competent";

  const data = request.data || {};
  const idNumber = String(data.idNumber || "").trim();
  const cellNumber = String(data.cellNumber || "").trim();
  const contactEmail = String(data.contactEmail || "").trim();
  const profilePhotoURL = String(data.profilePhotoURL || "").trim();
  const saqccCardPhotoURL = String(data.saqccCardPhotoURL || "").trim();
  const trainingCertificateDate = String(data.trainingCertificateDate || "").trim();
  const trainingCertificatePhotoURL = String(data.trainingCertificatePhotoURL || "").trim();
  const appointmentLetterPhotoURL = String(data.appointmentLetterPhotoURL || "").trim();
  const deviceId = String(data.deviceId || "").trim();

  if (!idNumber || !cellNumber || !contactEmail || !profilePhotoURL) {
    throw new HttpsError("invalid-argument", "ID number, cell number, email and a profile photo are required.");
  }
  // A trainee doesn't have a SAQCC card yet — they give the date on and a
  // photo of their training certificate instead, since that's what starts
  // the 6–24 month SAQCC completion window (a technician's card has no such
  // window attached, so it doesn't need a date). A Competent Person has
  // neither — the document that actually makes them the SANS 10105-1
  // responsible person is their employer's written appointment letter.
  if (isTrainee) {
    if (!trainingCertificateDate || !trainingCertificatePhotoURL) {
      throw new HttpsError("invalid-argument", "Your training certificate date and photo are required.");
    }
  } else if (isCompetent) {
    if (!appointmentLetterPhotoURL) {
      throw new HttpsError("invalid-argument", "A photo of your appointment letter is required.");
    }
  } else if (!saqccCardPhotoURL) {
    throw new HttpsError("invalid-argument", "A photo of your SAQCC registration card is required.");
  }
  if (!isValidEmail(contactEmail)) {
    throw new HttpsError("invalid-argument", "Enter a valid email address.");
  }
  if (!deviceId) {
    throw new HttpsError("invalid-argument", "Missing device id — reload the app and try again.");
  }

  const update = {
    idNumber, cellNumber, contactEmail, profilePhotoURL,
    trustedDeviceId: deviceId,
    profileCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
    profileCompletedIp: getCallerIp(request),
    profileCompletedUserAgent: getUserAgent(request),
    ...(isTrainee
      ? { trainingCertificateDate, trainingCertificatePhotoURL }
      : isCompetent
      ? { appointmentLetterPhotoURL }
      : { saqccCardPhotoURL }),
  };
  if (existing.profileCompletedAt) {
    update.deviceHistory = admin.firestore.FieldValue.arrayUnion({
      trustedDeviceId: existing.trustedDeviceId || null,
      profileCompletedAt: existing.profileCompletedAt,
      profileCompletedIp: existing.profileCompletedIp || null,
      replacedAt: Date.now(),
    });
  }
  await selfRef.update(update);
  return { completed: true };
});

/* ---------- Logbook create / sign — moved server-side for fraud tracking ----------
   Both used to be plain client Firestore writes; they're callables now so the
   device-id the client reports can be paired with a real, server-observed IP
   in the same write, and so profile completion can be required before either
   one succeeds (see requireProfileComplete). */
exports.createLogbookEntry = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const db = admin.firestore();
  const traineeSnap = await db.collection("technicians").doc(uid).get();
  if (!traineeSnap.exists) {
    throw new HttpsError("not-found", "Profile not found.");
  }
  await requireProfileComplete(traineeSnap, "log an entry");
  const traineeData = traineeSnap.data();
  const companyId = traineeData.companyId;

  const data = request.data || {};
  const date = String(data.date || "").trim();
  const trainingType = data.trainingType === "workshop" ? "workshop" : "on-the-job";
  const siteClient = String(data.siteClient || "").trim();
  const workPerformed = String(data.workPerformed || "").trim();
  const technicianId = String(data.technicianId || "").trim();
  const deviceId = String(data.deviceId || "").trim();

  if (!date) throw new HttpsError("invalid-argument", "Pick a date.");
  if (!workPerformed) throw new HttpsError("invalid-argument", "Describe the work performed.");
  if (!technicianId) throw new HttpsError("invalid-argument", "Choose the technician who witnessed this.");
  if (!deviceId) throw new HttpsError("invalid-argument", "Missing device id — reload the app and try again.");

  const witnessSnap = await db.collection("technicians").doc(technicianId).get();
  if (!witnessSnap.exists || witnessSnap.data().role !== "technician" || witnessSnap.data().companyId !== companyId) {
    throw new HttpsError("invalid-argument", "Choose a registered technician from your own company.");
  }
  const witness = witnessSnap.data();

  const ref = db.collection("logbookEntries").doc();
  await ref.set({
    traineeId: uid,
    traineeName: traineeData.name || "",
    traineeNumber: traineeData.techNumber || "",
    date, trainingType, siteClient, workPerformed,
    technicianId,
    technicianName: witness.name || "",
    technicianSaqcc: witness.saqcc || "",
    status: "draft",
    companyId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdIp: getCallerIp(request),
    createdDeviceId: deviceId,
    createdUserAgent: getUserAgent(request),
  });
  return { id: ref.id };
});

exports.signLogbookEntry = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const db = admin.firestore();
  const techSnap = await db.collection("technicians").doc(uid).get();
  if (!techSnap.exists) {
    throw new HttpsError("not-found", "Profile not found.");
  }
  await requireProfileComplete(techSnap, "sign off a logbook entry");
  const techData = techSnap.data();

  const data = request.data || {};
  const entryId = String(data.id || "").trim();
  const comments = String(data.comments || "").trim();
  const deviceId = String(data.deviceId || "").trim();
  if (!entryId) throw new HttpsError("invalid-argument", "Missing entry id.");
  if (!deviceId) throw new HttpsError("invalid-argument", "Missing device id — reload the app and try again.");

  const entryRef = db.collection("logbookEntries").doc(entryId);
  const entrySnap = await entryRef.get();
  if (!entrySnap.exists) {
    throw new HttpsError("not-found", "Entry not found.");
  }
  const entry = entrySnap.data();
  if (entry.technicianId !== uid) {
    throw new HttpsError("permission-denied", "You are not the named witness for this entry.");
  }
  if (entry.status !== "draft") {
    throw new HttpsError("failed-precondition", "This entry has already been signed.");
  }

  await entryRef.update({
    technicianComments: comments,
    technicianName: techData.name || "",
    technicianSaqcc: techData.saqcc || "",
    status: "signed",
    signedAt: admin.firestore.FieldValue.serverTimestamp(),
    signedBy: uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    signedIp: getCallerIp(request),
    signedDeviceId: deviceId,
    signedUserAgent: getUserAgent(request),
  });
  return { signed: true };
});

/* ---------- Competent Person monthly check (SANS 10105-1) ----------
   Same fraud-tracking shape as createLogbookEntry/signLogbookEntry: a
   Competent Person's profile must be complete on this device, and the write
   is stamped with the server-observed IP plus the client's device id, not
   just accepted as a plain Firestore write — firestore.rules blocks direct
   client writes to monthlyChecks for this role for exactly that reason. */
exports.saveMonthlyCheck = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const db = admin.firestore();
  const selfSnap = await db.collection("technicians").doc(uid).get();
  if (!selfSnap.exists) {
    throw new HttpsError("not-found", "Profile not found.");
  }
  await requireProfileComplete(selfSnap, "save a monthly check");
  const selfData = selfSnap.data();
  const companyId = selfData.companyId;

  const data = request.data || {};
  const siteId = String(data.siteId || "").trim();
  const month = String(data.month || "").trim();
  const checkedByName = String(data.checkedByName || "").trim();
  const notes = String(data.notes || "").trim();
  const deviceId = String(data.deviceId || "").trim();
  const results = (data.results && typeof data.results === "object") ? data.results : {};
  const faultNotes = (data.faultNotes && typeof data.faultNotes === "object") ? data.faultNotes : {};

  if (!siteId) throw new HttpsError("invalid-argument", "Missing site.");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpsError("invalid-argument", "Pick a month.");
  if (!deviceId) throw new HttpsError("invalid-argument", "Missing device id — reload the app and try again.");

  const siteSnap = await db.collection("sites").doc(siteId).get();
  if (!siteSnap.exists || siteSnap.data().companyId !== companyId) {
    throw new HttpsError("not-found", "Site not found.");
  }
  const site = siteSnap.data();
  const assigned = Array.isArray(site.assignedCompetentPersons) ? site.assignedCompetentPersons : [];
  if (!assigned.includes(uid)) {
    throw new HttpsError("permission-denied", "You are not assigned to this site.");
  }

  const docId = `${siteId}_${month}`;
  await db.collection("monthlyChecks").doc(docId).set({
    siteId, companyId, month, checkedByName,
    checkedBy: uid,
    recordedByName: selfData.name || "",
    results, faultNotes, notes,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    savedIp: getCallerIp(request),
    savedDeviceId: deviceId,
    savedUserAgent: getUserAgent(request),
  }, { merge: true });
  return { saved: true };
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
