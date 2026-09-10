/* ============================================================
 * FSRS 适配层（浏览器 + Node 共用，UMD）
 * - 统一创建 ts-fsrs scheduler：request_retention=0.9、enable_fuzz=true
 * - Card 序列化（due / last_review 存 ISO 字符串，可直接 JSON 落盘）
 * - 旧 SM-2 数据 → FSRS Card 的一次性迁移
 * - memory_state_from_sm2：ts-fsrs 未内置此函数（属于 fsrs-rs 的 API），
 *   此处按 open-spaced-repetition/fsrs-rs 官方实现移植，权重取自
 *   ts-fsrs 的 default_w（与 fsrs-rs 默认 21 权重一致），
 *   固定 sm2_retention = 0.9（官方迁移推荐值）。
 * ============================================================ */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module !== null && typeof module.exports === 'object') {
    module.exports = factory(require('ts-fsrs'));
  } else {
    root.FSRSAdapter = factory(root.FSRS);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (FSRS) {
  'use strict';

  if (!FSRS || typeof FSRS.fsrs !== 'function') {
    throw new Error('FSRSAdapter：ts-fsrs 未加载');
  }

  var Grade = Object.freeze({ AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 });
  var State = Object.freeze({ NEW: 0, LEARNING: 1, REVIEW: 2, RELEARNING: 3 });

  /* 调度参数：readme/update 约定 FSRS-5 默认权重 + 0.9 保留率 + 模糊间隔 */
  var REQUEST_RETENTION = 0.9;
  var MAXIMUM_INTERVAL = 36500;
  var ENABLE_FUZZ = true;
  var SM2_RETENTION = 0.9;   // 官方 memory_state_from_sm2 的迁移用保留率

  var scheduler = FSRS.fsrs({
    request_retention: REQUEST_RETENTION,
    maximum_interval: MAXIMUM_INTERVAL,
    enable_fuzz: ENABLE_FUZZ
  });

  /* ---------------- 基础 ---------------- */

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function toDate(value) {
    if (value instanceof Date) return value;
    if (typeof value === 'number') return new Date(value);
    if (typeof value === 'string' && value) {
      var d = new Date(value);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  function toISO(value) {
    var d = toDate(value);
    return d ? d.toISOString() : null;
  }

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  function int(v, fallback) {
    var n = Math.floor(Number(v));
    return isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  /* SM-2 日期 "YYYY-MM-DD" 解析为本地正午（跨时区序列化更稳） */
  function sm2Date(value) {
    if (value instanceof Date) return value;
    if (typeof value !== 'string' || !value) return null;
    var m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
    return toDate(value);
  }

  function addDaysISO(now, days) {
    var d = toDate(now) || new Date();
    d = new Date(d.getTime() + days * 86400000);
    return d.toISOString();
  }

  /* ---------------- Card 序列化 ---------------- */

  /* scheduler.next 返回的 Card 含 Date 对象；落盘前统一转纯 JSON 对象 */
  function serializeCard(card) {
    var c = card || {};
    return {
      due: toISO(c.due),
      stability: num(c.stability),
      difficulty: num(c.difficulty),
      elapsed_days: num(c.elapsed_days),
      scheduled_days: num(c.scheduled_days),
      learning_steps: int(c.learning_steps),
      reps: Math.max(0, int(c.reps)),
      lapses: Math.max(0, int(c.lapses)),
      state: clamp(int(c.state), 0, 3),
      last_review: c.last_review ? toISO(c.last_review) : null
    };
  }

  /* 校验并规范化已存储的 Card；无效返回 null（调用方决定重建或迁移） */
  function normalizeCard(card) {
    if (!card || typeof card !== 'object') return null;
    if (!toDate(card.due)) return null;
    return serializeCard(card);
  }

  /* 新词第一次评分前用 createEmptyCard 创建（不手动构造 Card） */
  function createEmptyCard(now) {
    return serializeCard(FSRS.createEmptyCard(now || new Date()));
  }

  /* 调度入口：永远走库方法，不复算间隔 */
  function next(cardOrNull, now, grade) {
    var t = toDate(now) || new Date();
    var input = cardOrNull ? normalizeCard(cardOrNull) : null;
    if (cardOrNull && !input) throw new Error('FSRS Card 数据无效');
    var result = scheduler.next(input || FSRS.createEmptyCard(t), t, grade);
    return serializeCard(result.card);
  }

  /* ---------------- memory_state_from_sm2（官方 fsrs-rs 实现移植） ---------------- */

  function memoryStateFromSm2(intervalDays, easeFactor, sm2Retention) {
    var ivl = Math.max(num(intervalDays), 0.001);
    var ease = clamp(num(easeFactor, 2.5), 1.3, 3.0);
    var r = (sm2Retention == null ? SM2_RETENTION : num(sm2Retention));
    if (!(r > 0 && r < 1)) r = SM2_RETENTION;

    var w = FSRS.default_w || [];
    var decay = -(typeof w[20] === 'number' ? w[20] : 0.1542);
    var factor = Math.pow(0.9, 1 / decay) - 1;
    var stability = ivl * factor / (Math.pow(r, 1 / decay) - 1);
    var w8 = typeof w[8] === 'number' ? w[8] : 1.8722;
    var w9 = typeof w[9] === 'number' ? w[9] : 0.1666;
    var w10 = typeof w[10] === 'number' ? w[10] : 0.796;
    var difficulty = 11 - (ease - 1) /
      (Math.exp(w8) * Math.pow(stability, -w9) * (Math.exp((1 - r) * w10) - 1));

    if (!isFinite(stability) || !isFinite(difficulty)) {
      throw new Error('memory_state_from_sm2：无法换算该 SM-2 状态');
    }
    return { stability: stability, difficulty: clamp(difficulty, 1, 10) };
  }

  /* ---------------- 旧数据迁移 ---------------- */

  function legacyRatingToFsrs(q) {
    if (q === 1) return Grade.HARD;    // 旧“不认识” → 现在的下滑 Hard
    if (q === 2) return Grade.AGAIN;   // 旧“记不清” → 现在的点词 Again（+难词池）
    if (q === 4 || q === 5) return Grade.GOOD;   // 旧 4/5 都视为 FSRS Good
    return 0;
  }

  /* 旧 SM-2 单词 → FSRS Card。
     - stability / difficulty 用 memory_state_from_sm2(interval, easiness) 换算；
     - due 沿用 nextReviewDate，last_review 沿用 lastReviewDate；
     - reps / lapses 用 correctCount / wrongCount 近似（换算精度有限，已在文档注明）。 */
  function cardFromSm2(word, now) {
    var interval = clamp(Math.round(num(word.interval, 0)), 1, MAXIMUM_INTERVAL);
    var ease = clamp(num(word.easiness, 2.5), 1.3, 3.0);
    var ms = memoryStateFromSm2(interval, ease, SM2_RETENTION);

    var due = sm2Date(word.nextReviewDate) ||
      new Date((toDate(now) || new Date()).getTime() + interval * 86400000);
    var last = sm2Date(word.lastReviewDate);

    var correct = Math.max(0, int(word.correctCount, 0));
    var wrong = Math.max(0, int(word.wrongCount, 0));

    return {
      due: due.toISOString(),
      stability: ms.stability,
      difficulty: ms.difficulty,
      elapsed_days: 0,
      scheduled_days: interval,
      learning_steps: 0,
      reps: Math.max(1, correct + wrong),
      lapses: wrong,
      state: State.REVIEW,
      last_review: last ? last.toISOString() : null
    };
  }

  function isLegacyStudied(w) {
    return !!(w.lastReviewDate || num(w.correctCount) > 0 || num(w.wrongCount) > 0 || num(w.interval) > 0);
  }

  /* 把任意一条 word 记录规范化为 FSRS 新格式。
     - 已有合法 fsrsCard：原样保留（顺带丢弃遗留 SM-2 字段）；
     - 有 SM-2 历史：一次性换算成 Card；
     - 全新词：fsrsCard = null，等第一次评分时 createEmptyCard。 */
  function migrateWordRecord(raw, now) {
    var w = raw && typeof raw === 'object' ? raw : {};
    var existing = normalizeCard(w.fsrsCard);
    var migrated = false;
    var out = {
      id: (w.id == null ? null : w.id),
      en: String(w.en || ''),
      zh: String(w.zh || ''),
      phonetic: String(w.phonetic || ''),
      lastRating: 0,
      inHardPool: !!w.inHardPool,
      fsrsCard: null
    };

    if (existing) {
      out.lastRating = clamp(int(w.lastRating, 0), 0, 4);
      out.fsrsCard = existing;
    } else if (isLegacyStudied(w)) {
      out.lastRating = legacyRatingToFsrs(w.lastQ);
      out.fsrsCard = cardFromSm2(w, now || new Date());
      migrated = true;
    }
    return { word: out, migrated: migrated };
  }

  function stateName(state) {
    if (state === 0) return '新词';
    if (state === 1) return '学习中';
    if (state === 2) return '复习中';
    if (state === 3) return '重学中';
    return '未知';
  }

  return {
    Grade: Grade,
    State: State,
    REQUEST_RETENTION: REQUEST_RETENTION,
    MAXIMUM_INTERVAL: MAXIMUM_INTERVAL,
    ENABLE_FUZZ: ENABLE_FUZZ,
    SM2_RETENTION: SM2_RETENTION,
    fsrsVersion: FSRS.FSRSVersion || '5.4.1',
    scheduler: scheduler,
    createEmptyCard: createEmptyCard,
    serializeCard: serializeCard,
    normalizeCard: normalizeCard,
    next: next,
    memoryStateFromSm2: memoryStateFromSm2,
    cardFromSm2: cardFromSm2,
    migrateWordRecord: migrateWordRecord,
    stateName: stateName,
    toDate: toDate,
    toISO: toISO,
    addDaysISO: addDaysISO
  };
});
