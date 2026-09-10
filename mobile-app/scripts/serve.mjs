/* 树莓派学习小站 · 预览/冒烟服务
 * node scripts/serve.mjs [port]
 * 静态服务 mobile-app/web/，模拟 Capacitor 以本地资源方式加载 App 内容。
 * 仅本地开发/验证用。 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = resolve(HERE, '../web');
const port = Number(process.argv[2] || 8760);

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

server.listen(port, () => {
  console.log('serving web/ at http://127.0.0.1:' + port);
});
