/* verify-migrate.mjs — 词库标识迁移回归测试（v1.26.0）
 * 背景：早期版本把真人姓名当内部标识（currentUser 里存的就是那两个字，存储键是 base+'.'+名字）。
 * v1.26.0 起改用词库标识（cet6 / ielts），必须保证老用户进度不丢。
 * 本测试用 node:vm 把 shared/utils.js 跑在假 window+localStorage 上，直接验数据层。
 * 注意：测试里用码位（String.fromCharCode）构造旧标识，公开仓库不出现姓名。
 */
import fs from 'node:fs';
import vm from 'node:vm';

const LEGACY_CET6 = String.fromCharCode(0x81FB);
const LEGACY_IELTS = String.fromCharCode(0x6EE2);

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
}

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear()
};

const sandbox = {
  console,
  localStorage,
  setTimeout, clearTimeout, setInterval, clearInterval,
  AbortController,
  TextDecoder, TextEncoder,
  URL,
  fetch: () => Promise.reject(new Error('offline')),
  navigator: { onLine: false },
  document: { querySelector: () => null, createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }), body: { appendChild() {} }, addEventListener() {} },
  location: { origin: 'http://127.0.0.1' }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('shared/utils.js', 'utf8'), sandbox, { filename: 'shared/utils.js' });
const Utils = sandbox.Utils || (sandbox.window && sandbox.window.Utils);
if (!Utils) { console.error('Utils 未挂载'); process.exit(1); }

/* ---- 场景 1：老用户（第二位，存储键带后缀）→ 迁移到 ielts ---- */
store.clear();
localStorage.setItem('currentUser', LEGACY_IELTS);
localStorage.setItem('cet6study.v1.' + LEGACY_IELTS, JSON.stringify({ dailyGoal: 42, words: [{ id: 'w1' }] }));
localStorage.setItem('cet6knowledge.v1.' + LEGACY_IELTS, JSON.stringify({ cache: { abandon: { v: 3 } } }));

record('旧标识被识别为 ielts', Utils.getCurrentUser() === 'ielts', 'getCurrentUser=' + Utils.getCurrentUser());
record('currentUser 已改写为词库标识', localStorage.getItem('currentUser') === 'ielts');
record('学习进度已迁到新键（dailyGoal 保留）',
  (JSON.parse(localStorage.getItem('cet6study.v1.ielts') || '{}').dailyGoal) === 42,
  '新键值=' + localStorage.getItem('cet6study.v1.ielts'));
record('知识缓存也已迁移', !!localStorage.getItem('cet6knowledge.v1.ielts'));
record('词库选择生效（ielts → ielts.json）', Utils.wordBankFile() === 'ielts.json', Utils.wordBankFile());
record('界面标签正确', Utils.userLabel('ielts') === 'IELTS-8000' && Utils.userLabel('cet6') === 'CET6');

/* ---- 场景 2：首位老用户沿用 base key（零迁移，也不能被破坏）---- */
store.clear();
localStorage.setItem('currentUser', LEGACY_CET6);
const baseData = JSON.stringify({ dailyGoal: 30, words: [{ id: 'base1' }] });
localStorage.setItem('cet6study.v1', baseData);

record('首位老标识 → cet6', Utils.getCurrentUser() === 'cet6', Utils.getCurrentUser());
record('首位老用户仍用 base key（进度原位不动）',
  Utils.getUserStorageKey('cet6study.v1') === 'cet6study.v1' && localStorage.getItem('cet6study.v1') === baseData);
record('词库选择生效（cet6 → cet6.json）', Utils.wordBankFile() === 'cet6.json', Utils.wordBankFile());

/* ---- 场景 3：全新用户 / 已是新标识，重复调用幂等 ---- */
store.clear();
localStorage.setItem('currentUser', 'ielts');
record('新标识直接可用（不会被误迁移）', Utils.getCurrentUser() === 'ielts');
store.clear();
record('未选择时为空', Utils.getCurrentUser() === '');

const failed = results.filter((r) => !r.ok).length;
console.log('\n=== ' + (results.length - failed) + '/' + results.length + ' PASS ===');
process.exit(failed ? 2 : 0);
