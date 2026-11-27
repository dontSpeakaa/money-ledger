/* 纯手机模式：静态资源离线可用，全部数据在 IndexedDB 里 */
const CACHE = 'money-local-v4';
const SHELL = [
  './',
  'index.html',
  'styles.css?v=7',
  'app.js?v=7',
  'ai-tools.js?v=7',
  'local-api.js?v=7',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // 逐个缓存：任何一个 404 都不该让整次安装失败。
      Promise.all(SHELL.map((u) => cache.add(u).catch(() => {}))),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // 页面导航网络优先：保证拿到的 HTML 和它引用的 ?v= 资源是同一版本。
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(request);
          if (res && res.ok) cache.put('index.html', res.clone());
          return res;
        } catch {
          const cached = (await cache.match('index.html')) || (await cache.match('./'));
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);

      // 后台更新，不阻塞本次响应。
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) return cached;

      const res = await network;
      return res || Response.error();
    }),
  );
});
