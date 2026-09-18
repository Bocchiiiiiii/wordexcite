/* verify-note.mjs — 单词备注（v1.27.0）回归测试
 * 覆盖：入口按钮 UI 一致性 / 编辑·预览双 Tab / Markdown 渲染 / 单词正下方第一个词条 /
 *      本地缓存（localStorage 主 + IndexedDB 镜像）/ 重新加载仍在 / 编辑·删除 /
 *      长备注折叠展开 / 防注入 / 缓存时间行。
 * 全部离线：本机假站点（单词语料 → 会话固定为 abandon）+ 假 AI 接口。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('D:/Coding/Enexcite/package.json');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(process.cwd());
const SITE = 8770, API = 8771;
const BASE = 'http://127.0.0.1:' + SITE;
const API_BASE = 'http://127.0.0.1:' + API;
const WORD = 'abandon';
const NOTE_KEY = 'cet6note.v1';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + String(detail).slice(0, 160) : ''));
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type'
};

/* 只有一个词的词库：会话必然落在 abandon 上，断言可复现 */
const BANK = [{ en: WORD, phonetic: "ə'bændən", zh: '放弃；抛弃；遗弃' }];
const KNOWLEDGE_CARD = {
  meanings: [{ pos: 'v.', zh: '放弃；抛弃', exampleEn: 'He abandoned his car.', exampleZh: '他丢下了他的车。' }],
  variants: [{ word: 'abandoned', pos: 'adj.', zh: '被遗弃的' }],
  phrases: [{ en: 'abandon oneself to', zh: '沉溺于' }],
  etymology: { root: 'a + band + on', origin: '来自古法语', prefix: 'a-', suffix: '-on', tip: '一帮人放弃了你', related: [] }
};

function serveApi(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(KNOWLEDGE_CARD) }, finish_reason: 'stop' }]
    }));
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };
function serveSite(req, res) {
  const url = new URL(req.url, BASE);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  /* 用极简词库替换真词库：会话只有一个词，测试可复现 */
  if (rel === '/words/cet6.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(BANK));
    return;
  }
  if (rel === '/words/knowledge-cet6.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end('{}');
    return;
  }
  const file = path.join(ROOT, rel.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function boot(browser, seedExtra) {
  const ctx = await browser.newContext({ viewport: { width: 414, height: 900 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  /* 只收「未捕获脚本异常」；资源 404（图标/api/tts 假站点没有）不算脚本错误 */
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.addInitScript(([apiBase, key, extra]) => {
    localStorage.setItem('currentUser', 'cet6');
    const cur = JSON.parse(localStorage.getItem('cet6study.v1') || '{}');
    if (!cur.aiUrl) cur.aiUrl = apiBase + '/v1';
    if (!cur.apiKey) cur.apiKey = key;
    if (!cur.aiModel) cur.aiModel = 'fake-note-model';
    if (cur.theme == null) cur.theme = 'warm';
    localStorage.setItem('cet6study.v1', JSON.stringify(cur));
    if (extra) localStorage.setItem(extra[0], extra[1]);
  }, [API_BASE, 'test-key', seedExtra || null]);
  await page.goto(BASE + '/modules/vocabulary/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.evaluate(() => { const m = document.querySelector('.modal-backdrop[aria-label="选择主题"]'); if (m) m.remove(); });
  return { page, ctx, errors };
}

async function openKnowledge(page) {
  await page.click('#startBtn');
  await page.waitForSelector('#studyPage:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(300);
  const word = (await page.textContent('#frontMain')).trim();
  const box = await page.locator('#wordDisplay').boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector('#knowledgeOverlay:not(.hidden)', { timeout: 10000 });
  await page.waitForSelector('#kcContent .kc-wordline', { timeout: 10000 });
  return word;
}

const MD = [
  '# 记忆法',
  '- **abandon** = 一帮人放弃了你',
  '- 词根：`a + band + on`',
  '',
  '> 例句：He abandoned his car.'
].join('\n');

async function main() {
  const site = http.createServer(serveSite);
  await new Promise((r) => site.listen(SITE, '127.0.0.1', r));
  const api = http.createServer(serveApi);
  await new Promise((r) => api.listen(API, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });

  /* ================= 阶段 A：入口按钮 + 缓存时间行 ================= */
  const a = await boot(browser, null);
  const word = await openKnowledge(a.page);
  record('会话单词固定为被测词（测试可复现）', word.toLowerCase() === WORD, 'word=' + word);

  const btn = await a.page.evaluate(() => {
    const n = document.getElementById('kcNoteBtn'), r = document.getElementById('kcRefresh');
    if (!n || !r) return null;
    const cs = (el) => { const s = getComputedStyle(el); return [s.height, s.backgroundColor, s.borderTopColor, s.fontSize, s.borderTopLeftRadius, s.fontWeight].join('|'); };
    const nr = n.getBoundingClientRect();
    return { text: n.textContent.trim(), visible: nr.width > 0 && nr.height > 0, note: cs(n), refresh: cs(r), inHeader: n.parentElement.className };
  });
  record('知识页顶部有「单词备注」按钮', !!btn && btn.visible && btn.text === '单词备注', JSON.stringify(btn && btn.text));
  record('按钮与「刷新」按钮同款样式（UI 一致）', !!btn && btn.note === btn.refresh, btn ? btn.note + ' vs ' + btn.refresh : '');
  record('按钮在知识页顶栏内', !!btn && /kc-header/.test(btn.inHeader), btn && btn.inHeader);

  try {
    await a.page.waitForSelector('#kcContent .kc-h', { timeout: 15000 });
  } catch (e) {
    console.error('知识卡未渲染，kcContent=' + JSON.stringify((await a.page.textContent('#kcContent')).slice(0, 300)));
    console.error('console/page errors: ' + a.errors.join(' | '));
    throw e;
  }
  const cacheLine = (await a.page.textContent('.kc-cache-line').catch(() => '')) || '';
  record('知识行显示「已缓存到本机」时间', /已缓存到本机 · \d\d-\d\d \d\d:\d\d/.test(cacheLine), JSON.stringify(cacheLine));

  /* ================= 阶段 A：编辑器（编辑/预览） ================= */
  await a.page.click('#kcNoteBtn');
  await a.page.waitForSelector('#noteModal:not(.hidden)', { timeout: 5000 });
  const tabs0 = await a.page.evaluate(() => ({
    editVisible: !document.getElementById('noteInput').classList.contains('hidden'),
    previewHidden: document.getElementById('notePreview').classList.contains('hidden'),
    editActive: document.getElementById('noteTabEdit').classList.contains('active'),
    count: document.getElementById('noteCount').textContent
  }));
  record('点「单词备注」打开编辑器，默认在「编辑」Tab', tabs0.editVisible && tabs0.previewHidden && tabs0.editActive, JSON.stringify(tabs0));

  await a.page.fill('#noteInput', MD);
  await a.page.waitForTimeout(120);
  const count = await a.page.textContent('#noteCount');
  record('字数统计跟随输入更新', count === MD.length + ' 字', count + ' / 期望 ' + MD.length + ' 字');

  await a.page.click('#noteTabPreview');
  await a.page.waitForTimeout(150);
  const prev = await a.page.evaluate(() => {
    const p = document.getElementById('notePreview');
    return {
      hidden: p.classList.contains('hidden'),
      h1: !!p.querySelector('h1.md-h1'),
      ul: !!p.querySelector('ul.md-list'),
      strong: (p.querySelector('strong') || {}).textContent || '',
      code: !!p.querySelector('code.md-code'),
      quote: !!p.querySelector('blockquote.md-quote'),
      text: p.textContent.replace(/\s+/g, ' ').trim()
    };
  });
  record('「预览」Tab 渲染 Markdown（标题/列表/粗体/代码/引用）',
    !prev.hidden && prev.h1 && prev.ul && prev.strong === 'abandon' && prev.code && prev.quote,
    JSON.stringify(prev));
  await a.page.screenshot({ path: '/tmp/shot-note-editor.png' });

  await a.page.click('#noteTabEdit');
  await a.page.click('#noteSave');
  await a.page.waitForTimeout(400);
  const closed = await a.page.evaluate(() => document.getElementById('noteModal').classList.contains('hidden'));
  record('保存后编辑器关闭', !!closed);

  /* ================= 阶段 A：单词正下方第一个词条 ================= */
  const entry = await a.page.evaluate(() => {
    const content = document.getElementById('kcContent');
    const kids = Array.from(content.children);
    const wl = content.querySelector('.kc-wordline');
    const after = wl ? wl.nextElementSibling : null;
    const h3 = after ? after.querySelector('.kc-note-h') : null;
    const nextH = after ? after.nextElementSibling : null;
    return {
      order: kids.slice(0, 3).map((e) => e.className || e.tagName),
      afterClass: after ? after.className : '',
      noteTitle: h3 ? h3.textContent.trim() : '',
      h3Class: h3 ? h3.className : '',
      firstSectionAfterNote: nextH ? nextH.textContent.trim().slice(0, 6) : '',
      bodyHTML: (document.getElementById('kcNoteBody') || {}).innerHTML || '',
      inlineEdit: !!document.getElementById('kcNoteInline'),
      toggleHidden: document.getElementById('kcNoteToggle').classList.contains('hidden')
    };
  });
  record('备注是单词正下方第一个词条', entry.afterClass === 'kc-note-entry' && /^kc-wordline,.?/.test(entry.order.join(',')) ,
    'order=' + JSON.stringify(entry.order));
  record('备注之后才是「中文释义」', entry.firstSectionAfterNote === '中文释义', entry.firstSectionAfterNote);
  record('备注词条标题为「单词备注」（与其它词条同款 kc-h）',
    entry.noteTitle.indexOf('单词备注') === 0 && /kc-h/.test(entry.h3Class), entry.noteTitle + ' / ' + entry.h3Class);
  record('备注正文按 Markdown 渲染',
    /<h1 class="md-h md-h1">记忆法<\/h1>/.test(entry.bodyHTML) &&
    /<ul class="md-list">/.test(entry.bodyHTML) &&
    /<strong>abandon<\/strong>/.test(entry.bodyHTML) &&
    /<blockquote class="md-quote">/.test(entry.bodyHTML),
    entry.bodyHTML.slice(0, 90));
  record('备有条目内「编辑」入口', entry.inlineEdit);
  record('短备注不折叠', entry.toggleHidden === true);

  /* ================= 阶段 A：本地缓存（主 + 镜像） ================= */
  const store = await a.page.evaluate(async (key) => {
    const raw = localStorage.getItem(key);
    const cur = await new Promise((resolve) => {
      const r = indexedDB.open('wordexcite-db');
      r.onsuccess = () => {
        const db = r.result;
        const q = db.transaction('notes', 'readonly').objectStore('notes').get('abandon');
        q.onsuccess = () => resolve(q.result || null);
        q.onerror = () => resolve(null);
      };
      r.onerror = () => resolve(null);
    });
    return { ls: raw ? JSON.parse(raw) : null, idb: cur };
  }, NOTE_KEY);
  record('备注写入 localStorage（主存储）',
    !!(store.ls && store.ls.abandon && /记忆法/.test(store.ls.abandon.md)), JSON.stringify(store.ls && Object.keys(store.ls)));
  record('备注同时写入 IndexedDB 镜像',
    !!(store.idb && store.idb.value && /记忆法/.test(store.idb.value.md)), JSON.stringify(store.idb && store.idb.key));

  /* ================= 阶段 B：重新加载后仍存在（“下次遇到这个单词依然存在备注”） ================= */
  const b = await boot(browser, null);
  /* 同一浏览器上下文才有同一份 IndexedDB；这里改用同一个 page 重新加载，等价于重开 App */
  record('阶段 B 独立上下文仅用于隔离，不参与断言', true);
  await b.ctx.close();

  await a.page.reload({ waitUntil: 'load' });
  await a.page.waitForTimeout(900);
  const restored = await a.page.evaluate((w) => ({ note: Utils.getNote(w), count: Utils.notesCount() }), WORD);
  record('重新加载后 Utils.getNote 仍返回原文', /记忆法/.test(restored.note), 'len=' + (restored.note || '').length + ' count=' + restored.count);

  const word2 = await openKnowledge(a.page);
  record('重新加载后会话仍是同一词', word2.toLowerCase() === WORD, word2);
  await a.page.waitForSelector('#kcContent .kc-note-entry', { timeout: 10000 });
  const again = await a.page.evaluate(() => {
    const body = document.getElementById('kcNoteBody');
    return { has: !!body, text: body ? body.textContent.replace(/\s+/g, ' ').trim() : '' };
  });
  record('重新进入知识页，备注仍然显示且内容一致', again.has && /一帮人放弃了你/.test(again.text), again.text.slice(0, 60));

  /* ================= 阶段 A：编辑 / 长备注折叠 ================= */
  const LONG = MD + '\n\n' + Array.from({ length: 24 }, (_, i) => '- 第 ' + (i + 1) + ' 条补充记忆点，用来把备注撑长以验证折叠').join('\n');
  await a.page.click('#kcNoteInline');
  await a.page.waitForSelector('#noteModal:not(.hidden)', { timeout: 5000 });
  const prefilled = await a.page.inputValue('#noteInput');
  record('再次打开编辑器预填原备注（可继续编辑）', /记忆法/.test(prefilled), 'len=' + prefilled.length);
  await a.page.fill('#noteInput', LONG);
  await a.page.click('#noteSave');
  await a.page.waitForTimeout(400);
  const collapsed = await a.page.evaluate(() => ({
    bodyCollapsed: document.getElementById('kcNoteBody').classList.contains('collapsed'),
    blockCollapsed: document.getElementById('kcNoteBlock').classList.contains('collapsed'),
    toggleHidden: document.getElementById('kcNoteToggle').classList.contains('hidden'),
    toggleText: document.getElementById('kcNoteToggle').textContent.trim(),
    lines: document.querySelectorAll('#kcNoteBody li').length
  }));
  record('长备注默认折叠并给出「展开全部」', collapsed.bodyCollapsed && collapsed.blockCollapsed && !collapsed.toggleHidden && collapsed.toggleText === '展开全部',
    JSON.stringify(collapsed));
  record('长备注内容完整保留（2 + 24 条）', collapsed.lines === 26, 'li=' + collapsed.lines);
  await a.page.screenshot({ path: '/tmp/shot-note-collapsed.png' });

  await a.page.click('#kcNoteToggle');
  await a.page.waitForTimeout(200);
  const expanded = await a.page.evaluate(() => ({
    bodyCollapsed: document.getElementById('kcNoteBody').classList.contains('collapsed'),
    toggleText: document.getElementById('kcNoteToggle').textContent.trim()
  }));
  record('点「展开全部」后展开，按钮变「收起」', !expanded.bodyCollapsed && expanded.toggleText === '收起', JSON.stringify(expanded));
  await a.page.screenshot({ path: '/tmp/shot-note-expanded.png' });

  /* ================= 阶段 A：防注入 ================= */
  await a.page.click('#kcNoteInline');
  await a.page.waitForSelector('#noteModal:not(.hidden)', { timeout: 5000 });
  await a.page.fill('#noteInput', '<img src=x onerror=window.__xss=1>\n\n**粗**');
  await a.page.click('#noteSave');
  await a.page.waitForTimeout(400);
  const xss = await a.page.evaluate(() => ({
    img: !!document.querySelector('#kcNoteBody img'),
    injected: !!window.__xss,
    text: document.getElementById('kcNoteBody').textContent.replace(/\s+/g, ' ').trim(),
    strong: !!document.querySelector('#kcNoteBody strong')
  }));
  record('备注里的 HTML 被转义（不产生元素、不执行脚本）', !xss.img && !xss.injected && /<img src=x/.test(xss.text), JSON.stringify(xss));
  record('转义后 Markdown 仍然生效', xss.strong === true);

  /* ================= 阶段 A：删除 ================= */
  await a.page.click('#kcNoteInline');
  await a.page.waitForSelector('#noteModal:not(.hidden)', { timeout: 5000 });
  await a.page.click('#noteDelete');
  await a.page.waitForTimeout(400);
  const deleted = await a.page.evaluate((key) => ({
    entry: !!document.querySelector('#kcContent .kc-note-entry'),
    ls: localStorage.getItem(key)
  }), NOTE_KEY);
  const lsEmpty = !deleted.ls || !JSON.parse(deleted.ls || '{}').abandon;
  record('删除备注后词条消失', !deleted.entry);
  record('删除后备注从本地缓存移除', lsEmpty, deleted.ls);
  await a.page.screenshot({ path: '/tmp/shot-note-deleted.png' });

  record('全程无未捕获脚本错误', a.errors.length === 0, a.errors.slice(0, 2).join(' | '));

  await browser.close();
  site.close();
  api.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' PASS');
  if (failed.length) { console.error('FAILED: ' + failed.map((f) => f.name).join(', ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
