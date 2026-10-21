/*
 * 生成纯手机版（无服务器）的静态站点到 docs/，用于 GitHub Pages。
 *
 * 与 server/ 版的区别：
 *   - 注入 window.MONEY_MODE = 'local'，前端改走 IndexedDB
 *   - 资源路径改成相对路径，这样放在 /<仓库名>/ 子路径下也能工作
 *   - manifest 的 start_url / scope 改成相对，图标路径同理
 *   - 去掉 service worker 里对 /api 的判断（本地模式不发请求）
 *
 * 用法：npm run build:static
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'public');
const OUT = join(ROOT, 'docs');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(SRC, OUT, { recursive: true });

// --- index.html：注入模式标记，路径改相对 ---
let html = readFileSync(join(OUT, 'index.html'), 'utf8');
html = html.replace(
  '<script src="/app.js?v=3" type="module"></script>',
  `<script>window.MONEY_MODE = 'local';</script>
  <script src="app.js" type="module"></script>`,
);
html = html
  .replace(/href="\/manifest\.webmanifest"/, 'href="manifest.webmanifest"')
  .replace(/href="\/icons\//g, 'href="icons/')
  .replace(/href="\/styles\.css\?v=3"/, 'href="styles.css"');
writeFileSync(join(OUT, 'index.html'), html);

// --- manifest：子路径下要用相对地址 ---
const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.webmanifest'), 'utf8'));
manifest.description = '个人资产与消费记录，数据只保存在这台手机上';
manifest.start_url = './';
manifest.scope = './';
manifest.icons = manifest.icons.map((i) => ({ ...i, src: i.src.replace(/^\//, '') }));
writeFileSync(join(OUT, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);

// --- app.js：Service Worker 注册路径改相对，才能在 /<仓库名>/ 下工作 ---
let app = readFileSync(join(OUT, 'app.js'), 'utf8');
app = app.replace("register('/sw.js'", "register('sw.js'");
writeFileSync(join(OUT, 'app.js'), app);

// --- service worker：本地模式不发任何请求，直接用一份相对路径的版本 ---
// 策略与服务端版一致：缓存优先 + 后台更新，避免每次启动都等网络。
const sw = `/* 纯手机模式：静态资源离线可用，全部数据在 IndexedDB 里 */
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
`;
writeFileSync(join(OUT, 'sw.js'), sw);

// --- 生成一个 .nojekyll，避免 GitHub Pages 忽略下划线开头的文件 ---
writeFileSync(join(OUT, '.nojekyll'), '');

console.log('已生成纯手机版静态站点：docs/');
console.log('  上传到 GitHub 仓库后，在 Settings → Pages 里把 Source 设为');
console.log('  「Deploy from a branch」，分支选 main、目录选 /docs 即可。');
