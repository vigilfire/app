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
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

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

    let company = {};
    try {
      const c = await db.collection("settings").doc("company").get();
      if (c.exists) company = c.data();
    } catch (e) {
      logger.warn("Could not read settings/company for the sender name", e);
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
