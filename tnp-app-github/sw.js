/* TNP · service worker — cache-first del app shell para instalación/offline básico */
const CACHE = "tnp-v55";
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

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  // No tocar nada de otro origen (imagenes/audio en tnp-assets): que el navegador
  // las pida directo. Antes el SW devolvia index.html cuando algo fallaba y la
  // imagen quedaba rota.
  if (url.origin !== self.location.origin) return;
  // audio y video se piden por rangos (Safari): si el SW responde desde cache
  // con una respuesta completa, el reproductor se queda girando. Mejor no tocarlos.
  if (/\.(mp3|mp4|webm|m4a|wav)$/i.test(url.pathname)) return;
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      if (resp && resp.ok && resp.type === "basic") {
        try { const cp = resp.clone(); caches.open(CACHE).then(c => c.put(req, cp)).catch(() => {}); } catch (_) {}
      }
      return resp;
    }).catch(() => req.mode === "navigate" ? caches.match("/index.html") : Response.error()))
  );
});
