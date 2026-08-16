const CACHE_NAME = "paperclip-v2";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and API calls
  if (request.method !== "GET" || url.pathname.startsWith("/api")) {
    return;
  }

  // Network-first for everything — cache is only an offline fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(async () => {
        // caches.match() resolves undefined on a miss (and the promise itself
        // is always truthy, so `||` can never supply a fallback). respondWith
        // must always receive a real Response — resolving undefined breaks
        // the navigation with "Failed to convert value to 'Response'" instead
        // of showing anything.
        if (request.mode === "navigate") {
          return (await caches.match("/")) ?? new Response("Offline", { status: 503 });
        }
        return (await caches.match(request)) ?? Response.error();
      })
  );
});

// --- Web push (backlog I) ---------------------------------------------------
// The server sends { title, body, url }. Show it as a notification; clicking it
// focuses an existing tab (or opens one) and navigates to the same-origin url.

self.addEventListener("push", (event) => {
  const data = { title: "Paperclip", body: "", url: "/" };
  if (event.data) {
    try {
      Object.assign(data, event.data.json());
    } catch {
      data.body = event.data.text();
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { url: typeof data.url === "string" ? data.url : "/" },
      icon: "/android-chrome-192x192.png",
      badge: "/favicon-32x32.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || "/";
  // Only ever navigate to a path on our own origin — never follow an off-origin
  // url that somehow landed in a payload.
  let target = "/";
  try {
    const resolved = new URL(raw, self.location.origin);
    if (resolved.origin === self.location.origin) {
      target = resolved.pathname + resolved.search + resolved.hash;
    }
  } catch {
    target = "/";
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) {
            return client.navigate(target).catch(() => undefined);
          }
          return undefined;
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
