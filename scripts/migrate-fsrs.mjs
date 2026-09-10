/* ============================================================
 * 一次性迁移脚本：SM-2 数据 → FSRS 格式（v1.12.0）
 *
 * 用法：
 *   node scripts/migrate-fsrs.mjs <输入.json> [输出.json] [--force]
 *
 * 输入支持两种：
 *   1. 纯学习数据：{ words:[{...SM-2 字段}], ... }
 *   2. 应用导出的备份包：{ study:{...}, knowledge:{...} }
 *
 * 行为：
 *   - 每条有 SM-2 历史的单词，用 memory_state_from_sm2(interval, ease)
 *     换算 stability/difficulty，生成 fsrsCard；SM-2 字段删除。
 *   - 已是 FSRS 格式时默认不写文件（幂等，跑过就不要再跑）。
 *   - revision +1，保证迁移结果在客户端/服务器同步中胜出。
 * ============================================================ */
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const FSRSAdapter = require('../shared/fsrs-adapter.js');

function fail(msg) {
  console.error('[migrate-fsrs] ' + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2).filter(Boolean);
  let force = false;
  const paths = [];
  for (const a of args) {
    if (a === '--force') force = true;
    else paths.push(a);
  }
  return { input: paths[0] || null, output: paths[1] || null, force };
}

const { input, output, force } = parseArgs(process.argv);
if (!input) fail('缺少输入文件。用法：node scripts/migrate-fsrs.mjs <输入.json> [输出.json] [--force]');

const resolvedInput = path.resolve(input);
const resolvedOutput = path.resolve(output || input.replace(/\.json$/i, '') + '.fsrs-migrated.json');
if (resolvedOutput === resolvedInput) {
  fail('输出文件不能覆盖输入文件；请指定另一个输出路径。');
}

let raw;
try {
  raw = JSON.parse(await readFile(resolvedInput, 'utf8'));
} catch (err) {
  fail('读取输入文件失败：' + (err && err.message ? err.message : err));
}

/* 支持纯 study 数据或应用备份包 {study, knowledge} */
let study = raw;
let knowledge = null;
let wrapper = false;
if (raw && typeof raw === 'object' && raw.study && typeof raw.study === 'object') {
  study = raw.study;
  knowledge = raw.knowledge && typeof raw.knowledge === 'object' ? raw.knowledge : null;
  wrapper = true;
}
if (!study || typeof study !== 'object' || !Array.isArray(study.words)) {
  fail('输入里没有 words 数组（既不是学习数据，也不是备份包）。');
}

const now = new Date();
let migrated = 0;
let alreadyFsrs = 0;
let fresh = 0;
const outWords = [];

for (const rawWord of study.words) {
  if (!rawWord || typeof rawWord !== 'object') continue;
  const res = FSRSAdapter.migrateWordRecord(rawWord, now);
  outWords.push(res.word);
  if (res.migrated) migrated++;
  else if (res.word.fsrsCard) alreadyFsrs++;
  else fresh++;
}

if (migrated === 0 && !force) {
  console.log('[migrate-fsrs] 输入数据已是 FSRS 格式（卡片 ' + alreadyFsrs + ' 条，新词 ' + fresh + ' 条），无需迁移，未写任何文件。');
  console.log('[migrate-fsrs] 如确需重写一份规范化副本，加 --force。');
  process.exit(0);
}

const migratedStudy = {
  ...study,
  version: 2,
  algorithm: 'fsrs',
  words: outWords,
  learnedIds: Array.isArray(study.learnedIds) ? study.learnedIds : [],
  revision: Math.max(0, Number(study.revision) || 0) + 1
};
/* 已掌握索引按新口径重建：state=复习中(2) 即已掌握 */
migratedStudy.learnedIds = outWords
  .filter((w) => w.fsrsCard && w.fsrsCard.state === 2)
  .map((w) => w.id);

const outputData = wrapper
  ? { ...raw, study: migratedStudy, knowledge }
  : migratedStudy;

await writeFile(resolvedOutput, JSON.stringify(outputData, null, 2), 'utf8');

console.log('[migrate-fsrs] 迁移完成：');
console.log('  输入：' + resolvedInput);
console.log('  输出：' + resolvedOutput);
console.log('  迁移 SM-2 → FSRS：' + migrated + ' 条');
console.log('  已是 FSRS：' + alreadyFsrs + ' 条');
console.log('  未学习新词：' + fresh + ' 条');
console.log('  换算公式：memory_state_from_sm2(interval, ease)，sm2_retention=0.9');
console.log('  修订号已 +1：' + (Number(study.revision) || 0) + ' → ' + migratedStudy.revision);
