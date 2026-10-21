/*
 * 离线与启动加速。
 *
 * 策略：静态资源「先给缓存，后台悄悄更新」（stale-while-revalidate）。
 * 之前是「先走网络，失败才用缓存」，等于每次打开都要等一轮网络往返，
 * 手机上感知就是慢。现在首屏直接用本地缓存渲染，新版本在后台下载，
 * 下次打开生效。
 *
 * 接口请求（/api/）一律走网络，不缓存，避免看到过期账目。
 */
const CACHE = 'money-shell-v4';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/local-api.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // 逐个缓存：任何一个 404 都不该让整次安装失败，否则离线能力静默失效。
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
  if (url.pathname.startsWith('/api/')) return;

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
        const shell = await cache.match('/index.html', { ignoreSearch: true });
        if (shell) return shell;
      }
      return Response.error();
    }),
  );
});
