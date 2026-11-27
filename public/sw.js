/*
 * 离线与启动加速。
 *
 * 策略：
 *   - 页面导航走网络优先。HTML 里引用的 JS/CSS 带 ?v= 版本号，只有导航拿到的
 *     是最新 HTML，才会去请求最新版本的资源。之前导航也走缓存，会出现「旧 HTML
 *     配新 app.js」这种错配，页面直接崩在启动页上。
 *   - 静态资源缓存优先（带版本号，所以缓存命中就是同一版本），后台再更新。
 *   - 接口请求（/api/）一律走网络，不缓存，避免看到过期账目。
 */
const CACHE = 'money-shell-v6';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css?v=6',
  '/app.js?v=6',
  '/ai-tools.js?v=6',
  '/local-api.js?v=6',
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

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(request);
          if (res && res.ok) cache.put('/index.html', res.clone());
          return res;
        } catch {
          const cached = (await cache.match('/index.html')) || (await cache.match('/'));
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
