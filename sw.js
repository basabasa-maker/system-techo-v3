// sw.js - Service Worker
// 戦略:
// - HTML: Network First
// - CSS/JS/静的アセット: Network First（毎回更新を確認。オフライン時のみ保存分を使う）
// - キャッシュ名はビルド時刻バージョンを含め、デプロイ時に自動更新する

const BUILD_VERSION = "20261106-000107";
const CACHE_NAME = `system-techo-v3-${BUILD_VERSION}`;

const PRECACHE_URLS = [
  "/system-techo-v3/",
  "/system-techo-v3/index.html",
  "/system-techo-v3/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("system-techo-v3-") && k !== CACHE_NAME)
            .map((k) => caches.delete(k)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  // 同一オリジン以外（GAS等）はキャッシュしない
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isHTML =
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");

  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((r) => r || caches.match("/system-techo-v3/")),
        ),
    );
    return;
  }

  // JS/CSS/画像: ネットワーク優先。毎回サーバーに「更新があるか」を確かめ、
  // 新しければ新しいものを使う（部品ごとの版ずれで画面が止まるのを防ぐ）。
  // 電波がないときだけ、手元に保存した分を使う
  event.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
