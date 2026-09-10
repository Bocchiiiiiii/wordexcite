/* ============================================================
 * 树莓派学习小站 · App 打包脚本
 * 把网站静态资源（含 words/*.json 离线词库、sw.js、manifest、图标）
 * 复制到 mobile-app/web/（Capacitor 的 webDir），并对打包副本注入
 * “应用内运行时配置”，使原生 App 在联网时能同步到树莓派服务器。
 *
 * 用法：node scripts/pack-web.mjs
 * 可重复执行；每次会先清空 web/ 再重建，保证与主站一致。
 * ============================================================ */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');          // mobile-app/
const SITE = resolve(APP, '..');          // 网站根目录（仓库根）
const DEST = join(APP, 'web');

/* App 联网时同步到的树莓派服务器基址。
 * 当前默认空字符串 = 完全本地优先：App 不向任何外部服务器发请求，
 * 词库、FSRS、学习流程全部来自本地打包资源，断网/服务器不可达照常可用。
 * 将来树莓派恢复后，把这里改成 'https://example.com' 再重新打包，
 * 即可重新启用在线同步与 TTS。 */
const SERVER_BASE = '';

/* 需要打包进 App 的网站文件。
 * 条目可为：
 *   - 字符串：源与目标相对网站根目录相同；
 *   - [源, 目标]：把源文件复制到 web/ 下的目标相对路径（如把 node_modules 里的
 *     TTS 引擎与模型放到 web/vendor/tts/）。 */
const FILES = [
  'index.html',
  'start.webp',
  'manifest.webmanifest',
  'sw.js',
  'modules/vocabulary/index.html',
  'modules/vocabulary/style.css',
  'modules/vocabulary/script.js',
  'modules/vocabulary/arknights.css',
  'shared/global.css',
  'shared/arknights.css',
  'shared/utils.js',
  'shared/fsrs-adapter.js',
  'shared/vendor/ts-fsrs-5.4.1.js',
  'words/cet6.json',
  'words/ielts.json',
  'words/knowledge-cet6.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'icons/icon-32.png',
  'icons/favicon.ico',
  'icons/picture/fg-icon512.png',
  'icons/picture/fg-icon512-maskable.png',
];

const p = (rel) => join(DEST, ...rel.split('/'));

function clearDir(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function copyFile(entry) {
  const srcRel = (typeof entry === 'string') ? entry : entry[0];
  const dstRel = (typeof entry === 'string') ? entry : entry[1];
  const src = join(SITE, srcRel);
  const dst = p(dstRel);
  if (!existsSync(src)) throw new Error('源文件不存在：' + src);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

/* ------ 注入：让打包副本里的 fetch('/api/*') 在 App 中指向树莓派服务器 ------
 * 主站代码保持不动（网页部署仍走同源相对路径）。 */

// shared/utils.js：把 /api/state、/api/knowledge 拼上基址
const APP_BASE_DECL = String.raw`var APP_API_BASE = (typeof window !== 'undefined' && window.APP_API_BASE)
      ? String(window.APP_API_BASE).replace(/\/+$/, '')
      : '';
  var SERVER_API = APP_API_BASE + '/api/state';`;

const APP_BASE_DECL_KNOW = String.raw`var SERVER_KNOWLEDGE_API = APP_API_BASE + '/api/knowledge';`;

// 两个页面的 HTML：在 utils.js 之前注入服务器基址配置
const CONFIG_SCRIPT =
  "<script>if (!window.APP_API_BASE) window.APP_API_BASE = '" + SERVER_BASE + "';</script>\n";

function replaceOnce(text, target, repl, label) {
  if (text.indexOf(target) === -1) {
    throw new Error('未找到待替换片段：' + label);
  }
  const before = text.split(target);
  const after = before.slice(1).join(target);
  const joined = before[0] + repl + after;
  console.log('[pack]  已注入：' + label);
  return joined;
}

function patchUtils(text) {
  let out = text;
  out = replaceOnce(
    out,
    "var SERVER_API = '/api/state';",
    APP_BASE_DECL,
    'utils.js SERVER_API'
  );
  out = replaceOnce(
    out,
    "var SERVER_KNOWLEDGE_API = '/api/knowledge';",
    APP_BASE_DECL_KNOW,
    'utils.js SERVER_KNOWLEDGE_API'
  );
  return out;
}

function patchHtml(text) {
  const re = /(<script src="[^"]*shared\/utils\.js[^"]*"><\/script>)/;
  if (!re.test(text)) throw new Error('未找到 utils.js 引用：HTML');
  return text.replace(re, CONFIG_SCRIPT + '$1');
}

function main() {
  console.log('=== 打包网站到 App web/ 目录 ===');
  console.log('源：' + SITE);
  console.log('目标：' + DEST);

  clearDir(DEST);
  FILES.forEach((entry) => {
    copyFile(entry);
    const dstRel = (typeof entry === 'string') ? entry : entry[1];
    console.log('  + ' + dstRel);
  });

  const utilsPath = p('shared/utils.js');
  writeFileSync(utilsPath, patchUtils(readFileSync(utilsPath, 'utf8')));

  ['index.html', 'modules/vocabulary/index.html'].forEach((rel) => {
    const htmlPath = p(rel);
    writeFileSync(htmlPath, patchHtml(readFileSync(htmlPath, 'utf8')));
  });

  /* 校验：离线词库确实随包复制，且已注入基址 */
  ['words/cet6.json', 'words/ielts.json'].forEach((rel) => {
    if (!existsSync(p(rel))) throw new Error('离线词库未打包：' + rel);
    console.log('[pack]  离线词库就绪：' + rel);
  });
  const u = readFileSync(utilsPath, 'utf8');
  if (u.indexOf('APP_API_BASE') === -1) throw new Error('utils.js 注入失败');

  console.log('=== 完成：web/ 已生成，可执行 npx cap add android 生成安卓工程 ===');
}

main();
