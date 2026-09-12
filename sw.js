/* Vigil Fire — service worker.
   © 2026 Sapphorion (sapphorion@gmail.com). All rights reserved.
   This source is proprietary. Unauthorized copying, distribution, or use of
   this file, in whole or in part, is prohibited without express permission.
   Build/provenance stamp: SAPPH-VF-1bcbdcf759acb7e78bbb

   Service worker for Vigil Fire (SANS 1475 fire equipment register).

   Purpose: let a technician open the app on-site with no signal. Firestore's
   own offline persistence caches the *data*, but without this worker the
   browser can't even load index.html to reach that cache.

   Strategy:
   - Precache the app shell (this file's SHELL list) on install.
   - Navigations: network first, fall back to the cached index.html.
   - Other shell assets (same-origin + the pinned Firebase SDK scripts):
     stale-while-revalidate.
   - Everything else — Firestore, Storage, Auth traffic — is left untouched so
     the Firebase SDK talks to its backends directly.

   Bump CACHE (e.g. -v2) whenever index.html or sw.js changes so clients pick
   up the new version. */

const CACHE = 'vigil-fire-v14';

const LOCAL_SHELL = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

const VENDOR = [
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions-compat.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(LOCAL_SHELL);                       // must all succeed
    await Promise.allSettled(VENDOR.map((u) => cache.add(u))); // best effort
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // App navigations: try the network, fall back to the cached shell offline.
  // admin.html (the internal, superadmin-only tool) and privacy.html are
  // excluded on purpose — they live in the same directory but have no
  // offline story of their own, so a failed load there should show the
  // browser's normal offline error, not silently serve the customer-facing
  // app instead.
  if (req.mode === 'navigate') {
    const path = new URL(req.url).pathname;
    if (path.endsWith('/admin.html') || path.endsWith('/privacy.html')) return;
    event.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  const url = new URL(req.url);
  const isShellAsset =
    url.origin === self.location.origin ||
    url.href.startsWith('https://www.gstatic.com/firebasejs/');
  if (!isShellAsset) return; // Firestore / Storage / Auth — go straight to Firebase

  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => cached);
    return cached || network;
  })());
});
