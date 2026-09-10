/* verify-aimodels.mjs — 无头浏览器验证 v1.22.0「获取模型列表」功能
 * 用法：node scripts/verify-aimodels.mjs   （仓库根目录执行）
 * 自建静态服务器 + 假 /models 接口（不联网、不连任何外部服务）
 * 验证项：
 *  1. 首页设置：填 URL/Key → 点「获取模型列表」→ 列表渲染、数量与排序正确
 *  2. 点条目 → 填入输入框 + 立即写入 localStorage(aiModel)，高亮当前项
 *  3. 手输模型名仍可用（输入框可编辑）
 *  4. 错误分支：Key 无效(401) / Base URL 指错返回非 JSON → 可读提示、列表收起
 *  5. 模块页设置：同款按钮/列表同样工作
 *  6. 无未捕获脚本错误
 * 产物：/tmp/shot-ai-home.png、/tmp/shot-ai-module.png
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(process.cwd());
const PORT = 8765;          // 静态站（App 本体）
const API_PORT = 8766;      // 假 AI 接口：必须跨域，才是真实场景（外部服务商）
const BASE = 'http://127.0.0.1:' + PORT;
const API = 'http://127.0.0.1:' + API_PORT;
const TEST_KEY = 'test-key';
const MODELS = ['GLM-4-Flash', 'deepseek-chat', 'Qwen/Qwen2.5-7B-Instruct'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
}

let lastAuth = null;
let preflights = 0;

/* ---- 假的跨域 OpenAI 兼容接口（带 CORS 预检，模拟真实服务商） ---- */
function serveApi(req, res) {
  const url = new URL(req.url, API);
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '0'
  };
  if (req.method === 'OPTIONS') {
    preflights += 1;
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (url.pathname === '/v1/models') {
    lastAuth = req.headers['authorization'] || null;
    if (lastAuth !== 'Bearer ' + TEST_KEY) {
      res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }));
    return;
  }
  if (url.pathname === '/v3/models') {   /* 200 个模型：验证列表滚动容器真的生效 */
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: Array.from({ length: 200 }, (_, i) => ({ id: 'model-' + String(i).padStart(3, '0') }))
    }));
    return;
  }
  if (url.pathname === '/v2/models') {   /* 返回非 JSON，验证提示文案 */
    res.writeHead(200, { ...cors, 'Content-Type': 'text/html' });
    res.end('<html>not json</html>');
    return;
  }
  res.writeHead(404, cors);
  res.end('404');
}

function serve(req, res) {
  const url = new URL(req.url, BASE);
  /* ---- 静态文件 ---- */
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, rel.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function main() {
  const server = http.createServer(serve);
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const apiServer = http.createServer(serveApi);
  await new Promise((r) => apiServer.listen(API_PORT, '127.0.0.1', r));

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 414, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.addInitScript(() => localStorage.setItem('currentUser', 'cet6'));
  const dropThemeModal = () => page.evaluate(() => {
    const m = document.querySelector('.modal-backdrop[aria-label="选择主题"]');
    if (m) m.remove();
  });

  /* ================= 首页 ================= */
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await dropThemeModal();
  await page.click('#openSettings');
  await page.waitForSelector('#dashFetchModels', { state: 'visible' });

  record('首页设置存在「获取模型列表」按钮', await page.locator('#dashFetchModels').isVisible());

  await page.fill('#dashAiUrl', API + '/v1');
  await page.fill('#dashApiKey', TEST_KEY);
  await page.click('#dashFetchModels');
  await page.waitForSelector('#dashAiModelList .ai-model-item', { timeout: 8000 });
  const items = await page.locator('#dashAiModelList .ai-model-item').allTextContents();
  const wantSorted = [...MODELS].sort((a, b) => a.localeCompare(b));
  record('首页：模型列表渲染 3 项且按名排序',
    items.length === 3 && items.join('|') === wantSorted.join('|'),
    JSON.stringify(items));
  record('首页：请求带 Authorization: Bearer <key>', lastAuth === 'Bearer ' + TEST_KEY, String(lastAuth));

  await page.click('#dashAiModelList .ai-model-item:nth-child(2)');
  await page.waitForTimeout(200);
  const picked = await page.inputValue('#dashAiModel');
  const stored = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('cet6study.v1') || '{}');
    return d.aiModel || '';
  });
  record('首页：点条目 → 填入输入框并保存', picked === items[1] && stored === items[1],
    'input=' + picked + ' stored=' + stored);
  const activeCount = await page.locator('#dashAiModelList .ai-model-item.active').count();
  record('首页：选中项高亮唯一', activeCount === 1, 'active=' + activeCount);

  await page.fill('#dashAiModel', 'my-own-model');
  record('首页：模型名仍可手输', (await page.inputValue('#dashAiModel')) === 'my-own-model');

  await page.screenshot({ path: '/tmp/shot-ai-home.png' });

  /* ---- 版式体检（模型列表不是「能跑就行」：触摸目标、滚动容器、不遮挡底部按钮） ---- */
  const layout = await page.evaluate(() => {
    const list = document.getElementById('dashAiModelList');
    const btn = document.getElementById('dashFetchModels');
    const item = list.querySelector('.ai-model-item');
    const modal = document.querySelector('#settingsModal .modal-card');
    const actions = document.querySelector('#settingsModal .modal-actions');
    const cs = getComputedStyle(list);
    const bs = getComputedStyle(btn);
    const ir = item.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const ar = actions.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    return {
      btnText: btn.textContent.trim(),
      btnWidth: Math.round(br.width),
      btnMinHeight: bs.minHeight,
      itemHeight: Math.round(ir.height),
      overflowY: cs.overflowY,
      maxHeight: cs.maxHeight,
      scrollable: list.scrollHeight > list.clientHeight + 1,
      listWidth: Math.round(lr.width),
      cardWidth: Math.round(modal.getBoundingClientRect().width),
      listBottom: Math.round(lr.bottom),
      actionsTop: Math.round(ar.top)
    };
  });
  record('版式：按钮文案正确、条目高度≥40px（触摸友好）',
    layout.btnText === '获取模型列表' && layout.itemHeight >= 40,
    'btn=' + layout.btnText + ' itemH=' + layout.itemHeight);
  record('版式：列表是可滚动容器且受 max-height 约束',
    layout.overflowY === 'auto' && layout.maxHeight === '168px',
    'overflowY=' + layout.overflowY + ' maxH=' + layout.maxHeight + ' scrollable=' + layout.scrollable);
  record('版式：列表宽度贴合卡片、不遮挡「保存/关闭」按钮',
    layout.listWidth > 100 && layout.listWidth <= layout.cardWidth && layout.listBottom <= layout.actionsTop,
    JSON.stringify(layout));

  /* 长列表（真实服务商常有几百个模型）：必须被 max-height 截住并可滚动 */
  await page.fill('#dashAiUrl', API + '/v3');
  await page.fill('#dashApiKey', TEST_KEY);
  await page.click('#dashFetchModels');
  await page.waitForFunction(() => document.querySelectorAll('#dashAiModelList .ai-model-item').length === 200, null, { timeout: 8000 });
  const longList = await page.evaluate(() => {
    const list = document.getElementById('dashAiModelList');
    const r = list.getBoundingClientRect();
    const actions = document.querySelector('#settingsModal .modal-actions').getBoundingClientRect();
    return {
      count: list.children.length,
      height: Math.round(r.height),
      scrollHeight: list.scrollHeight,
      scrollable: list.scrollHeight > list.clientHeight + 1,
      bottom: Math.round(r.bottom),
      actionsTop: Math.round(actions.top)
    };
  });
  record('长列表：200 项被 max-height 截住（可滚动、不撑爆弹窗、不压住按钮）',
    longList.count === 200 && longList.height <= 170 && longList.scrollable &&
    longList.bottom <= longList.actionsTop,
    JSON.stringify(longList));

  /* ---- 像素级复核（无视觉模型可用时的替代：直接读截图像素，看「真的画出来了」没有） ----
   * 回到「3 项 + 选中其中一项」的状态，再用 canvas 解码截图 → 逐行统计墨色像素；
   * 数出文字行带（区别于整行宽的分隔线）、检查选中行左边缘的蓝色描边、以及文字/底色对比。 */
  await page.fill('#dashAiUrl', API + '/v1');
  await page.click('#dashFetchModels');
  await page.waitForFunction(() => document.querySelectorAll('#dashAiModelList .ai-model-item').length === 3, null, { timeout: 8000 });
  await page.click('#dashAiModelList .ai-model-item:nth-child(3)');
  await page.waitForTimeout(200);
  const listBox = await page.locator('#dashAiModelList').boundingBox();
  const listPng = (await page.screenshot({ clip: listBox })).toString('base64');
  const px = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const g = cv.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    const at = (x, y) => {
      const i = (y * cv.width + x) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    };
    const rows = [];
    for (let y = 0; y < cv.height; y++) {
      let ink = 0, sum = 0, blueEdge = 0;
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4;
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        sum += lum;
        if (lum < 150) ink++;
        if (x < 3 && d[i + 2] - d[i] > 30) blueEdge++;   // 左边缘蓝调（选中描边）
      }
      rows.push({ ink, avg: +(sum / cv.width).toFixed(1), blue: blueEdge > 0 ? 1 : 0 });
    }
    const rh = Math.round(cv.height / 3);
    const probeAt = [];
    for (let i = 0; i < 3; i++) {
      const y = i * rh + Math.round(rh / 2);
      probeAt.push({
        row: i,
        left0: at(0, y), left1: at(1, y), left5: at(5, y),
        right: at(cv.width - 6, y)
      });
    }
    return { w: cv.width, h: cv.height, rows, probeAt };
  }, listPng);
  console.log('DIAG darkRows=' + JSON.stringify(px.rows.map((r, y) => (r.avg < 120 ? [y, r.avg] : null)).filter(Boolean)) +
    '\nDIAG probe=' + JSON.stringify(px.probeAt) +
    '\nDIAG activeInput=' + (await page.inputValue('#dashAiModel')));

  /* 连续有墨的行聚成带；整行宽且很薄的判定为「分隔线」，其余为「文字带」 */
  const bands = [];
  let cur = null;
  px.rows.forEach((r, y) => {
    if (r.ink >= 2) { if (!cur) { cur = { top: y, bottom: y, ink: 0, maxInk: 0 }; bands.push(cur); } cur.bottom = y; cur.ink += r.ink; cur.maxInk = Math.max(cur.maxInk, r.ink); }
    else cur = null;
  });
  const isRule = (b) => b.maxInk > px.w * 0.8 && (b.bottom - b.top) <= 3;
  const textBands = bands.filter((b) => !isRule(b));
  const ruleBands = bands.filter(isRule);
  record('像素复核：3 个模型名真的被绘制（3 条文字带 + 3 条整行分隔线）',
    textBands.length === 3 && ruleBands.length >= 2,
    'text=' + textBands.length + ' rules=' + ruleBands.length +
    ' textSpans=' + JSON.stringify(textBands.map((b) => [b.top, b.bottom])));
  const rowH = Math.round(listBox.height / 3);
  const activeRow = 2;   // 我们点了第 3 条
  const bluePerRow = [0, 1, 2].map((i) => {
    let blue = 0, ink = 0;
    for (let y = i * rowH + 4; y < (i + 1) * rowH - 4; y++) { blue += px.rows[y].blue; ink += px.rows[y].ink; }
    return { row: i, blue, ink };
  });
  /* 实际皮肤是 arknights：选中行是「信号黄底」，不是 global.css 里的蓝色左边框 */
  const isWhite = (c) => c[0] > 215 && c[1] > 215 && c[2] > 215;
  const isAmber = (c) => c[0] > 190 && c[1] > 130 && c[2] < 160 && (c[0] - c[2]) > 60;
  const blank = px.probeAt.map((p) => p.right);
  record('像素复核：选中行底色为信号黄、其余为白（高亮真的上色了）',
    isAmber(blank[activeRow]) && isWhite(blank[0]) && isWhite(blank[1]) &&
    bluePerRow[0].blue === 0 && bluePerRow[1].blue === 0,
    'blank=' + JSON.stringify(blank) + ' blue=' + JSON.stringify(bluePerRow.map((r) => r.blue)));
  record('像素复核：选中行文字更粗（墨色像素明显更多）+ 对比充分',
    bluePerRow[activeRow].ink > bluePerRow[0].ink * 1.2 &&
    px.rows.some((r) => r.avg < 150) && px.rows.filter((r) => r.avg > 200).length > px.h * 0.3,
    'ink=' + JSON.stringify(bluePerRow.map((r) => r.ink)) + ' minRowAvg=' + Math.min(...px.rows.map((r) => r.avg)));

  /* 错误分支 1：Key 无效（先清掉上一条 toast、把 URL 指回校验鉴权的端点） */
  await page.evaluate(() => { const t = document.querySelector('.toast'); if (t) t.remove(); });
  await page.fill('#dashAiUrl', API + '/v1');
  await page.fill('#dashAiModel', items[0]);
  await page.fill('#dashApiKey', 'wrong-key');
  await page.click('#dashFetchModels');
  await page.waitForTimeout(800);
  const toast401 = await page.locator('.toast').textContent().catch(() => '');
  const listHidden401 = await page.locator('#dashAiModelList.hidden').count();
  record('首页：Key 无效提示「API Key 无效或无权限（401）」且列表收起',
    /API Key 无效或无权限（401）/.test(toast401 || '') && listHidden401 === 1,
    'toast=' + (toast401 || '').trim());

  /* 错误分支 2：Base URL 指错（返回非 JSON） */
  await page.evaluate(() => { const t = document.querySelector('.toast'); if (t) t.remove(); });
  await page.fill('#dashAiUrl', API + '/v2');
  await page.fill('#dashApiKey', TEST_KEY);
  await page.click('#dashFetchModels');
  await page.waitForTimeout(800);
  const toastBad = await page.locator('.toast').textContent().catch(() => '');
  record('首页：非 JSON 返回提示 Base URL 可疑',
    /Base URL/.test(toastBad || '') && !/404/.test(toastBad || ''), 'toast=' + (toastBad || '').trim());

  /* 错误分支 3：Base URL 为空 */
  await page.evaluate(() => { const t = document.querySelector('.toast'); if (t) t.remove(); });
  await page.fill('#dashAiUrl', '');
  await page.click('#dashFetchModels');
  await page.waitForTimeout(300);
  const toastEmpty = await page.locator('.toast').textContent().catch(() => '');
  record('首页：未填 URL 时提示先填 Base URL', /Base URL/.test(toastEmpty || ''),
    'toast=' + (toastEmpty || '').trim());

  /* ================= 模块页 ================= */
  const mp = await browser.newPage({ viewport: { width: 414, height: 900 } });
  mp.on('pageerror', (e) => errors.push('pageerror(module): ' + e.message));
  mp.on('console', (m) => { if (m.type() === 'error') errors.push('console(module): ' + m.text()); });
  await mp.addInitScript(() => localStorage.setItem('currentUser', 'cet6'));
  await mp.goto(BASE + '/modules/vocabulary/index.html', { waitUntil: 'load' });
  await mp.waitForTimeout(900);
  await mp.evaluate(() => {
    const m = document.querySelector('.modal-backdrop[aria-label="选择主题"]');
    if (m) m.remove();
    document.querySelectorAll('details').forEach((d) => { d.open = true; });   // 设置区默认折叠
  });
  record('模块页存在「获取模型列表」按钮', await mp.locator('#fetchModelsBtn').count() === 1);

  await mp.fill('#aiUrlInput', API + '/v1');
  await mp.fill('#apiKeyInput', TEST_KEY);
  await mp.click('#fetchModelsBtn');
  await mp.waitForSelector('#aiModelList .ai-model-item', { timeout: 8000 });
  const mItems = await mp.locator('#aiModelList .ai-model-item').allTextContents();
  record('模块页：模型列表渲染 3 项', mItems.length === 3, JSON.stringify(mItems));
  const mSkin = await mp.evaluate(() => {
    const item = document.querySelector('#aiModelList .ai-model-item');
    const list = document.getElementById('aiModelList');
    const ci = getComputedStyle(item);
    const cl = getComputedStyle(list);
    return { radius: ci.borderRadius, listRadius: cl.borderRadius, border: cl.borderTopColor, h: Math.round(item.getBoundingClientRect().height) };
  });
  record('模块页：列表套用方角描边皮肤（arknights 覆盖生效）',
    mSkin.radius === '0px' && mSkin.listRadius === '1px' && mSkin.h >= 40, JSON.stringify(mSkin));
  await mp.click('#aiModelList .ai-model-item:nth-child(3)');
  await mp.waitForTimeout(250);
  const mStored = await mp.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('cet6study.v1') || '{}');
    return d.aiModel || '';
  });
  record('模块页：点条目 → 写入输入框并保存',
    (await mp.inputValue('#aiModelInput')) === mItems[2] && mStored === mItems[2],
    'input=' + (await mp.inputValue('#aiModelInput')) + ' stored=' + mStored);
  await mp.screenshot({ path: '/tmp/shot-ai-module.png' });

  /* ================= 关于弹窗 ================= */
  await page.bringToFront();   // 后台标签页会被节流，先切回前台再截图
  await page.evaluate(() => {
    const t = document.querySelector('.toast');
    if (t) t.remove();
    document.getElementById('settingsModal').classList.add('hidden');
    document.getElementById('aboutModal').classList.remove('hidden');
  });
  await page.waitForTimeout(250);
  const aboutText = await page.locator('#aboutModal .about-list').textContent();
  record('关于弹窗已删除「树莓派」部署行', !/树莓派|Cloudflare/.test(aboutText || ''),
    (aboutText || '').replace(/\s+/g, ' ').trim());
  /* 光看 textContent 是不够的：要确认它真的画在屏幕上、且在视口内 */
  const aboutVis = await page.evaluate(() => {
    const modal = document.getElementById('aboutModal');
    const card = modal.querySelector('.modal-card');
    const r = card.getBoundingClientRect();
    const vh = window.innerHeight;
    const cx = r.left + r.width / 2, cy = r.top + Math.min(r.height, vh) / 2;
    const hit = document.elementFromPoint(cx, Math.min(Math.max(cy, 1), vh - 1));
    return {
      display: getComputedStyle(modal).display,
      card: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) },
      vh,
      onTop: !!(hit && modal.contains(hit)),
      inView: r.top >= 0 && r.bottom <= vh
    };
  });
  record('关于弹窗真的可见且在视口内（不是「有文字但没画出来」）',
    aboutVis.display !== 'none' && aboutVis.onTop && aboutVis.inView,
    JSON.stringify(aboutVis));
  await page.screenshot({ path: '/tmp/shot-about.png' });

  record('无未捕获脚本错误（pageerror）',
    !errors.some((e) => e.indexOf('pageerror') === 0),
    errors.filter((e) => e.indexOf('pageerror') === 0).slice(0, 2).join(' | ') || '(clean)');

  await browser.close();
  await new Promise((r) => server.close(r));
  await new Promise((r) => apiServer.close(r));
}

main().catch((e) => { console.error('verify crashed:', e); process.exit(1); }).finally(() => {
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n=== ' + (results.length - failed) + '/' + results.length + ' PASS ===');
  process.exit(failed ? 2 : 0);
});
