/* ============================================================
 * 树莓派学习小站 · Service Worker（PWA 离线 + 安装支撑）
 * 缓存策略：
 *   - 导航（HTML 文档）     网络优先，失败回退缓存
 *   - 静态资产（CSS/JS/词库/图标/manifest） stale-while-revalidate
 *   - /api/*（动态数据）    绝不缓存，直通网络（服务器为权威）
 * 发版纪律：改版本必须先升本行 CACHE 名（旧缓存 activate 时删除）。
 * ============================================================ */
'use strict';

var CACHE = 'wxs-v1.26.0';

/* 预缓存清单：全部根绝对路径，与各 HTML 中 ?v= 引用保持一致（v1.18.0）。 */
var PRECACHE = [
  '/',
  '/index.html',
  '/modules/vocabulary/index.html',
  '/shared/global.css?v=1.26.0',
  '/shared/arknights.css?v=1.26.0',
  '/shared/vendor/ts-fsrs-5.4.1.js',
  '/shared/fsrs-adapter.js?v=1.26.0',
  '/shared/utils.js?v=1.26.0',
  '/modules/vocabulary/style.css?v=1.26.0',
  '/modules/vocabulary/arknights.css?v=1.26.0',
  '/modules/vocabulary/script.js?v=1.26.0',
  '/words/cet6.json',
  '/words/ielts.json',
  '/words/knowledge-cet6.json',
  '/manifest.webmanifest',
  '/icons/icon-192.png?v=1.26.0',
  '/icons/icon-512.png?v=1.26.0',
  '/icons/icon-512-maskable.png?v=1.26.0',
  '/icons/favicon.ico?v=1.26.0'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      /* 逐条预缓存；单条失败不阻断整个安装（缺一个不影响其余离线可用） */
      return Promise.all(
        PRECACHE.map(function (url) {
          return cache.add(url).catch(function () {
            /* 忽略单个资源的失败 */
          });
        })
      );
    }).then(function () {
      self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE; })
            .map(function (key) { return caches.delete(key); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;

  /* 1. 只处理 GET（/api/tts 的 POST、/api/state 的 PUT/DELETE 直通） */
  if (request.method !== 'GET') return;

  var url;
  try { url = new URL(request.url); } catch (e) { return; }

  /* 2. 跨域请求（外部 OpenAI 兼容 AI 接口）直通 */
  if (url.origin !== self.location.origin) return;

  /* 3. /api/* 动态数据绝对不缓存（服务器为权威源） */
  if (url.pathname.indexOf('/api/') === 0) return;

  /* 4. HTML 导航：网络优先，失败回退缓存 */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
          return res;
        })
        .catch(function () {
          return caches.match(request).then(function (hit) {
            return hit || caches.match('/index.html');
          });
        })
    );
    return;
  }

  /* 5. 静态资产（CSS/JS/词库/图标/manifest）：stale-while-revalidate */
  event.respondWith(
    caches.match(request).then(function (cached) {
      /* 后台刷新（把最新版本写回缓存），失败静默 */
      var refresh = fetch(request)
        .then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
          }
          return res;
        })
        .catch(function () { return null; });

      /* 命中缓存：立即返回（离线也秒开）；未命中：等刷新结果 */
      if (cached) {
        event.waitUntil(refresh);
        return cached;
      }
      return refresh.then(function (res) { return res || cached; });
    })
  );
});