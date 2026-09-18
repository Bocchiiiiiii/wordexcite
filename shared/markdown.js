/* ============================================================
 * 学能动的不能动 · 极简 Markdown 渲染器（离线可用，无第三方依赖）
 * 用途：单词备注（用户自己写的 Markdown）渲染成知识页里的词条。
 * 设计：先转义 HTML（防注入），再做块级/行内解析；只输出安全标签。
 * 支持：标题 / 段落 / 换行 / 粗体 / 斜体 / 删除线 / 行内代码 / 代码块 /
 *       有序·无序列表（含嵌套、任务清单）/ 引用 / 分割线 / 链接 / 图片 / 表格。
 * 约定：所有对外接口接收「原始文本」，内部自己转义。
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.WXMarkdown = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* 只允许安全协议：http(s) / mailto / 页内锚点 / 相对路径 */
  function safeUrl(url) {
    var u = String(url == null ? '' : url).trim();
    if (!u) return '';
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (/^[/#.]/.test(u)) return u;
    return '';
  }

  /* ---------- 行内（入参：原始文本） ---------- */

  var TOKEN_RE = /\u0000(\d+)\u0000/g;

  function renderInline(raw) {
    var store = [];
    function keep(html) {
      store.push(html);
      return '\u0000' + (store.length - 1) + '\u0000';
    }
    var out = escapeHtml(raw);

    /* 1) 行内代码：最先处理，内部不再解析其它语法 */
    out = out.replace(/`([^`\n]+)`/g, function (m, code) {
      return keep('<code class="md-code">' + code + '</code>');
    });

    /* 2) 图片（离线可能加载不到，加载失败由 CSS 兜底） */
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, function (m, alt, url, title) {
      var safe = safeUrl(url.replace(/&amp;/g, '&'));
      if (!safe) return keep('<span class="md-img-alt">' + alt + '</span>');
      return keep('<img class="md-img" src="' + escapeHtml(safe) + '" alt="' + alt + '"' +
        (title ? ' title="' + title + '"' : '') + ' loading="lazy">');
    });

    /* 3) 链接 */
    out = out.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, function (m, label, url, title) {
      var safe = safeUrl(url.replace(/&amp;/g, '&'));
      if (!safe) return keep(label);
      return keep('<a class="md-link" href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer"' +
        (title ? ' title="' + title + '"' : '') + '>' + label + '</a>');
    });

    /* 4) 强调类（先长后短，避免 ***x*** 被拆错） */
    out = out.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    /* 5) 还原占位（占位里可能还嵌着占位，多跑几轮） */
    for (var pass = 0; pass < 5; pass++) {
      TOKEN_RE.lastIndex = 0;
      if (!TOKEN_RE.test(out)) break;
      TOKEN_RE.lastIndex = 0;
      out = out.replace(TOKEN_RE, function (m, idx) {
        var v = store[Number(idx)];
        return v == null ? '' : v;
      });
    }
    TOKEN_RE.lastIndex = 0;
    return out;
  }

  /* ---------- 块级 ---------- */

  var RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  var RE_HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var RE_QUOTE = /^ {0,3}>\s?(.*)$/;
  var RE_UL = /^(\s*)([-*+])\s+(.*)$/;
  var RE_OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
  var RE_FENCE = /^ {0,3}(```+|~~~+)\s*([\w+#-]*)\s*$/;
  var RE_TABLE_SEP = /^ {0,3}\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function isBlockStart(line) {
    return RE_HEADING.test(line) || RE_HR.test(line) || RE_QUOTE.test(line) ||
      RE_UL.test(line) || RE_OL.test(line) || RE_FENCE.test(line) ||
      (line.indexOf('|') !== -1 && /^ {0,3}\|.*\|/.test(line));
  }

  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(function (c) { return c.trim(); });
  }

  function alignOf(sep) {
    var s = sep.trim();
    var left = s.charAt(0) === ':';
    var right = s.charAt(s.length - 1) === ':';
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  }

  function renderTable(lines, start) {
    var header = splitRow(lines[start]);
    var aligns = splitRow(lines[start + 1]).map(alignOf);
    var i = start + 2;
    var rows = [];
    while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
      rows.push(splitRow(lines[i]));
      i++;
    }
    var html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    header.forEach(function (cell, ci) {
      html += '<th' + (aligns[ci] ? ' style="text-align:' + aligns[ci] + '"' : '') + '>' +
        renderInline(cell) + '</th>';
    });
    html += '</tr></thead><tbody>';
    rows.forEach(function (row) {
      html += '<tr>';
      for (var ci2 = 0; ci2 < header.length; ci2++) {
        html += '<td' + (aligns[ci2] ? ' style="text-align:' + aligns[ci2] + '"' : '') + '>' +
          renderInline(row[ci2] == null ? '' : row[ci2]) + '</td>';
      }
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return { html: html, next: i };
  }

  /* 列表：按缩进递归，支持嵌套 / 任务清单 / 续行 */
  function buildList(lines, start) {
    var items = [];
    var i = start;
    var baseIndent = null;
    var ordered = null;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) {
        var j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && (RE_UL.test(lines[j]) || RE_OL.test(lines[j]))) { i = j; continue; }
        break;
      }
      var mu = RE_UL.exec(line);
      var mo = RE_OL.exec(line);
      if (mu || mo) {
        var indent = (mu ? mu[1] : mo[1]).length;
        if (baseIndent === null) baseIndent = indent;
        if (indent < baseIndent) break;
        if (ordered === null) ordered = !!mo;
        /* 同层混用有序/无序：这里只收一种，剩下的交给外层再起一个列表 */
        if (indent === baseIndent && !!mo !== ordered) break;
        items.push({
          indent: indent,
          ordered: !!mo,
          marker: mu ? mu[2] : mo[2] + '.',
          content: [(mu ? mu[3] : mo[3])]
        });
        i++;
        continue;
      }
      if (items.length && /^\s+\S/.test(line)) {
        items[items.length - 1].content.push(line.trim());
        i++;
        continue;
      }
      break;
    }

    function renderItems(from, indent) {
      var isOrdered = items[from].ordered;
      var body = '';
      var i2 = from;
      while (i2 < items.length) {
        var it = items[i2];
        if (it.indent !== indent || it.ordered !== isOrdered) break;
        var text = it.content.join(' ');
        var task = null;
        var tm = /^\[([ xX])\]\s+([\s\S]*)$/.exec(text);
        if (tm) { task = tm[1].toLowerCase() === 'x'; text = tm[2]; }
        var inner = '';
        var nextIdx = i2 + 1;
        if (nextIdx < items.length && items[nextIdx].indent > indent) {
          var sub = renderItems(nextIdx, items[nextIdx].indent);
          inner = sub.html;
          nextIdx = sub.next;
        }
        body += '<li>' +
          (task === null ? '' : '<span class="md-task' + (task ? ' done' : '') + '">' + (task ? '☑' : '☐') + '</span>') +
          renderInline(text) + inner + '</li>';
        i2 = nextIdx;
      }
      var tag = isOrdered ? 'ol' : 'ul';
      return { html: '<' + tag + ' class="md-list">' + body + '</' + tag + '>', next: i2 };
    }

    var res = renderItems(0, items.length ? items[0].indent : 0);
    return { html: res.html, next: i };
  }

  function render(src) {
    var text = String(src == null ? '' : src).replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
    var lines = text.split('\n');
    var out = '';
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) { i++; continue; }

      /* 代码块 */
      var mf = RE_FENCE.exec(line);
      if (mf) {
        var fence = mf[1].charAt(0);
        var lang = mf[2] || '';
        var buf = [];
        i++;
        while (i < lines.length) {
          var mc = RE_FENCE.exec(lines[i]);
          if (mc && mc[1].charAt(0) === fence) { i++; break; }
          buf.push(lines[i]);
          i++;
        }
        out += '<pre class="md-pre"' + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : '') +
          '><code>' + escapeHtml(buf.join('\n')) + '</code></pre>';
        continue;
      }

      /* 标题 */
      var mh = RE_HEADING.exec(line);
      if (mh) {
        var lvl = mh[1].length;
        out += '<h' + lvl + ' class="md-h md-h' + lvl + '">' + renderInline(mh[2]) + '</h' + lvl + '>';
        i++;
        continue;
      }

      /* 分割线 */
      if (RE_HR.test(line)) { out += '<hr class="md-hr">'; i++; continue; }

      /* 引用（连续行合并，内部再递归解析） */
      if (RE_QUOTE.test(line)) {
        var qbuf = [];
        while (i < lines.length && RE_QUOTE.test(lines[i])) {
          qbuf.push(RE_QUOTE.exec(lines[i])[1]);
          i++;
        }
        out += '<blockquote class="md-quote">' + render(qbuf.join('\n')) + '</blockquote>';
        continue;
      }

      /* 表格 */
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
        var tb = renderTable(lines, i);
        out += tb.html;
        i = tb.next;
        continue;
      }

      /* 列表 */
      if (RE_UL.test(line) || RE_OL.test(line)) {
        var lb = buildList(lines, i);
        out += lb.html;
        i = lb.next;
        continue;
      }

      /* 段落：连续普通行合并，单个换行保留为 <br> */
      var pbuf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        pbuf.push(lines[i]);
        i++;
      }
      out += '<p class="md-p">' + pbuf.map(function (l) { return renderInline(l.trim()); }).join('<br>') + '</p>';
    }

    return out;
  }

  /* 纯文本摘要（列表预览等只需要一行文字的地方） */
  function toPlain(src) {
    return String(src == null ? '' : src)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[#>*_`~|-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return { render: render, renderInline: renderInline, toPlain: toPlain, escapeHtml: escapeHtml };
});
