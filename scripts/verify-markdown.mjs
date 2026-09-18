/* verify-markdown.mjs — 单词备注 Markdown 渲染器回归测试（v1.27.0）
 * shared/markdown.js 是纯函数、无外部依赖：这里用 node:vm 直接在假 window 上跑，
 * 断言渲染结果 + 防注入（XSS）行为。UI 层（编辑/预览/缓存）见 verify-note.mjs。
 */
import fs from 'node:fs';
import vm from 'node:vm';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
}
function has(name, html, needle) {
  record(name, html.indexOf(needle) !== -1, needle.slice(0, 60));
}
function hasNot(name, html, needle) {
  record(name, html.indexOf(needle) === -1, '不应出现：' + needle.slice(0, 60));
}

const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('shared/markdown.js', 'utf8'), sandbox, { filename: 'shared/markdown.js' });
const MD = sandbox.WXMarkdown || (sandbox.window && sandbox.window.WXMarkdown);
if (!MD || typeof MD.render !== 'function') { console.error('WXMarkdown 未挂载'); process.exit(1); }

/* ---------- 1. 行内语法 ---------- */
let h = MD.render('**粗** *斜* ~~删~~ `code` ***都***');
has('粗体', h, '<strong>粗</strong>');
has('斜体', h, '<em>斜</em>');
has('删除线', h, '<del>删</del>');
has('行内代码', h, '<code class="md-code">code</code>');
has('粗斜体', h, '<strong><em>都</em></strong>');
record('段落包裹', h.indexOf('<p class="md-p">') === 0, h.slice(0, 30));

/* ---------- 2. 标题 / 分割线 ---------- */
h = MD.render('# 一级\n## 二级\n### 三级');
has('h1', h, '<h1 class="md-h md-h1">一级</h1>');
has('h2', h, '<h2 class="md-h md-h2">二级</h2>');
has('h3', h, '<h3 class="md-h md-h3">三级</h3>');
h = MD.render('a\n\n---\n\nb');
has('分割线', h, '<hr class="md-hr">');

/* ---------- 3. 列表：无序 / 有序 / 嵌套 / 任务 ---------- */
h = MD.render('- 一\n- 二');
has('无序列表', h, '<ul class="md-list"><li>一</li><li>二</li></ul>');
hasNot('无序列表不误用 ol', h, '<ol');
h = MD.render('1. 第一\n2. 第二');
has('有序列表', h, '<ol class="md-list"><li>第一</li><li>第二</li></ol>');
h = MD.render('- 父\n  - 子A\n  - 子B\n- 父二');
has('嵌套列表', h, '<li>父<ul class="md-list"><li>子A</li><li>子B</li></ul></li><li>父二</li>');
h = MD.render('- [ ] 未完成\n- [x] 已完成');
has('任务未完成', h, '<span class="md-task">☐</span>未完成');
has('任务已完成', h, '<span class="md-task done">☑</span>已完成');

/* ---------- 4. 引用 / 代码块 ---------- */
h = MD.render('> 引用一\n> 引用二');
has('引用块', h, '<blockquote class="md-quote"><p class="md-p">引用一<br>引用二</p></blockquote>');
h = MD.render('```js\nconst a = 1 < 2;\n```');
has('代码块', h, '<pre class="md-pre" data-lang="js"><code>');
has('代码块内容已转义', h, 'const a = 1 &lt; 2;');
hasNot('代码块内不解析粗体', MD.render('```\n**x**\n```'), '<strong>');

/* ---------- 5. 链接 / 图片 / 表格 ---------- */
h = MD.render('[站点](https://example.com/a?b=1&c=2)');
has('链接', h, '<a class="md-link" href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">站点</a>');
h = MD.render('[点我](javascript:alert(1))');
hasNot('javascript: 链接被剥离', h, 'href=');
has('危险链接保留文字', h, '点我');
h = MD.render('![图](https://example.com/a.png)');
has('图片', h, '<img class="md-img" src="https://example.com/a.png" alt="图"');
h = MD.render('| 词 | 释义 |\n| --- | ---: |\n| abide | 忍受 |');
has('表格表头', h, '<th>词</th><th style="text-align:right">释义</th>');
has('表格内容', h, '<td>abide</td><td style="text-align:right">忍受</td>');

/* ---------- 6. 段落与换行 ---------- */
h = MD.render('第一行\n第二行\n\n新段落');
has('段内换行保留', h, '<p class="md-p">第一行<br>第二行</p>');
has('空行分段', h, '<p class="md-p">新段落</p>');

/* ---------- 7. 防注入（备注是用户输入，必须转义） ---------- */
h = MD.render('<script>alert(1)</script>');
hasNot('script 被转义', h, '<script>');
has('script 文本保留', h, '&lt;script&gt;alert(1)&lt;/script&gt;');
h = MD.render('<img src=x onerror=alert(1)>');
hasNot('裸 img 标签被转义', h, '<img src=x');
has('onerror 只剩文本', h, '&lt;img src=x onerror=alert(1)&gt;');
h = MD.render('**<b>x</b>**');
hasNot('粗体里的裸标签被转义', h, '<b>x</b>');
h = MD.render('[x](https://a.com" onmouseover="alert(1))');
hasNot('链接属性注入被转义', h, 'onmouseover="alert');

/* ---------- 8. 空输入 / 纯文本摘要 ---------- */
record('空输入返回空串', MD.render('') === '' && MD.render(null) === '' && MD.render(undefined) === '');
record('toPlain 去标记', MD.toPlain('# 标题\n- **粗** `码`') === '标题 粗 码', MD.toPlain('# 标题\n- **粗** `码`'));

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' PASS');
if (failed.length) { console.error('FAILED: ' + failed.map((f) => f.name).join(', ')); process.exit(1); }
