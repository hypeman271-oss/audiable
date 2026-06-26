// Narrative service worker — caches the app shell so the UI loads instantly
// and works offline. API calls always go to the network (the TTS backend
// can't run on the client).

const CACHE = "narrative-shell-v225v4.203";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/sentence-ids.js",
  "/tutorials.js",
  "/overlay-tour.js",
  "/manual.html",
  "/whats-new.html",
  "/landing.html",
  "/admin-troubleshooting.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-180.png",
  "/icons/favicon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // addAll fails atomically; use individual adds so one missing asset
      // doesn't bring down the whole install.
      Promise.all(
        SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn("sw: skip", url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never cache API responses — TTS output is large and dynamic.
  if (url.pathname.startsWith("/api/")) return;

  // Cache-first for the app shell; fall back to network, then update cache.
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
