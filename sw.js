// アプリ本体をキャッシュして、圏外でも起動できるようにする
// ファイルを更新したら VERSION の数字を上げてください
const VERSION = "v8";
const CACHE = "yama-route-book-" + VERSION;
const TILE_CACHE = "yama-tiles"; // 保存した地図（バージョンを上げても消さない）
const TILE_HOST = "cyberjapandata.gsi.go.jp";
const FILES = [
  "./", "./index.html", "./style.css", "./app.js", "./firebase-config.js",
  "./vendor/firebase.js", "./vendor/leaflet/leaflet.js", "./vendor/leaflet/leaflet.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"
];
self.addEventListener("install", e => {
  // ブラウザのHTTPキャッシュを通さず、必ずサーバーから最新を取得する
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(FILES.map(f => fetch(new Request(f, { cache: "reload" })).then(res => { if (res.ok) return c.put(f, res); }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== TILE_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // 地図タイル：保存済みならそれを使う（圏外でも表示できる）
  if (url.hostname === TILE_HOST) {
    e.respondWith(caches.open(TILE_CACHE).then(c => c.match(url.href).then(hit => hit || fetch(e.request))));
    return;
  }
  if (url.origin !== location.origin) return; // Firebase通信はそのまま
  // まずキャッシュから即表示（電波が弱くても待たない）。裏で最新を取ってきて次回に反映
  e.respondWith(caches.open(CACHE).then(c => c.match(e.request, { ignoreSearch: true }).then(hit => {
    const net = fetch(e.request, { cache: "no-cache" }).then(res => { if (res.ok) c.put(e.request, res.clone()); return res; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(() => c.match("./index.html"));
  })));
});
