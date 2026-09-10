/* ============================================================
 * 树莓派学习小站 · 内置离线神经网络 TTS 验证
 * 起本地服务加载 web/，在浏览器（等价于 Capacitor WebView）里：
 *   1) OfflineTTS.ensureReady() 真正加载浏览器版 sherpa-onnx WASM + VITS 模型；
 *   2) OfflineTTS.say('hello') 合成出非空音频采样（数值证据），
 *      失败返回 false / 采样数为 0 → 退出码非 0。
 * 用法：node scripts/verify-tts.mjs
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
const port = 8125;
const base = `http://127.0.0.1:${port}`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
  '.zip': 'application/zip', '.txt': 'text/plain', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/') url = '/index.html';
  let body;
  try { body = await readFile(join(WEB, url)); } catch (e) { res.writeHead(404); res.end('nf:' + url); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(url)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(port, r));

const chromiumPath = 'C:/Users/USER/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addInitScript(() => { try { localStorage.setItem('currentUser', 'cet6'); } catch (e) {} });
const page = await context.newPage();
const logs = [];
const nf = [];
page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text()));
page.on('response', (r) => { if (r.status() >= 400) nf.push(r.status() + ' ' + r.url()); });

await page.goto(base + '/modules/vocabulary/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

console.log('ready before:', await page.evaluate(() => window.OfflineTTS ? window.OfflineTTS.ready : 'no-script'));

/* 等模型加载（wasm 13MB + onnx 63MB 本地读取 + espeak zip，给足时间） */
const ok = await page.evaluate(() => window.OfflineTTS.ensureReady()).catch(() => false);
console.log('model ready:', ok);

const res = await page.evaluate(() => {
  const said = window.OfflineTTS.say('Hello. My name is Amy.');
  return { said, lastLen: window.OfflineTTS.lastLen, ready: window.OfflineTTS.ready };
});

console.log('SAY_RESULT :', JSON.stringify(res));
const pass = res && res.said === true && res.lastLen > 0 && res.ready === true;
console.log('TTS-OFFLINE-OK :', pass ? 'YES' : 'NO');
console.log('console-errors:', logs.slice(0, 6).join(' | '));
console.log('non-2xx:', nf.slice(0, 10).join(' | '));

await browser.close();
server.close();
process.exit(pass ? 0 : 1);
