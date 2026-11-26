// 楽譜スクロール：オフライン用サービスワーカー
// アプリを更新したら VERSION の数字を変えると、iPad側も新しい版に入れ替わります。
const VERSION = 'v4';
const CACHE = 'score-scroll-' + VERSION;
const APP_FILES = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const LIB_FILES = [
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js'
];
const CDN = 'https://cdn.jsdelivr.net';

self.addEventListener('install', (e) => {
  // 端末に残っている古いファイルを使わず、必ずサーバーから取り直して保存する
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(APP_FILES.map((u) => new Request(u, { cache: 'reload' }))).then(() => c.addAll(LIB_FILES)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('score-scroll-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fromNetwork(req) {
  // 端末に残った古いファイルではなく、サーバーに最新かどうか確認して取り直す
  const fresh = new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' });
  return fetch(fresh).then((res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === CDN) {
    // PDFの部品は変わらないので、保存したものを優先
    e.respondWith(caches.match(req).then((hit) => hit || fromNetwork(req)));
    return;
  }
  if (url.origin !== location.origin) return;
  // アプリ本体は「ネットがあれば最新、なければ保存したもの」
  e.respondWith(
    fromNetwork(req).then((res) => {
      if (res && res.ok) return res;
      return caches.match(req, { ignoreSearch: true }).then((hit) => hit || res);
    }).catch(() =>
      caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
    )
  );
});
