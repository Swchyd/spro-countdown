var CACHE = "stagetimer-v5";
var ASSETS = ["./", "index.html", "manifest.json", "icon-180.png", "peerjs.min.js"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Endpoints of the local stage server. /events is an endless SSE stream — put
// it through the caching path below and the clone never settles.
var LIVE = ["/events", "/time", "/info", "/state"];

// The app itself, as opposed to the things it loads. This is the file that has
// to be current the moment someone reloads after an update.
function isDocument(request, url) {
  return request.mode === "navigate" || /(^|\/)(index\.html)?$/.test(url.pathname);
}

// Network first (always fresh when online), cache fallback (works offline)
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;
  if (LIVE.indexOf(u.pathname) !== -1) return;

  // "Network first" was only ever half true. GitHub Pages serves this app with
  // Cache-Control: max-age=600, and a plain fetch() in here is answered by the
  // browser's own HTTP cache — so the network the worker went to was often the
  // cache it was trying to get past, and a reload could not shake it loose for
  // ten minutes. Refreshing harder does not help, because the request never
  // leaves the machine to begin with.
  //
  // cache: "reload" forces the trip and refreshes the HTTP cache on the way
  // back. Only the document is worth that: the rest are content-addressed or
  // rarely change, and making every image skip the cache would cost the stage
  // real time on a bad connection.
  var req = isDocument(e.request, u)
    ? new Request(u.href, { cache: "reload", credentials: "same-origin" })
    : e.request;

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true });
    })
  );
});
