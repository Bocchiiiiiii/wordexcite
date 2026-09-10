// 预计算音素：把 knowledge-cet6.json 里的 单词/例句/短语 全部音素化成 piper 音素名序列。
// 产物：mobile-app/android/app/src/main/assets/tts/phonemes.json
//   { "<text>": ["ɐ","b","ˈ",...] , ... }
// 音素名与模型无关（美/英两模型 phoneme_id_map 一致），App 运行时各自映射成 id。
//
// 采用「输入/输出文件重定向」保证子进程 stdin 到 EOF，并带硬 timeout，避免挂死。
// 依赖：scripts/tts/host/ 构建出的 tts_phonemize.exe（见 host/ 说明）。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PHONEMIZER =
  process.env.PHONEMIZER || 'D:/tmp/piper-host/host-build/tts_phonemize.exe';
const ESPEAK_DATA =
  process.env.ESPEAK_DATA || 'D:/tmp/piper-host/ei/share/espeak-ng-data';
const ESLIB_BIN = process.env.ESLIB_BIN || 'D:/tmp/piper-host/ei/bin';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 600000);

const KNOWLEDGE = 'D:/Coding/Enexcite/words/knowledge-cet6.json';
const OUT_DIR = 'D:/Coding/Enexcite/mobile-app/android/app/src/main/assets/tts';
const OUT_FILE = join(OUT_DIR, 'phonemes.json');
const WORK = process.env.TTS_WORK || 'D:/tmp/piper-host';
const IN_FILE = join(WORK, 'phonemes-in.jsonl');
const RES_FILE = join(WORK, 'phonemes-out.jsonl');

const knowledge = JSON.parse(readFileSync(KNOWLEDGE, 'utf8'));

function normalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

const texts = [];
const seen = new Set();
function add(text) {
  const t = normalize(text);
  if (!t || seen.has(t)) return;
  seen.add(t);
  texts.push(t);
}
for (const key of Object.keys(knowledge)) {
  const e = knowledge[key];
  if (!e) continue;
  if (e.en) add(e.en);
  if (Array.isArray(e.meanings))
    for (const m of e.meanings) if (m && m.exampleEn) add(m.exampleEn);
  if (Array.isArray(e.phrases))
    for (const p of e.phrases) if (p && p.en) add(p.en);
}
console.log(
  `collect ${texts.length} unique texts from ${Object.keys(knowledge).length} words`
);

// 写输入（JSONL）
mkdirSync(WORK, { recursive: true });
writeFileSync(
  IN_FILE,
  texts.map((t) => JSON.stringify({ text: t })).join('\n') + '\n'
);
if (existsSync(RES_FILE)) writeFileSync(RES_FILE, '');

// 运行（文件重定向 + timeout）
const env = { ...process.env, PATH: `${ESLIB_BIN};${process.env.PATH || ''}` };
const r = spawnSync(
  process.env.SHELL_MODE === 'cmd' ? 'cmd.exe' : 'sh',
  process.env.SHELL_MODE === 'cmd'
    ? [
        '/c',
        `"${PHONEMIZER}" --espeak_data "${ESPEAK_DATA}" --language en-us < "${IN_FILE}" > "${RES_FILE}"`,
      ]
    : [
        '-c',
        `"${PHONEMIZER}" --espeak_data "${ESPEAK_DATA}" --language en-us < "${IN_FILE}" > "${RES_FILE}"`,
      ],
  { env, timeout: TIMEOUT_MS, encoding: 'utf8' }
);
if (r.error) {
  console.error('phonemizer error:', r.error.message);
  process.exit(1);
}
if (r.status !== 0) {
  console.error('phonemizer exit', r.status);
  console.error((r.stderr || '').slice(0, 2000));
  process.exit(1);
}

// 解析输出
const raw = readFileSync(RES_FILE, 'utf8');
const lines = raw.split('\n').filter(Boolean);
const map = {};
let failed = 0;
for (const line of lines) {
  try {
    const o = JSON.parse(line);
    map[o.text] = o.phonemes || [];
    if (o.error) failed++;
  } catch {
    /* skip malformed */
  }
}
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(map));
console.log(
  `wrote ${OUT_FILE} entries=${Object.keys(map).length} input=${texts.length} errors=${failed}`
);
