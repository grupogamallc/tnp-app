/* TNP · service worker
   La app (index.html) va primero a la red: asi un despliegue nuevo llega en la
   siguiente carga en vez de quedarse pegado al cache. El cache es el respaldo
   para cuando no hay internet. Lo demas (iconos, imagenes) si va primero al cache. */
const CACHE = "tnp-v62";
const ASSETS = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function guardar(req, resp) {
  if (resp && resp.ok && resp.type === "basic") {
    try { const cp = resp.clone(); caches.open(CACHE).then(c => c.put(req, cp)).catch(() => {}); } catch (_) {}
  }
  return resp;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Nada de otro origen: la base de datos, el CDN y las imagenes de tnp-assets
  // las pide el navegador directo. Si el SW se mete, una peticion puede quedarse
  // colgada para siempre y la app se queda muda sin dar error.
  if (url.origin !== self.location.origin) return;

  // Audio y video se piden por rangos (Safari): si el SW responde completo, el
  // reproductor se queda girando.
  if (/\.(mp3|mp4|webm|m4a|wav)$/i.test(url.pathname)) return;

  const esLaApp = req.mode === "navigate" ||
                  url.pathname === "/" ||
                  url.pathname === "/index.html" ||
                  url.pathname === "/sw.js";

  if (esLaApp) {
    // Primero la red. Si no hay, lo que haya en cache.
    e.respondWith(
      fetch(req).then(resp => guardar(req, resp))
        .catch(() => caches.match(req).then(hit => hit || caches.match("/index.html")))
    );
    return;
  }

  // Lo demas: primero el cache, que es lo que hace que la app abra rapido y offline.
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => guardar(req, resp))
      .catch(() => Response.error()))
  );
});
