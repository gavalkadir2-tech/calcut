const CACHE_NAME = "calcut-shell-v4";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./qrcode.js",
  "./manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Only the static app shell is cached, and only for same-origin GET
// requests — everything else (Firebase Auth/Firestore, any API call)
// always goes straight to the network untouched. Network-first, so a new
// deploy reaches phones on the next open; the cache is only an offline fallback.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    // "no-cache" revalidates with the server instead of trusting the HTTP cache.
    fetch(event.request.url, { cache: "no-cache", credentials: "same-origin" })
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => {
        if (cached) return cached;
        throw new Error("offline");
      }))
  );
});

/* ---------------- Background push (FCM) ----------------
   The push Worker (worker/_worker.js) sends data-only pushes:
   { kind: "message" | "call" | "call-missed", media? }. They arrive here
   even when the app/browser is closed. Text is disguised as an alarm, the
   same way the in-app notification is, and never names the sender. */

const CALL_TAG = "calcut-call";

function alarmTime() {
  return new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    const json = event.data ? event.data.json() : {};
    data = json.data || json;
  } catch (e) {}

  const base = {
    // Alarm-clock icons so the notification looks like a ringing alarm, not the calculator.
    icon: "icons/alarm-192.png",
    badge: "icons/alarm-badge-96.png",
    silent: false,
    data: { url: self.registration.scope },
  };
  let options;
  let title = "Alarm";
  if (data.kind === "call") {
    options = Object.assign(base, {
      body: alarmTime(),
      tag: CALL_TAG,
      renotify: true,          // each re-ring push plays the sound/vibration again
      requireInteraction: true, // stay on screen until tapped or replaced
      vibrate: [800, 400, 800, 400, 800, 400, 800],
    });
  } else if (data.kind === "call-missed") {
    title = "Kaçırılan alarm";
    options = Object.assign(base, {
      body: alarmTime(),
      tag: CALL_TAG,           // replaces the ringing notification
      renotify: false,
    });
  } else {
    options = Object.assign(base, {
      body: alarmTime(),
      tag: "calcut-alarm",     // same tag as the in-app alarm notification, so they merge
      renotify: true,
      vibrate: [300, 150, 300, 150, 300],
    });
  }
  // Always show something: iOS revokes push permission for pushes that display nothing.
  event.waitUntil(self.registration.showNotification(title, options));
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
