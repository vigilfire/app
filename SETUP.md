# Setup guide — Vigil Fire

One-time setup, roughly 10-15 minutes. You'll need a Google account.

## 1. Create a Firebase project
1. Go to https://console.firebase.google.com
2. Click **Add project**, give it a name (e.g. "Fire Equipment Register")
3. You can disable Google Analytics for this project — not needed
4. Click **Create project**

## 2. Turn on email/password login
1. In the left sidebar: **Build → Authentication**
2. Click **Get started**
3. Click **Email/Password**, toggle it **Enabled**, click **Save**

## 3. Turn on the database
1. Left sidebar: **Build → Firestore Database**
2. Click **Create database**
3. Choose **Start in production mode**
4. Pick a location close to South Africa (e.g. `eur3` / europe-west, or whichever region your console offers that's nearest) — this can't be changed later, but it won't materially affect performance for this app
5. Click **Enable**
6. Once created, click the **Rules** tab, delete the placeholder content, and paste in the contents of `firestore.rules` (included alongside this app). Click **Publish**.

## 4. Turn on photo storage
1. Left sidebar: **Build → Storage**
2. Click **Get started**, accept the defaults, click **Done**
3. Click the **Rules** tab, delete the placeholder content, paste in the contents of `storage.rules`. Click **Publish**.

## 5. Connect the app to your project
1. Click the gear icon (top left, next to "Project Overview") → **Project settings**
2. Scroll to **Your apps**, click the **</>** (Web) icon
3. Give it a nickname (e.g. "Equipment Register Web"), click **Register app** — you don't need Firebase Hosting for this
4. You'll see a code block with a `firebaseConfig` object like:
   ```
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "yourproject.firebaseapp.com",
     projectId: "yourproject",
     ...
   };
   ```
5. Copy that whole object and paste it into `index.html`, replacing the placeholder `firebaseConfig` block near the top of the `<script>` section.

## 6. Create your first administrator account
The app has no public sign-up screen on purpose — only an admin can create logins. So the very first admin account needs to be created manually, once:

1. Firebase Console → **Authentication → Users → Add user**
   Enter your own email and a password. Click **Add user**.
2. Copy the **User UID** shown next to the new user (looks like `aB3xY...`)
3. Firebase Console → **Firestore Database → Data**
4. Click **Start collection**, collection ID: `technicians`
5. For **Document ID**, paste the User UID you copied (don't let it auto-generate one)
6. Add these fields:
   | Field | Type | Value |
   |---|---|---|
   | name | string | Your name |
   | email | string | The email you used above |
   | role | string | `admin` |
7. Click **Save**

## 7. Open the app
Double-click `index.html` to open it in a browser for a quick look, or — recommended — host it (Netlify, GitHub Pages, your own web server all work fine, since it's just static files). Log in with the email and password from step 6.

**Host it if technicians will use it in the field.** Offline support relies on a service worker (`sw.js`), and browsers only run service workers over `https://` (or `http://localhost`) — not from a `file://` double-click. Deploy all the files together (`index.html`, `sw.js`, `manifest.json`, `.nojekyll`, the two icons) to the same folder/URL. Once a technician has opened the hosted app online at least once, it will load and work with no signal on later visits.

### Hosting on GitHub Pages (free)
1. Create a repository and push these files to it (all at the repo root).
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
3. After a minute the app is live at `https://<your-username>.github.io/<repo-name>/`. Tick **Enforce HTTPS**.
4. **Add that address to Firebase** — Console → **Authentication → Settings → Authorized domains → Add domain** → `<your-username>.github.io`. Sign-in fails from any domain not on this list.
5. Free GitHub Pages requires a **public repository**, so the code is visible to anyone. That's fine for the `firebaseConfig` block (it's a client identifier, not a secret — all access is controlled by `firestore.rules` / `storage.rules`), but be aware the whole codebase is public.
6. The included empty `.nojekyll` file stops GitHub trying to process the site as a Jekyll blog — leave it in place.

You're now the administrator. From here, use the **Techs** tab to create technician accounts (name, email, a password you set and share with them, SAQCC number) and the **Sites** tab to add sites and tick which technicians are assigned to each one.

## Notes
- Technician passwords are set by the admin when creating the account — there's currently no "forgot password" or self-service reset flow in the app itself. If a technician forgets theirs, you can reset it manually: Firebase Console → Authentication → Users → find them → the "⋮" menu → Reset password.
- The free Firebase tier (Spark plan) comfortably covers this scale of use — you'd need a genuinely high volume of daily records before hitting any limits.
- Technicians' devices cache data locally, so they can keep working with no signal on-site; anything they add or edit syncs automatically once they're back in range. This needs the app to be hosted (see step 7) and opened online once first.
- Removing a technician **deactivates** them: they can no longer sign in and they're dropped from every site, but their past inspection records are kept as compliance history. You can reactivate them later from the same screen. To also delete the underlying login, do it in Firebase Console → Authentication → Users.
- When you change `index.html` or `sw.js`, bump the `CACHE` name near the top of `sw.js` (e.g. `vigil-fire-v1` → `vigil-fire-v2`) and redeploy, so devices pick up the new version instead of serving the old cached one.
- **After updating `firestore.rules`, you must re-publish it** (Firebase Console → Firestore Database → Rules → paste → Publish). The app now stores each inspection as its own record under `equipment/{id}/inspections/{id}`, and the rules that allow technicians to log inspections live in that file.
- Each piece of equipment keeps a full inspection history. Logging a new inspection never overwrites an older one. Technicians can add inspections for their assigned sites; only an administrator can edit or delete a saved inspection, or delete a piece of equipment. Older records created before this change are migrated automatically the first time someone opens that equipment.
- Sites can be given a category (Survey / Servicing). **Complete this site** does two things at once: it flips a workflow lock that unlocks the certificate, and it stamps a dated sign-off ("Signed off <date> by <name>", shown on the site list). Reopening clears the lock but keeps the last sign-off date as history. Equipment can be added or edited whether the site is complete or not.
- The **Due** tab (bottom bar, everyone) lists equipment across your sites that is overdue or falls due within 30 days — never inspected, service or pressure-test date approaching, or flagged non-compliant / needs attention. Tap an item to jump straight to it.
- On a site with six or more items, the equipment list gains a search box and filter chips (Overdue / Not inspected / Failed).
- **Service run** (button on the site detail) opens the inspection form for every item in turn — save moves you straight to the next one, with Skip and End run always available — so a technician can walk a site without returning to the list between items.
- Admins have a **Company profile** tab (bottom bar): logo upload plus company name, registration no., address, phone and email. These are the letterhead on generated certificates and the printable site register, and they head the CSV export. Stored in the `settings/company` document — the rules file grants admins write access to `settings`. The logo is held inline in that document (resized to 400px wide on upload), so no Storage rules change is needed; keep logos simple so the document stays well under Firestore's 1 MiB limit.
- Once a site is complete, an admin can **Generate certificate** — a printable SANS 1475 service certificate. Set up the Company profile first for the letterhead.
- **Printable register** (button on any site, admin or assigned technician) produces a branded, printable list of every item at the site with its latest inspection — a companion to the certificate that can be left on site.
- **Service type** (site form, admin only): tag a site as *Minor service*, *Annual service* or *Installation only*. It shows as a pill on the site for the technician and prints on the register and certificate. It is a label only — it changes no dates the app calculates, and it stays set until an admin changes it.
- **Site email / contact person / contact phone** (site form): used by the "Email to site" feature below. Contact fields also show to the technician on the site.

## Emailing the register & certificate (optional)

This lets an administrator email a site its **printable register** and/or **service certificate** as PDF attachments, straight from the site screen, with every send recorded in an `emailLog` collection ("Last emailed …" shows on the site). It uses a Cloud Function plus [Resend](https://resend.com) for delivery, so it needs the **Blaze** plan (pay-as-you-go; this usage sits comfortably in the free monthly allowances).

Until this is set up, the **Email to site** button still appears but explains that delivery isn't switched on yet.

### What deploys where

Vigil Fire has **two** deploy targets. Phase A (service type, contact fields, email) touches both:

| You changed… | Goes to… | How |
|---|---|---|
| `index.html`, `sw.js`, `manifest.json`, icons | GitHub Pages (`https://vigilfire.github.io/app/`) | `git commit` + `git push origin main` |
| `functions/` | Firebase Cloud Functions | `firebase deploy --only functions` |
| `firestore.rules` | Firebase Firestore rules | `firebase deploy --only firestore:rules` (or paste in the console) |
| `firebase.json`, `.firebaserc`, `firestore.indexes.json` | nothing runs them directly — they configure the `firebase` CLI | commit them so the CLI works for anyone with the repo |

The service-type label and contact fields (A1) need **only** the static-site push plus re-publishing `firestore.rules`. The rest of this section is for the email feature (A2).

### Step 0 — install the tools (one time, on the machine you deploy from)

You need **Node.js 20+**, **npm** (comes with Node), the **Firebase CLI**, and **Git**. On Windows PowerShell:

```
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Close and re-open PowerShell so the new `PATH` takes effect, then:

```
npm install -g firebase-tools
```

Check everything resolves:

```
node -v          # v20.x or newer
npm -v
git --version
firebase --version
```

### Step 1 — install the function's dependencies

```
cd d:\Sapphorion\sapphorion\app\functions
npm install
cd ..
```

This downloads `firebase-admin`, `firebase-functions`, `puppeteer-core`, `@sparticuz/chromium` and `resend` into `functions/node_modules` (a few hundred MB — Chromium is large). It is git-ignored and never committed; the deploy rebuilds it in the cloud.

### Step 2 — sign in and select the project

```
firebase login          # opens a browser — use the Google account that owns the "vigil-fire" Firebase project
firebase use vigil-fire # .firebaserc already points here, so this just confirms it
```

### Step 3 — create the Resend API key and store it as a secret

1. Sign up at https://resend.com. **API Keys → Create API Key** (a "Sending access" key is enough). Copy the value (starts `re_…`).
2. Store it in Google Secret Manager (never in a file):
   ```
   firebase functions:secrets:set RESEND_API_KEY
   ```
   Paste the key at the hidden prompt. If asked to enable the Secret Manager API or grant access, say yes.

### Step 4 — deploy the function and the rules

```
firebase deploy --only functions,firestore:rules
```

The **first** functions deploy on a project also enables the Cloud Functions, Cloud Build, Artifact Registry and Cloud Run APIs and may ask to set an Artifact Registry cleanup policy — accept the defaults. It takes roughly 3–8 minutes. Success looks like:

```
✔  functions[emailSiteDocuments(us-central1)] Successful create operation.
✔  firestore: released rules firestore.rules to cloud.firestore
```

### Step 5 — turn the feature on and push the app

1. In `index.html`, change `const EMAIL_SENDING_ENABLED = false;` to `true`.
2. `sw.js` is already bumped to `vigil-fire-v2` in this change — that's enough for this push. **On any later change** to `index.html` or `sw.js`, bump it again (`-v3`, `-v4`, …).
3. Commit and push:
   ```
   cd d:\Sapphorion\sapphorion\app
   git add -A
   git commit -m "Phase A: service type, site contacts, email register/certificate"
   git push origin main
   ```
4. GitHub Pages rebuilds in about a minute. On an already-open app the service worker picks up the new version on the next launch, then one more reload; force it now with **Ctrl+Shift+R**.

### Step 6 — test (test mode: your own address only)

Until a domain is verified in Resend, it delivers **only to the email address that owns the Resend account**, and the sender shows as `onboarding@resend.dev`.

1. Sign in as an administrator, open a site, set its **Site email** to your Resend-account address.
2. (Optional, to test the certificate too) mark the site **complete**.
3. **Email to site → tick Printable site register → Send.**
4. Expect the status line to go `Preparing documents…` → `Sending…` → `Sent to …`. Check your inbox and spam. The site now shows "Last emailed …", and there's a document in Firestore → **emailLog**.
5. If it fails, the red status line and `firebase functions:log` show why.

### Step 7 — going live with a real sender (later)

1. Register a domain (e.g. `vigilfire.co.za` — about R75/year; no mailbox needed).
2. Resend → **Domains → Add Domain**, add the SPF/DKIM/DMARC records it shows at your registrar, wait for it to verify.
3. Copy `functions/.env.example` to `functions/.env` and set:
   ```
   EMAIL_FROM="Vigil Fire <certificates@vigilfire.co.za>"
   ```
4. `firebase deploy --only functions`. It can now send to any recipient.

Replies go to the **company email** in your Company profile (set `EMAIL_REPLY_TO` in `functions/.env` to override).

### Troubleshooting

- **`firebase` / `node` "not recognized"** — the shell was open before the install. Close and re-open PowerShell. If still missing, `npm config get prefix` and add that folder to your `PATH`.
- **Deploy says a paid plan is required** — the project must be on **Blaze**. (Vigil Fire already is.)
- **Deploy stalls at "building"** — open Firebase Console → Functions, and Google Cloud Console → Cloud Build, to see the build log.
- **Email fails with "Could not render the … to PDF"** — a `@sparticuz/chromium` / `puppeteer-core` version mismatch. In `functions/`, run `npm install @sparticuz/chromium@latest` and set `puppeteer-core` to the matching major version listed in that package's README, then redeploy.
- **Email fails mentioning testing / your own address** — you're in Resend test mode; send to the Resend account owner's address, or verify a domain (Step 7).
- **Function returns "Only an administrator can email site documents"** — the signed-in user's `technicians/{uid}` document doesn't have `role: "admin"`.
- **Nothing arrives, no error** — check spam; in test mode also confirm the recipient is exactly the Resend account email.

### Notes

- `firebase.json`, `.firebaserc`, `firestore.indexes.json` and `functions/` are harmless to GitHub Pages (it just serves the static files). `functions/node_modules` and `functions/.env` are git-ignored.
- The `emailLog` rules (admin-read; only the function writes) are in `firestore.rules` — **re-publish it** after this change.
- The PDF is rendered server-side with headless Chromium from the same HTML the app prints, so the emailed document matches the on-screen register / certificate.
- The function deploys to **us-central1** and the app's callable client uses the same region by default — leave both as-is even if your Firestore is in Europe.
