/* 纯手机模式：静态资源离线可用，全部数据在 IndexedDB 里 */
const CACHE = 'money-local-v2';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'local-api.js',
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

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });

      // 后台更新，不阻塞本次响应。
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) return cached;

      const res = await network;
      if (res) return res;
      if (request.mode === 'navigate') {
        const shell = await cache.match('index.html', { ignoreSearch: true });
        if (shell) return shell;
      }
      return Response.error();
    }),
  );
});
