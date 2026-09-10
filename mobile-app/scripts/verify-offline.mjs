/* ============================================================
 * 树莓派学习小站 · App 离线词库验证脚本
 * 用打包好的 web/ 起本地静态服务，验证：
 *   1) 仪表盘 + 背单词概览页能正常渲染；
 *   2) 通过 Service Worker 预缓存后断网，重新加载仍能显示词库统计
 *      （即“离线缓存的单词数据”在 App 里可用）。
 * 依赖：仓库根 node_modules 里的 playwright-core 与已安装的 Chromium。
 * 用法：node scripts/verify-offline.mjs
 * 输出截图到 ../verify-out/，并在 stdout 打印在线/离线统计。
 * ============================================================ */
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = resolve(HERE, '../web');
const OUT = resolve(HERE, '../verify-out');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/') url = '/index.html';
  const fp = join(WEB, url);
  let body;
  try { body = await readFile(fp); } catch (e) {
    res.writeHead(404); res.end('not found: ' + url); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
});

const port = 8123;
await new Promise((r) => server.listen(port, r));
const base = `http://127.0.0.1:${port}`;
await mkdir(OUT, { recursive: true });

const chromiumPath = 'C:/Users/USER/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
/* 自动选择词库“CET6”，避免卡在选择用户遮罩 */
await context.addInitScript(() => {
  try { localStorage.setItem('currentUser', 'cet6'); } catch (e) {}
});
const page = await context.newPage();
const consoleLogs = [];
page.on('console', (m) => consoleLogs.push(m.text()));

/* 1) 在线：先加载仪表盘 → 触发 Service Worker 注册并预缓存词库 */
await page.goto(base + '/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);
await page.screenshot({ path: join(OUT, '1-dashboard-online.png') });

/* 2) 在线：背单词概览页，词库应已从本地 words/cet6.json 加载 */
await page.goto(base + '/modules/vocabulary/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
const onlineStats = await page.evaluate(() => ({
  title: (document.getElementById('pageTitle') || {}).textContent,
  mastered: (document.getElementById('statMastered') || {}).textContent,
  newWords: (document.getElementById('statNew') || {}).textContent,
}));
await page.screenshot({ path: join(OUT, '2-vocab-online.png') });

/* 3) 断网：把整页置于 offline 后重载概览页，靠 Service Worker 缓存出词库 */
await context.setOffline(true);
await page.goto(base + '/modules/vocabulary/index.html', { waitUntil: 'load' });
await page.waitForTimeout(3000);
const offlineStats = await page.evaluate(() => ({
  title: (document.getElementById('pageTitle') || {}).textContent,
  mastered: (document.getElementById('statMastered') || {}).textContent,
  newWords: (document.getElementById('statNew') || {}).textContent,
}));
await page.screenshot({ path: join(OUT, '3-vocab-offline.png') });
await context.setOffline(false);

console.log('ONLINE  :', JSON.stringify(onlineStats));
console.log('OFFLINE :', JSON.stringify(offlineStats));
/* “0 / 5407” 之类，总词数 > 0 说明词库离线可用 */
const hadOfflineWordData =
  !!offlineStats.mastered &&
  /\/\s*[1-9][0-9]*/.test(offlineStats.mastered);
console.log('OFFLINE-WORD-DATA-OK :', hadOfflineWordData ? 'YES' : 'NO');
console.log('console-sample:', consoleLogs.slice(0, 6).join(' | '));

await browser.close();
server.close();
process.exit(hadOfflineWordData ? 0 : 1);
