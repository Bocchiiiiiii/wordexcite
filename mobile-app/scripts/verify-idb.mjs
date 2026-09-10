/* ============================================================
 * 树莓派学习小站 · 知识缓存 IndexedDB 持久化验证
 * 打包好的 web/ 起本地服务，验证 AI 知识缓存不再写 localStorage，
 * 而是存进 IndexedDB 且能跨页面重载保留。
 * 用法：node scripts/verify-idb.mjs  （stdout 打印结果，非 0 退出=失败）
 * ============================================================ */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = resolve(HERE, '../web');
const port = 8124;
const base = `http://127.0.0.1:${port}`;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const server = createServer(async (req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/') url = '/index.html';
  let body;
  try { body = await readFile(join(WEB, url)); } catch (e) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(url)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(port, r));

const chromiumPath = 'C:/Users/USER/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addInitScript(() => { try { localStorage.setItem('currentUser', 'cet6'); } catch (e) {} });
const page = await context.newPage();

await page.goto(base + '/modules/vocabulary/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

/* 写一条知识缓存 */
await page.evaluate(() => {
  window.Utils.setKnowledge('indexedbtest', {
    en: 'indexedbtest', v: 3,
    meanings: [{ pos: 'n.', zh: '离线知识缓存测试' }],
    generatedAt: new Date().toISOString(),
  });
  return true;
});
await page.waitForTimeout(4000);   // 等异步 flush 落库

/* ---- 诊断 ---- */
const diag = await page.evaluate(async () => {
  const out = {
    hasIndexedDB: !!window.indexedDB,
    hasUtils: typeof window.Utils,
    memoryGet: (() => { try { const k = window.Utils.getKnowledge('indexedbtest'); return k ? 'HIT' : 'null'; } catch (e) { return 'ERR:' + e.message; } })(),
    memKeys: (() => { try { return Object.keys(window.Utils.loadKnowledge()).join(','); } catch (e) { return 'ERR:' + e.message; } })(),
    syncSelfTest: (() => {
      try {
        const before = Object.keys(window.Utils.loadKnowledge()).length;
        window.Utils.setKnowledge('synctest', { v: 3, en: 'synctest' });
        const inMem = window.Utils.getKnowledge('synctest');
        const after = Object.keys(window.Utils.loadKnowledge()).length;
        const afterIdbLen = (() => { try { const l = window.Utils.loadKnowledge(); return Object.keys(l).length; } catch (e) { return -1; } })();
        return JSON.stringify({ before, after, inMem: inMem ? inMem.v : null, afterLen: afterIdbLen });
      } catch (e) { return 'ERR:' + e.message; }
    })(),
  };
  // 原始 IndexedDB 读写自检
  try {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordexcite-db'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const putOk = await new Promise((res) => {
      const t = db.transaction('knowledge', 'readwrite');
      t.objectStore('knowledge').put({ key: 'rawtest', value: { n: 1 } });
      t.oncomplete = () => res(true); t.onerror = () => res(false);
    });
    const rawGet = await new Promise((res) => {
      const g = db.transaction('knowledge', 'readonly').objectStore('knowledge').get('rawtest');
      g.onsuccess = () => res(g.result ? g.result.value : null); g.onerror = () => res(null);
    });
    out.rawPutGet = JSON.stringify({ putOk, rawGet });
  } catch (e) { out.rawPutGet = 'ERR:' + e.message; }
  return out;
});
console.log('DIAG           :', JSON.stringify(diag));

/* 确认它进了 IndexedDB 而非 localStorage */
const idbHit = await page.evaluate(async () => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('wordexcite-db'); r.onsuccess = () => res(r.result); r.onerror = () => res(null);
  });
  if (!db) return null;
  return await new Promise((res) => {
    const g = db.transaction('knowledge', 'readonly').objectStore('knowledge').get('indexedbtest');
    g.onsuccess = () => res(g.result && g.result.value ? g.result.value : null);
    g.onerror = () => res(null);
  });
});
const lsHit = await page.evaluate(() => localStorage.getItem('cet6knowledge.v1'));

/* 重载页面，确认内存缓存跨重载恢复 */
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const afterReload = await page.evaluate(() => {
  const k = window.Utils.getKnowledge('indexedbtest');
  return k ? { v: k.v, zh: k.meanings && k.meanings[0] && k.meanings[0].zh } : null;
});

console.log('IDB_HIT        :', idbHit ? JSON.stringify(idbHit.meanings) : null);
console.log('LOCALSTORAGE   :', lsHit === null ? 'NULL (未写 localStorage)' : 'HIT (仍写 localStorage! )');
console.log('AFTER_RELOAD   :', JSON.stringify(afterReload));
const ok = !!idbHit && lsHit === null && afterReload && afterReload.zh === '离线知识缓存测试';
console.log('IDB-PERSIST-OK :', ok ? 'YES' : 'NO');

await browser.close();
server.close();
process.exit(ok ? 0 : 1);
