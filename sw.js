const CACHE_NAME = "calcut-shell-v2";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
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
// always goes straight to the network untouched.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

/* ---------------- Background push (FCM) ----------------
   The push Worker (worker/push-worker.js) sends data-only pushes:
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
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
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
