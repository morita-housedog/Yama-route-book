// アプリ本体をキャッシュして、圏外でも起動できるようにする
// ファイルを更新したら VERSION の数字を上げてください
const VERSION = "v1";
const CACHE = "yama-route-book-" + VERSION;
const FILES = [
  "./", "./index.html", "./style.css", "./app.js", "./firebase-config.js",
  "./vendor/firebase.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Firebase通信はそのまま
  // まずキャッシュから即表示（電波が弱くても待たない）。裏で最新を取ってきて次回に反映
  e.respondWith(caches.open(CACHE).then(c => c.match(e.request, { ignoreSearch: true }).then(hit => {
    const net = fetch(e.request).then(res => { if (res.ok) c.put(e.request, res.clone()); return res; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(() => c.match("./index.html"));
  })));
});
