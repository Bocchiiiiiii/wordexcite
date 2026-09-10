/* verify-web.mjs — 无头浏览器验证 v1.19.0 改动（Edge/Chromium，playwright-core）
 * 验证项：
 *  1. 启动页 start.webp 撑满整屏（.app-splash-img 计算样式）且加载条在顶层
 *  2. 首页 boot 正常（今日 0/30 + 词库名）
 *  3. 内置预生成知识确实种入缓存（window.Utils.getKnowledge('abandon') 命中 v3）——bug1 的最终证明
 *  4. 词汇模块：AI 配置、人设区、写词功能元素存在，统计渲染，无未捕获错误
 *  5. 写一遍单词：回车触发纯比对，正确/错误回显（不依赖学习会话，读 .kc-en）
 */
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:8760';
const results = [];
let browser;

function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
}

async function main() {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  /* ---- 1. 启动页全屏 + 加载条顶层（在 app 淡出前抓一次计算样式） ---- */
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(50);
  const splash = await page.evaluate(() => {
    const img = document.querySelector('.app-splash-img');
    const bar = document.querySelector('.app-splash-progress');
    if (!img || !bar) return null;
    const c = (el) => getComputedStyle(el);
    const i = c(img), b = c(bar);
    return {
      img: { position: i.position, inset: i.inset, width: i.width, height: i.height, objFit: i.objectFit, z: i.zIndex },
      bar: { position: b.position, z: b.zIndex, top: b.top },
    };
  });
  record('splash fills screen (position:absolute, inset:0, 100w/h, cover)',
    splash && splash.img.position === 'absolute' && splash.img.width === '390px' && splash.img.height === '844px' && splash.img.objFit === 'cover',
    JSON.stringify(splash && splash.img));
  record('loading bar on top layer (z-index>=2, positioned)',
    splash && Number(splash.bar.z) >= 2,
    'bar z=' + (splash && splash.bar.z) + ' top=' + (splash && splash.bar.top));

  /* ---- 2 + 3. 设置用户 → boot → 校验统计 + 知识种入 ---- */
  await page.addInitScript(() => localStorage.setItem('currentUser', 'cet6'));
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('todayTag') && !/…/.test(document.getElementById('todayTag').textContent), { timeout: 30000 }).catch(() => {});
  const boot = await page.evaluate(() => ({
    tag: document.getElementById('todayTag').textContent.trim(),
    name: document.getElementById('vocabCardName').textContent.trim(),
  }));
  record('dashboard boots (今天计数 + 词库名)', /今日 \d+/.test(boot.tag) && boot.name === '六级背单词', JSON.stringify(boot));
  const seeded = await page.evaluate(() => {
    const k = (window.Utils && window.Utils.getKnowledge) ? window.Utils.getKnowledge('abandon') : null;
    return k ? { v: k.v, en: k.en, meanings: (k.meanings || []).length } : null;
  }).catch(() => null);
  record('bug1: 内置预生成知识种入缓存 (getKnowledge(bundledWord) 命中 v3)',
    seeded && seeded.v === 3,
    JSON.stringify(seeded));

  /* ---- 4 + 5. 词汇模块 ---- */
  const vp = await browser.newPage({ viewport: { width: 390, height: 844 } });
  vp.on('pageerror', (e) => errors.push('vocab pageerror: ' + e.message));
  await vp.addInitScript(() => localStorage.setItem('currentUser', 'cet6'));
  await vp.goto(BASE + '/modules/vocabulary/index.html', { waitUntil: 'load' });
  await vp.waitForFunction(() => {
    const t = document.getElementById('statMastered');
    return t && t.textContent.trim() === '0 / 5407';
  }, { timeout: 30000 }).catch(() => {});
  const vocab = await vp.evaluate(() => ({
    mastered: document.getElementById('statMastered') ? document.getElementById('statMastered').textContent.trim() : null,
    personaInput: !!document.getElementById('aiPersonaInput'),
    personaCat: !!document.getElementById('personaCat'),
    personaBro: !!document.getElementById('personaBro'),
    aiUrl: !!document.getElementById('aiUrlInput'),
    exportBtn: !!document.getElementById('exportBackup'),
    writeBtn: !!document.getElementById('kcWriteBtn'),
  }));
  record('vocab module renders stats (mastered 0/5407)', vocab.mastered === '0 / 5407', JSON.stringify(vocab));
  record('vocab new UI present (persona/ai/write/export)',
    !!(vocab.aiUrl && vocab.personaInput && vocab.personaCat && vocab.personaBro && vocab.exportBtn && vocab.writeBtn),
    JSON.stringify(vocab));

  /* 写一遍单词：回车触发纯比对（读 .kc-en，不依赖学习会话） */
  await vp.evaluate(() => {
    const themeModal = document.querySelector('.modal-backdrop[aria-label="选择主题"]');
    if (themeModal) themeModal.remove();   // 首启主题选择弹窗会拦截点击，先移除
    document.getElementById('knowledgeOverlay').classList.remove('hidden');
    document.getElementById('kcContent').innerHTML = '<div class="kc-wordline"><span class="kc-en">abandon</span></div>';
    document.getElementById('kcWriteInputWrap').classList.remove('hidden');
    document.getElementById('kcWriteFeedback').classList.add('hidden');
  });
  await vp.fill('#kcWriteInput', 'abandon');
  await vp.click('#kcWriteCheck');
  const okText = await vp.locator('#kcWriteFeedback').textContent().catch(() => '');
  record('write-word 点「检查」正确回显「拼写正确」', /拼写正确/.test(okText || ''), 'feedback=' + (okText || '').trim());
  await vp.fill('#kcWriteInput', 'abndno');
  await vp.click('#kcWriteCheck');
  const badText = await vp.locator('#kcWriteFeedback').textContent().catch(() => '');
  record('write-word 点「检查」错误回显「拼写不对」且不漏正确拼写',
    /拼写不对/.test(badText || '') && !/abandon/.test(badText || ''),
    'feedback=' + (badText || '').trim());

  record('no uncaught script errors', !errors.some((e) => e.indexOf('pageerror') === 0),
    errors.filter((e) => e.indexOf('pageerror') === 0).slice(0, 2).join(' | ') || '(no script exceptions; local /api/ 404 为完全本地预期降级)');
  await browser.close();
}

main().catch((e) => { console.error('verify crashed:', e); process.exit(1); }).finally(() => {
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n=== ' + (results.length - failed) + '/' + results.length + ' PASS ===');
  process.exit(failed ? 2 : 0);
});
