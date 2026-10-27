/* Service worker: receives push notifications while the app/browser is closed
   and keeps a small offline copy of the app shell. */

const CACHE = "calcut-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "firebase-config.js", "manifest.json", "icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Network-first for same-origin GETs so updates show up immediately; cache is only an offline fallback.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (e) {
      const cached = await caches.match(req);
      if (cached) return cached;
      throw e;
    }
  })());
});

// FCM delivers {data: {...}} as the push payload (we send data-only messages from the Cloud Function).
self.addEventListener("push", (event) => {
  let data = {};
  try {
    const json = event.data ? event.data.json() : {};
    data = json.data || json;
  } catch (e) {}

  const title = data.title || "Hesap Makinesi";
  const body = data.body || "Yeni bir bildirimin var";

  event.waitUntil((async () => {
    // If the app is open in the foreground, let the page play its in-app sound too.
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    windows.forEach(w => w.postMessage({ type: "push-received" }));

    // Always show a system notification: iOS revokes push permission for pushes that show nothing.
    await self.registration.showNotification(title, {
      body,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      tag: data.tag || "calcut-message",
      renotify: true,          // play sound/vibrate again even if a notification with the same tag is visible
      silent: false,
      vibrate: [300, 150, 300, 150, 300],
      requireInteraction: false,
      data: { url: self.registration.scope },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of windows) {
      if (w.url.startsWith(self.registration.scope) && "focus" in w) return w.focus();
    }
    return self.clients.openWindow(url);
  })());
});
