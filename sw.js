/* =========================================================================
 * EcoCal Service Worker：让应用可"添加到主屏幕"并离线可用。
 * 策略：同源静态资源「网络优先 + 缓存兜底」——联网时总是取服务器最新版本，
 *       离线/网络失败时回退缓存，保证离线可用。
 *       跨源请求（汇率接口等）一律放行、不缓存，保证实时性。
 * 为什么不用「缓存优先」：缓存优先会让旧版 app.js / style.css 长期残留，
 *       同一份数据在两台设备上跑不同版本代码，会出现「总市值对不上」等差异。
 * 更新方法：改动本文件中 CACHE_NAME 的版本号（如 v20 → v21）即可清掉旧缓存。
 * ========================================================================= */
'use strict';

const CACHE_NAME = 'ecocal-shell-v21';

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
    try {
      // 网络优先：联网时总是拿最新文件（避免两台设备跑不同版本的旧缓存）
      const response = await fetch(request);
      if (response && response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
        return response;
      }
      // 非 2xx（如 404）：优先用缓存兜底
      const cached = await caches.match(request, { ignoreSearch: true });
      return cached || response;
    } catch (e) {
      // 离线或网络失败：回退缓存（无缓存时抛出，由浏览器按网络错误处理）
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      throw e;
    }
  })());
});
