/* verify-askai.mjs — 追问 AI「这次没有收到回答」回归测试（v1.23.0）
 * 背景（实测到的真因）：DeepSeek V4 这类推理模型流式先吐 delta.reasoning_content（思考），
 *   delta.content 为 null；旧解析只读 content → 永远拿不到正文。
 *   且思考同样占用 max_tokens，预算小 → finish_reason=length 且 content 为空。
 * 本脚本用「假推理模型接口」复现这两种行为，验证修复后能拿到正文：
 *   1) 预算不足时只吐思考 + finish_reason=length  → App 必须自动加码重试并拿到正文
 *   2) 永远只吐思考（think-only 模型）            → App 必须给出可读提示而不是静默空回复
 *   3) 非流式（知识卡 json 模式）同理：空正文 + 有思考 → 自动加码重试
 * 全部离线（本机假服务器），走真实 UI 路径：开始学习 → 点单词 → 知识卡 → 追问。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('D:/Coding/Enexcite/package.json');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(process.cwd());
const SITE = 8768, API = 8767;
const BASE = 'http://127.0.0.1:' + SITE;
const API_BASE = 'http://127.0.0.1:' + API;
const KEY = 'test-key';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
}

const calls = [];   // 记录每次请求 {model, stream, max_tokens}

function sse(res, chunks) {
  res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}
const chunk = (delta, finish) => ({ choices: [{ index: 0, delta: delta, finish_reason: finish || null }] });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Max-Age': '0'
};

function serveApi(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch (e) { /* */ }
    const model = j.model || '';
    const stream = !!j.stream;
    const mt = j.max_tokens || 0;
    const sysMsg = (j.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join(String.fromCharCode(10));
    calls.push({ model, stream, max_tokens: mt, reasoning_effort: j.reasoning_effort || null, system: sysMsg });

    /* 「不认关思考参数」的服务商：收到 reasoning_effort 就 400（验证自动降级） */
    if (model === 'strict-provider' && j.reasoning_effort) {
      res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: reasoning_effort' } }));
      return;
    }

    if (stream) {
      if (model === 'think-only') {
        const cs = [chunk({ role: 'assistant', content: null, reasoning_content: '' })];
        for (let i = 0; i < 12; i++) cs.push(chunk({ content: null, reasoning_content: '思考' + i }));
        cs.push(chunk({ content: null, reasoning_content: '' }, 'length'));
        return sse(res, cs);
      }
      if (model === 'strict-provider') {   /* 只是不认未知参数，其它一切正常 */
        const cs = [chunk({ role: 'assistant', content: null, reasoning_content: '' })];
        for (const t of ['abandon', ' 是及物动词', '，常见搭配 abandon oneself to…']) cs.push(chunk({ content: t }));
        cs.push(chunk({ content: null }, 'stop'));
        return sse(res, cs);
      }
      if (mt < 4000) {   /* 旧的失败形态：思考吃光预算，正文一个字都没有 */
        const cs = [chunk({ role: 'assistant', content: null, reasoning_content: '' })];
        for (let i = 0; i < 20; i++) cs.push(chunk({ content: null, reasoning_content: '想' + i }));
        cs.push(chunk({ content: null, reasoning_content: '' }, 'length'));
        return sse(res, cs);
      }
      const cs = [chunk({ role: 'assistant', content: null, reasoning_content: '' })];
      for (let i = 0; i < 6; i++) cs.push(chunk({ content: null, reasoning_content: '想' + i }));
      for (const t of ['abandon', ' 是及物动词', '，常见搭配 abandon oneself to…', '例句：He abandoned his car.']) {
        cs.push(chunk({ content: t, reasoning_content: null }));
      }
      cs.push(chunk({ content: null, reasoning_content: null }, 'stop'));
      return sse(res, cs);
    }

    /* 非流式（知识卡）：预算不足时正文为空、只有思考 */
    const content = mt >= 4000 ? '{"meanings":[{"pos":"v.","zh":"放弃"}],"variants":[],"phrases":[],"examples":[]}' : '';
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        index: 0,
        message: { role: 'assistant', content: content, reasoning_content: content ? '' : '思考中…' },
        finish_reason: content ? 'stop' : 'length'
      }]
    }));
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
function serveSite(req, res) {
  const url = new URL(req.url, BASE);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, rel.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

/* 一个阶段 = 一个干净浏览器上下文（避免上一阶段的历史/知识缓存干扰断言） */
async function phase(browser, model, noThink) {
  const ctx = await browser.newContext({ viewport: { width: 414, height: 900 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  /* 只在字段缺失时播种：否则 reload 会用种子值覆盖「界面上刚改的设置」（本阶段 E 要验证持久化） */
  await page.addInitScript(([apiBase, key, mdl, noThinkFlag, persona]) => {
    localStorage.setItem('currentUser', 'cet6');
    const cur = JSON.parse(localStorage.getItem('cet6study.v1') || '{}');
    if (!cur.aiUrl) cur.aiUrl = apiBase + '/v1';
    if (!cur.apiKey) cur.apiKey = key;
    if (!cur.aiModel) cur.aiModel = mdl;
    if (cur.theme == null) cur.theme = 'warm';
    if (cur.aiPersona == null || cur.aiPersona === '') cur.aiPersona = persona;
    if (cur.aiNoThink == null) cur.aiNoThink = noThinkFlag;
    localStorage.setItem('cet6study.v1', JSON.stringify(cur));
  }, [API_BASE, KEY, model, noThink, '你是六级英语词汇助教。']);

  await page.goto(BASE + '/modules/vocabulary/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const m = document.querySelector('.modal-backdrop[aria-label="选择主题"]');
    if (m) m.remove();
  });

  /* 真实路径：开始学习 → 手指点单词（记不清）→ 知识卡 → 追问 */
  await page.click('#startBtn');
  await page.waitForSelector('#studyPage:not(.hidden)', { timeout: 8000 });
  await page.waitForTimeout(400);
  const box = await page.locator('#wordDisplay').boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector('#knowledgeOverlay:not(.hidden)', { timeout: 8000 });
  await page.waitForTimeout(800);

  const before = calls.length;
  await page.fill('#aiInput', 'give me an example sentence');
  await page.click('#aiSend');
  await page.waitForFunction(() => {
    const b = document.querySelectorAll('#aiMessages .ai-bubble');
    const last = b[b.length - 1];
    return last && !last.classList.contains('typing') && last.textContent.trim().length > 0;
  }, null, { timeout: 25000 });
  await page.waitForTimeout(500);
  const answer = await page.evaluate(() => {
    const b = document.querySelectorAll('#aiMessages .ai-bubble');
    return b[b.length - 1].textContent.trim();
  });
  return { page, ctx, errors, answer, phaseCalls: calls.slice(before) };
}

async function main() {
  const site = http.createServer(serveSite);
  await new Promise((r) => site.listen(SITE, '127.0.0.1', r));
  const api = http.createServer(serveApi);
  await new Promise((r) => api.listen(API, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });

  /* ---- 阶段 A：推理模型，思考吃光初始预算 → 必须自动加码重试并拿到正文 ---- */
  const a = await phase(browser, 'fake-reasoner', false);
  const aStream = a.phaseCalls.filter((c) => c.stream);
  record('追问能拿到正文（不再是「没有收到回答」）',
    /及物动词/.test(a.answer) && !/没有收到回答/.test(a.answer), 'bubble=' + JSON.stringify(a.answer.slice(0, 70)));
  record('思考吃光预算时自动加码重试（2000 → 6000）',
    aStream.length === 2 && aStream[0].max_tokens === 2000 && aStream[1].max_tokens === 6000,
    'max_tokens 序列=' + JSON.stringify(aStream.map((c) => c.max_tokens)));
  record('阶段 A 无未捕获脚本错误', a.errors.length === 0, a.errors.slice(0, 1).join(''));
  await a.page.screenshot({ path: '/tmp/shot-askai.png' });
  await a.ctx.close();

  /* ---- 阶段 B：think-only 模型（永远只吐思考）→ 必须给可读提示，且知识卡也要能自愈 ---- */
  const b = await phase(browser, 'think-only', false);
  const bStream = b.phaseCalls.filter((c) => c.stream);
  record('只有思考没有正文时给出可读提示（含「被截断」说明）',
    /没有收到回答/.test(b.answer) && /截断/.test(b.answer), 'bubble=' + JSON.stringify(b.answer));
  record('think-only 有界重试：只加码一次就放弃（2000 → 6000，不无限烧 token）',
    bStream.length === 2 && bStream[0].max_tokens === 2000 && bStream[1].max_tokens === 6000,
    'max_tokens=' + JSON.stringify(bStream.map((c) => c.max_tokens)));
  /* 知识卡（非流式 json 模式）：知识缓存存 IndexedDB，清 localStorage 清不掉，
     所以点「刷新知识卡」强制重新生成，才能验证空正文+有思考时的自动加码重试 */
  const beforeKc = calls.length;
  await b.page.click('#kcRefresh');
  await b.page.waitForTimeout(2500);
  const bNonStream = calls.slice(beforeKc).filter((c) => !c.stream);
  const kcText = await b.page.evaluate(() => document.getElementById('kcContent').textContent);
  record('知识卡（非流式 json）：空正文+有思考时自动加码重试（1600 → 4800）',
    bNonStream.some((c) => c.max_tokens === 1600) && bNonStream.some((c) => c.max_tokens === 4800),
    '非流式 max_tokens=' + JSON.stringify(bNonStream.map((c) => c.max_tokens)));
  record('知识卡加码重试后卡片真的渲染出内容',
    /放弃/.test(kcText || ''), 'kcContent=' + JSON.stringify((kcText || '').slice(0, 40)));
  record('阶段 B 无未捕获脚本错误', b.errors.length === 0, b.errors.slice(0, 1).join(''));
  await b.ctx.close();

  /* ---- 阶段 C：关掉深度思考 → 请求必须带 reasoning_effort=none，且不再吐思考 ---- */
  const c = await phase(browser, 'think-only', true);
  const cStream = c.phaseCalls.filter((x) => x.stream);
  record('关闭深度思考：请求始终带 reasoning_effort=none',
    cStream.length >= 1 && cStream.every((x) => x.reasoning_effort === 'none'),
    '请求参数=' + JSON.stringify(cStream.map((x) => x.reasoning_effort)));
  record('关闭深度思考：模型仍只吐思考时给出可读提示（不静默空白）',
    /没有收到回答/.test(c.answer), 'bubble=' + JSON.stringify(c.answer.slice(0, 40)));
  await c.ctx.close();

  /* ---- 阶段 D：服务商不认这个参数（400）→ 自动去掉参数重试，仍能回答 ---- */
  const d = await phase(browser, 'strict-provider', true);
  const dStream = d.phaseCalls.filter((x) => x.stream);
  record('服务商 400 拒绝关思考参数时自动降级重试（不再带该参数）',
    dStream.length === 2 && dStream[0].reasoning_effort === 'none' && dStream[1].reasoning_effort === null,
    '请求参数序列=' + JSON.stringify(dStream.map((x) => x.reasoning_effort)));
  record('降级后仍能拿到正文', /及物动词/.test(d.answer), 'bubble=' + JSON.stringify(d.answer.slice(0, 50)));
  await d.ctx.close();

  /* ---- 阶段 E：人设持久化（v1.25.0 修的真 bug）+ 提示词要求简短/纯文本 ---- */
  const e = await phase(browser, 'strict-provider', true);
  const before = calls.length;
  /* 走真实 UI：模块页设置里点「可爱猫娘」，再刷新页面（模拟重新进入模块） */
  await e.page.evaluate(() => {
    document.querySelectorAll('details').forEach((d) => { d.open = true; });
    document.getElementById('personaCat').click();
  });
  await e.page.waitForTimeout(600);
  const savedRightAway = await e.page.evaluate(() => JSON.parse(localStorage.getItem('cet6study.v1') || '{}').aiPersona || '');
  await e.page.reload({ waitUntil: 'load' });
  await e.page.waitForTimeout(1200);
  const afterReload = await e.page.evaluate(() => JSON.parse(localStorage.getItem('cet6study.v1') || '{}').aiPersona || '');
  record('点「可爱猫娘」立刻写入 localStorage', /猫娘/.test(savedRightAway), 'aiPersona 前缀=' + JSON.stringify(savedRightAway.slice(0, 24)));
  record('刷新/重进页面后人设仍在（不再被 normalizeStudyData 丢掉）',
    /猫娘/.test(afterReload), '刷新后 aiPersona 前缀=' + JSON.stringify(afterReload.slice(0, 24)));

  await e.page.evaluate(() => { const m = document.querySelector('.modal-backdrop[aria-label="选择主题"]'); if (m) m.remove(); });
  await e.page.click('#startBtn');
  await e.page.waitForSelector('#studyPage:not(.hidden)', { timeout: 8000 });
  await e.page.waitForTimeout(400);
  const ebox = await e.page.locator('#wordDisplay').boundingBox();
  await e.page.touchscreen.tap(ebox.x + ebox.width / 2, ebox.y + ebox.height / 2);
  await e.page.waitForSelector('#knowledgeOverlay:not(.hidden)', { timeout: 8000 });
  await e.page.waitForTimeout(700);
  await e.page.fill('#aiInput', 'hello');
  await e.page.click('#aiSend');
  await e.page.waitForTimeout(2500);
  const eSys = (calls.slice(before).find((c) => c.stream && c.system) || {}).system || '';
  record('追问请求带的是猫娘人设（不是默认的暴躁老哥）',
    /猫娘/.test(eSys) && !/孙笑川/.test(eSys), 'system 前缀=' + JSON.stringify(eSys.slice(0, 30)));
  record('提示词要求简短回答 + 不用 Markdown',
    /简短/.test(eSys) && /不要使用 Markdown/.test(eSys), '包含简短=' + /简短/.test(eSys) + ' 包含纯文本要求=' + /不要使用 Markdown/.test(eSys));
  await e.ctx.close();

  await browser.close();
  await new Promise((r) => site.close(r));
  await new Promise((r) => api.close(r));
}

main().catch((e) => { console.error('verify crashed:', e); process.exit(1); }).finally(() => {
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n=== ' + (results.length - failed) + '/' + results.length + ' PASS ===');
  process.exit(failed ? 2 : 0);
});
