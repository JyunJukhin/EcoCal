/* =========================================================================
 * EcoCal Service Worker：让应用可"添加到主屏幕"并离线可用。
 * 策略：App Shell（页面骨架）缓存优先；同源静态资源网络更新并回写缓存；
 *       跨源请求（汇率接口等）一律放行、不缓存，保证实时性。
 * 更新方法：改动本文件中 CACHE_NAME 的版本号（如 v1 → v2）即可让浏览器
 *       在下次访问时整体替换缓存。
 * ========================================================================= */
'use strict';

const CACHE_NAME = 'ecocal-shell-v11';

/* App Shell：首次安装时预缓存的应用骨架（新增页面依赖文件时需同步追加） */
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/* 安装：预缓存骨架，并立即接管（skipWaiting） */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

/* 激活：清理旧版本缓存，并立即 claim 控制所有已开页面 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/* 拦截请求 */
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 非 GET（如导入文件读取 POST 不适用，这里主要放行）与跨源请求不做拦截
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) {
      // 命中缓存：先返回缓存（秒开），同时在后台尝试网络更新并写回缓存
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached;
    }
    // 未命中：走网络，成功后写回缓存（供以后离线使用）
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
      }
      return response;
    } catch (e) {
      return cached; // 离线且无缓存时返回 undefined → 浏览器按网络错误处理
    }
  })());
});
