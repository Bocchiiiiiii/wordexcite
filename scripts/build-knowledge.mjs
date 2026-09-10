/* ============================================================
 * build-knowledge.mjs — 把离线批量预生成的知识卡合并成 App 内置文件
 *
 * 读取 words/worddatas/ 下所有 batch_*.jsonl（SiliconFlow Batch 输出），
 * 每个 batch 行的 custom_id 为 w<5位索引>（对应 cet6.json 的下标），
 * 从 response.body.choices[0].message.content 提取 JSON，
 * 用与前端 normalizeKnowledge / pregen normalize 一致的口径归一化成 v3 词条，
 * 合并成 { 小写英文: v3词条 } 并写入 words/knowledge-cet6.json。
 *
 * 用法：node scripts/build-knowledge.mjs
 * 可重复执行；覆盖所有能解析且能映射回词库下标的词。
 * ============================================================ */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const WORDS_FILE = join(ROOT, 'words', 'cet6.json');
const DATAS_DIR = join(ROOT, 'words', 'worddatas');
const OUT_FILE = join(ROOT, 'words', 'knowledge-cet6.json');

/* ---------------- 词库（用于 custom_id -> 单词 映射） ---------------- */
function stripBom(s) { return String(s || '').replace(/^\uFEFF/, ''); }

function loadWords() {
  const list = JSON.parse(stripBom(readFileSync(WORDS_FILE, 'utf8')));
  if (!Array.isArray(list)) throw new Error(Words_FILE_ERR('cet6.json 结构异常'));
  return list;
}
const Words_FILE_ERR = (m) => m;

/* ---------------- JSON 容错（与 pregen extract_json 一致） ---------------- */
function extractJson(text) {
  let t = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('AI 返回内容不是 JSON');
  const s = t.slice(start, end + 1);
  try { return JSON.parse(s); }
  catch (e) {
    const fixed = s
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/(")\s*\r?\n(\s*")/g, '$1,\n$2')
      .replace(/([}\]0-9])\s*\r?\n(\s*")/g, '$1,\n$2');
    try { return JSON.parse(fixed); }
    catch (e2) { throw new Error('AI 返回内容不是合法 JSON：' + e2.message); }
  }
}

/* ---------------- 归一化（与 pregen normalize / 前端 normalizeKnowledge 一致） ---------------- */
function normalize(w, raw) {
  const obj = (raw && typeof raw === 'object') ? raw : {};
  const meanings = (Array.isArray(obj.meanings) ? obj.meanings : []).map((m) => {
    if (!m || typeof m !== 'object') {
      return { pos: '', zh: String(m || '').trim(), exampleEn: '', exampleZh: '' };
    }
    const ex = (m.example && typeof m.example === 'object') ? m.example : {};
    return {
      pos: String(m.pos || '').trim(),
      zh: String(m.zh || '').trim(),
      exampleEn: String(m.exampleEn != null ? m.exampleEn : (ex.en || '')).trim(),
      exampleZh: String(m.exampleZh != null ? m.exampleZh : (ex.zh || '')).trim(),
    };
  }).filter((m) => m.pos || m.zh || m.exampleEn || m.exampleZh);

  const phrases = (Array.isArray(obj.phrases) ? obj.phrases : []).map((p) => {
    if (p && typeof p === 'object') {
      return { en: String(p.en != null ? p.en : (p.phrase || '')).trim(), zh: String(p.zh != null ? p.zh : (p.translation || '')).trim() };
    }
    return { en: String(p || '').trim(), zh: '' };
  }).filter((p) => p.en || p.zh).slice(0, 5);

  const variants = (Array.isArray(obj.variants) ? obj.variants : []).map((v) => {
    if (v && typeof v === 'object') {
      return { word: String(v.word != null ? v.word : (v.en || '')).trim(), pos: String(v.pos || '').trim(), zh: String(v.zh || '').trim() };
    }
    return { word: String(v || '').trim(), pos: '', zh: '' };
  }).filter((v) => v.word || v.zh).slice(0, 8);

  const ety = (obj.etymology && typeof obj.etymology === 'object') ? obj.etymology : {};
  const related = (Array.isArray(ety.related) ? ety.related : []).map((r) => {
    if (r && typeof r === 'object') {
      return { word: String(r.word || '').trim(), pos: String(r.pos || '').trim(), zh: String(r.zh || '').trim() };
    }
    return { word: String(r || '').trim(), pos: '', zh: '' };
  }).filter((r) => r.word).slice(0, 6);

  const etymology = {
    root: String(ety.root || '').trim(),
    origin: String(ety.origin || '').trim(),
    prefix: String(ety.prefix || '').trim(),
    suffix: String(ety.suffix || '').trim(),
    tip: String(ety.tip || '').trim(),
    related: related,
  };

  return {
    v: 3,
    en: w.en,
    zh: w.zh,
    phonetic: (w.phonetic || ''),
    meanings: meanings,
    variants: variants,
    phrases: phrases,
    etymology: etymology,
    generatedAt: new Date().toISOString(),
  };
}

/* ---------------- 读取 batch jsonl 并合并 ---------------- */
function loadBatchLines() {
  const files = readdirSync(DATAS_DIR)
    .filter((n) => /^batch_.*\.jsonl$/i.test(n))
    .sort();
  if (!files.length) throw new Error('words/worddatas/ 下没有 batch_*.jsonl 文件');
  const lines = [];
  for (const f of files) {
    const text = stripBom(readFileSync(join(DATAS_DIR, f), 'utf8'));
    text.split(/\r?\n/).forEach((ln) => { if (ln.trim()) lines.push(ln.trim()); });
  }
  return lines;
}

function main() {
  if (!existsSync(DATAS_DIR)) throw new Error('缺少目录 words/worddatas/');
  const words = loadWords();
  const lines = loadBatchLines();

  const merged = {};
  const fail = [];
  let parsed = 0;
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    let rec;
    try { rec = JSON.parse(ln); }
    catch (e) { fail.push({ line: li, why: '行非法 JSON' }); continue; }

    const cid = String(rec.custom_id || '');
    const m = /^w(\d{5})$/.exec(cid);
    if (!m) { fail.push({ line: li, why: 'custom_id 无法识别: ' + cid }); continue; }
    const idx = Number(m[1]);
    if (idx >= words.length) { fail.push({ line: li, why: '序号越界 ' + idx }); continue; }

    const resp = (rec.response && typeof rec.response === 'object') ? rec.response : {};
    const body = (resp.body && typeof resp.body === 'object') ? resp.body : {};
    const choices = (Array.isArray(body.choices) ? body.choices : []);
    const content = choices[0] && choices[0].message ? choices[0].message.content : '';
    if (!content) { fail.push({ line: li, why: '响应缺 choices/message/content: ' + cid }); continue; }

    const w = words[idx];
    try {
      const entry = normalize(w, extractJson(content));
      merged[w.en.toLowerCase()] = entry;
      parsed++;
      if (entry.en !== w.en) console.warn(`[warn] ${cid} en 不一致：${entry.en} vs ${w.en}`);
    } catch (e) {
      fail.push({ line: li, why: `${cid}: ${e.message}` });
    }
  }

  writeFileSync(OUT_FILE, JSON.stringify(merged, null, 0).replace(/,\n/g, ',').replace(/\n/g, ''), 'utf8');
  // 直观可读版本存到同目录（仅审计用，不打进 App）
  writeFileSync(join(DATAS_DIR, 'merged-cache.json'), JSON.stringify(merged, null, 2) + '\n', 'utf8');

  const size = (Buffer.byteLength(JSON.stringify(merged), 'utf8'));
  console.log(`=== 完成 ===`);
  console.log(`词条总数：${Object.keys(merged).length}`);
  console.log(`解析成功：${parsed}，失败：${fail.length}，总行：${lines.length}`);
  console.log(`输出：${OUT_FILE}（约 ${(size / 1024 / 1024).toFixed(2)} MB）`);
  console.log(`审计副本：${join(DATAS_DIR, 'merged-cache.json')}`);
  if (fail.length) {
    console.log(`失败明细（前 20）：`);
    fail.slice(0, 20).forEach((f) => console.log('  ', JSON.stringify(f)));
  }
  if (Object.keys(merged).length !== words.length) {
    console.warn(`[warn] 覆盖 ${Object.keys(merged).length}/${words.length}，未全覆盖——这些词仍会在首次打开时联网生成。`);
  }
}

main();
