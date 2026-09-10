# Enexcite · wordexcite 学习小站（六级 / 雅思背单词）

> **交接版本：v1.00（2026-09）· 交接 README**
> 本文件是交给下一任开发者 / AI 的**完整交接手册**。读完可直接接手开发、维护、打包、上线 APK。
> 项目已彻底**本地化**：**PWA 网页 + 原生安卓 App**，断网也能背单词，不依赖任何后端服务器。

---

## 0. 一页速览

- **产品**：个人背单词工具。六级 5407 词 + 雅思 8364 词，FSRS 间隔重复 + AI 生成知识卡（释义/变形/例句/短语/词根词缀）+ 听写复习 + 追问 AI。
- **两种形态**：
  1. **PWA 网页**（`index.html` + `modules/vocabulary/`），`sw.js` 离线预缓存，可安装到主屏；
  2. **原生安卓 App**（`mobile-app/`，Capacitor 6），内置全部网页资源与离线词库，可装 APK。
- **核心保证**：完全离线可用。`SERVER_BASE=''` → App/网页**不连任何外部服务器**。学习进度存手机本地（localStorage + IndexedDB），词库内置，发音走本地系统 TTS。
- **版本基线**：本项目"完全本地化"里程碑定为 **v1.00**（即本交接版本）。⚠️ 代码内缓存参数仍沿用旧 web 版本号 `?v=1.18.3` / `sw.js CACHE=wxs-v1.18.3`（历史遗留），后续发版建议统一提升，见 §15。

### 仓库与分支

- 仓库：`https://github.com/Bocchiiiiiii/wordexcite.git`（私有，`origin`）。
- 本地工作副本：`D:\Coding\Enexcite`（新家）；`D:\Coding\webstudy`（旧副本，保留）。
- 当前分支：`codex/arknights-ui-v1.17.0`；最近提交 `96bf96c`（v1.18.3 清理提交）。
- ⚠️ `git push` 依赖网络（当前环境到 github.com 常不可达）；推送命令见 §13。

---

## 1. 交接红线（先读，违反任何一条都可能出事故）

1. **数据红线（最重要）**：学习进度为**本地私有数据**，不要误删用户进度。
   - 学习数据在 `localStorage.cet6study.v1`（或 `.用户名`）；知识缓存走 **IndexedDB**（`wordexcite-db` / store `knowledge`）。
   - 清空 / 重置功能（`clearAllStorage`）会**同时清空本地 + 尝试清服务器**——只应经 UI 被用户主动触发，测试时切勿直接调用。
2. **Git 红线**：**未经用户明确要求不要 `git push`**。历史教训：曾有自动化测试把 5407 词全零进度写进服务器、真实进度丢失（已弃用服务器，但"谨慎写"的纪律保留）。提交可以，推送到远程必须用户点头。
3. **本地优先红线**：不要随意把 `SERVER_BASE` 改回指向服务器——当前是**完全离线优先**设计。网页与 App 都不依赖后端；若改动需先确认用户意图。
4. **模型红线**：AI 调用完全由用户自定义（URL / Key / 模型名），App 不再内置任何 baseurl/key（v1.19.0）。`getAIConfig()` 统一解析，兼容所有 OpenAI 兼容接口。
5. **产品红线**：无 emoji、无卡片 UI、学习页只显示单词 + 音标、纯文字反馈、移动优先、极简。用户是唯一使用者；**不要自作主张加鉴权令牌**（用户明确拒绝）。
6. **架构红线**：前端纯静态（原生 HTML/CSS/JS，无构建框架）。`node_modules` 只用于开发/测试/一次性脚本，**不进部署产物**。线上/App 只包含 `index.html`、`modules/`、`shared/`、`words/`、`icons/` 等静态文件。
7. **版本纪律**：改前端 JS/CSS/HTML 必须同步升 `?v=x.y.z`（HTML 引用处）；若涉 PWA 还要同步升 `sw.js` 的 `CACHE` 名；同时更新 `update.md`。不要只改代码不升版本。
8. **`1.md` 是用户亲手改名的存档需求文档**，勿删除、勿改名。

---

## 2. 目录结构（完整地图，当前真实状态）

```text
D:\Coding\Enexcite\            （本仓库根）
├── 1.md                       # 最初完整需求文档（用户存档，勿动）
├── readme.md                  # 本交接手册（v1.00）
├── update.md                  # 逐版本变更日志 + 数据结构 + 交互规则（权威细节）
├── index.html                 # 首页仪表盘（含内联 JS：同步、主题、设置、AI 配置）
├── manifest.webmanifest       # PWA 安装清单
├── sw.js                      # Service Worker（离线缓存；发版须升 CACHE 名）
├── start.webp                 # 启动动图（1080×1920 动画，App 启动页 + PWA）
├── icons/
│   ├── icon-192.png / icon-512.png / icon-512-maskable.png / icon-32.png / favicon.ico
│   └── picture/fg-icon512.png, fg-icon512-maskable.png   # 图标源图
├── words/
│   ├── cet6.json              # 5407 词（en / phonetic / zh）— 用户"cet6"
│   └── ielts.json             # 8364 词 — 用户"ielts"
├── shared/
│   ├── global.css             # 全局样式、主题变量、通用组件
│   ├── arknights.css          # 明日方舟风格全局覆盖
│   ├── utils.js               # 通用工具：存储 / 词库 / 统计 / 主题 / 知识缓存(IndexedDB)
│   ├── fsrs-adapter.js        # FSRS 适配层：调度 + Card 序列化 + SM-2 迁移
│   └── vendor/ts-fsrs-5.4.1.js   # ts-fsrs UMD 本地打包（含 MIT LICENSE 头）
├── modules/vocabulary/
│   ├── index.html             # 学习概览 + 学习页 + 知识页 + 各弹窗骨架
│   ├── style.css / arknights.css
│   └── script.js              # 背单词模块全部逻辑（约 2400 行）
├── backups/
│   ├── study-backup-2026-08-16.json    # 旧 SM-2 数据快照（恢复用）
│   └── 六级背单词备份-2026-08-19.json   # 数据备份
├── package.json               # 仅开发用：ts-fsrs + playwright-core（AI 的 Key 不在此）
├── package-lock.json
├── .gitignore                 # 忽略 node_modules / *.apk / web/ 构建产物 / __pycache__ 等
├── scripts/                   # 本机开发脚本（已清理：无服务器/部署脚本）
│   ├── copy-fsrs-vendor.ps1          # 重新生成 shared/vendor 打包
│   ├── migrate-fsrs.mjs              # 一次性迁移：SM-2 JSON → FSRS
│   ├── gen-icons.ps1 / gen-favicon.ps1 / resize-icon.ps1   # 图标生成
│   └── pregen-knowledge-batch.py     # 批量预生成知识缓存（离线）
└── mobile-app/                # 原生安卓 App（Capacitor 6）——详见其 README
    ├── package.json           # Capacitor 依赖 + 构建脚本
    ├── capacitor.config.json  # appId/appName/webDir/androidScheme
    ├── README.md              # 安卓 App 的构建 / 打包说明（权威）
    ├── scripts/
    │   ├── pack-web.mjs       # 复制主站到 web/ + 注入 APP_API_BASE（离线优先）
    │   ├── serve.mjs          # 本地预览服务器
    │   ├── verify-idb.mjs     # IndexedDB 持久化验证
    │   ├── verify-offline.mjs # 离线词库验证
    │   └── verify-tts.mjs     # TTS 验证（针对旧 WASM 路径，语音重做前可作参考）
    └── android/               # 已生成的原生工程（Capacitor 6，SDK 34，JDK 17）
```

已删除（v1.18.3 清理提交，勿恢复）：`server.py`、`scripts/deploy.py`、`scripts/piper-tts-server.py`、
`scripts/test-server.mjs`、`scripts/e2e-fsrs.mjs`、`scripts/verify-pwa.mjs`（后三者依赖已删的本地 mock 服务器）。
开发/调试工具目录 `dsh-routing-suite`、`.mimocode`、`.claude` 已移出仓库到 `D:\Coding\_webstudy-tools\`。

---

## 3. 环境与依赖

| 工具 | 版本/位置 | 用途 |
|---|---|---|
| Node.js | ≥18（本机 v24） | 跑开发/打包脚本 |
| npm | 随 Node | 安装依赖 |
| ts-fsrs | 5.4.1（`node_modules` + `shared/vendor` 本地打包） | FSRS 调度 |
| playwright-core | 1.62.1（web 端到端测试，可选） | 测试 |
| JDK | 17（Temurin） | Capacitor 6 安卓编译（Gradle wrapper 8.2.1 需 JDK17，不支持 JDK25） |
| Android SDK | platform 34 + build-tools（如 `D:\tools\android-sdk`） | 编译 APK |
| Capacitor | core / android / cli 6.1.2 | 安卓打包 |
| @capacitor-community/text-to-speech | 5.1.0 | 系统 TTS |

> 命令行构建需先有 JDK17 + Android SDK；本仓库把 APK 视为**构建产物**（`.gitignore` 排除），
> 不在版本库里存二进制。构建方法见 `mobile-app/README.md` 与本节 §7。

---

## 4. 数据模型（改动数据前必读）

### 4.1 存储位置总览

| 数据 | 存储 | Key / 库 |
|---|---|---|
| 学习进度（study） | localStorage | `cet6study.v1`（"cet6"）；其他用户 `cet6study.v1.<用户名>` |
| 当前用户 | localStorage | `currentUser` |
| AI 知识缓存 | **IndexedDB** | 库 `wordexcite-db`、store `knowledge`（按 key 隔离，无 5MB 上限） |
| 词库 | 只读内置 JSON | `words/cet6.json` / `words/ielts.json` |
| 主题 / 口音 / AI 配置 | 内嵌于 study 数据 | 字段见下 |

> 用户隔离规则（`shared/utils.js` 的 `getUserStorageKey`）：用户为空或 **"cet6"** 沿用 base key（零迁移）；
> 其他用户（目前 "ielts"）在 base key 后加 `.用户名` 后缀。
> `utils.js` 的 `USERS=['cet6','ielts']`，`wordBankFile()` 让"ielts"→`ielts.json`，其余→`cet6.json`。

### 4.2 主学习数据 schema（v2）

```javascript
{
  version: 2, algorithm: "fsrs",
  words: [ { id, en, zh, phonetic, lastRating, inHardPool, fsrsCard } ], // fsrsCard 见 §4.4
  learnedIds: [],            // 派生索引：fsrsCard.state===2 的词
  wrongIds: [],              // 今日错词 id
  dailyGoal: 30, newRatio: 0.7,
  sessionDate, consecutiveDays, dailyHistory: {"YYYY-MM-DD": n},
  goalRemindedDate,
  revision: N,               // 修订号：每次保存 +1（防覆盖/自愈）
  apiKey, aiUrl, aiModel,    // AI 配置（v1.19.0 起全部由用户填写，留空 AI 不可用）
  theme: "warm"|"cool"|"solid", accent: "us"|"gb", wordBank: "cet6.json",
  user: "cet6"|"ielts"             // v1.21.0 起内部只作词库标识（界面显示 CET6 / IELTS-8000）
}
```

- `saveData(data)`：写 localStorage，`revision+1`，再 `queuePush`（本地 App 下 push 到 `/api/state` 会失败并**自动忽略**，无害）。
- `normalizeStudyData`：容错补齐 + 迁移 SM-2 卡片为 FSRS。

### 4.3 AI 知识缓存 schema

IndexedDB store `knowledge`，key = 单词（小写）。词条：

```javascript
{
  v: 3, en, zh, phonetic,
  meanings:   [{ pos, zh, exampleEn, exampleZh }],
  variants:   [{ word, pos, zh }],
  phrases:    [{ en, zh }],
  etymology:  { root, origin, prefix, suffix, tip, related: [{word,pos,zh}] },
  generatedAt
}
```

- 内存层 `_knowledgeCache` 读写 + `requestIdleCallback` 异步增量落库（避免阻塞主线程）。
- 首次启动自动把旧 localStorage 缓存迁移进 IndexedDB（`migrateKnowledgeFromLocalStorage`）。
- 已生成（v2/v3 且有 etymology）的词不再自动重生成，只有手动"刷新"才强制；缺 etymology 自动补。

### 4.4 FSRS（`shared/fsrs-adapter.js` + `shared/vendor/ts-fsrs-5.4.1.js`）

- scheduler 固定参数：`request_retention=0.9`、`maximum_interval=36500`、`enable_fuzz=true`。
- 卡片 `fsrsCard` 字段（ts-fsrs Card）：`due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review`。新词 `fsrsCard===null`，首次评分 `createEmptyCard()`。
- **Card.state 语义（应用口径）**：

| state | 含义 | 口径 |
|---|---|---|
| 0 | New 新词 | 待学习 |
| 1 | Learning 学习步骤（1m/10m） | 未掌握 |
| 2 | Review 复习中 | **"已掌握"（`isMasteredWord`）** |
| 3 | Relearning 重学中（Review 后 Again） | 未掌握 |

- **评分映射（用户操作 → FSRS Rating）**：

| 操作 | Rating | 副作用 |
|---|---|---|
| 手指上滑 = 记得 | Good(3) | 难词池移出；连对 +1；移出错词表 |
| 手指下滑 = 再练练 | Hard(2) | 不进难词池；连对清零；进当日错词表 |
| 点击单词 = 记不清 | Again(1) | 进难词池；连对清零；进当日错词表 |
| 知识页顶部再上滑（仅刚标 Good 时） | Good→Again(1) | 等价"记不清" |

- 业务调用（`applyRating`）：`w.fsrsCard = FSRSAdapter.next(card, now, rating)`；`rating===AGAIN→inHardPool=true`；`rating>=GOOD→inHardPool=false`；`syncDerived` 重建 `learnedIds`；错词表/连对/streak/日期随之更新。

### 4.5 选词逻辑（`selectSessionWords`）

1. `now`；到期 = `new Date(card.due) <= now`。
2. 今日错词（`wrongIds`）当天"再背一组"时优先重现。
3. 到期池排序：`lastRating 1/2` 的错词优先，其余按 due 从早到晚。
4. 难词池 = `inHardPool===true` 且不在到期池；新词池 = `fsrsCard===null`。
5. 配额：`baseReview=round(goal×(1-newRatio))`；复习名额=`min(goal,max(baseReview, 到期错词数))`，余下给新词。
6. 顺序：今日错词 → 到期 → 难词 → 新词；新词/难词先全池洗牌。
7. 最终整表再洗牌一次。

---

## 5. 页面与交互

- **首页仪表盘** `index.html`：进度 `/目标`、今日按钮、主题弹窗、设置（主题/口音/AI 配置/切换用户）、关于。
- **学习概览**（`modules/vocabulary/index.html`）：
  - 四张统计卡：已掌握/总词数、待学习、待复习、预计完成天数；
  - 近 7 天 Canvas 柱状图（`dailyHistory`）；
  - 设置：每日目标、新词/复习比例、主题、AI 模型、导入 txt、导出/恢复备份、口音、切换用户、重置进度、清空全部；
  - 「开始学习」（目标已达成且当天未提醒 → 先确认）、「听写复习」。
- **学习页**：单词+音标居中；**手势方向**（整页可滑，阈值 50px）：上滑=记得、下滑=再练练、点击=记不清；每词自动朗读；顶栏 `✕` 退出、返回上一词、刷新（知识页打开时）、连对 N；「返回上一词」从 `appliedStack` 恢复评分快照（可连续回退）。
- **知识页**：单词+音标 → 中文释义 → 单词变形 → 例句 → 短语 → 词根词缀 → 追问 AI（SSE 流式，会话内按词隔离上下文）。**方向术语与页面方向相反**：页面顶端+再上滑（若刚标 Good 先改记不清）→ 下一词；页面底端+再下滑 → 下一词；中间只滚动。下一词动画与淡出并行。
- **听写复习**：到期词+难词池随机打乱 → TTS 朗读 → 拼写输入 → 回车判分（一次拼对且未用提示 = Good，否则 Again）；例句提示优先缓存、无则 AI；答对或看答案后进知识页再下滑进入下一个。
- **添加难词**：列表右上 `+` → 输入单词 → AI 校验拼写 → 词库有则进难词池，无则新增到词库+难词池。

---

## 6. AI 与语音

### 6.1 AI（`modules/vocabulary/script.js`）

- `getAIConfig()`：取 `S.data.aiUrl / aiModel / apiKey`。**v1.19.0 起 App 不再内置任何 URL/Key/模型**，全部由用户在设置里填写；三项有空缺时 `requireAIConfig()` 抛“请先在设置中填写 AI 的 URL、API Key 与模型名称”。
- URL 不以 `/chat/completions` 结尾自动补全；兼容所有 OpenAI 接口（硅基流动/智谱/DeepSeek…）。
- **模型列表获取**（v1.22.0）：`Utils.fetchAIModels(aiUrl, apiKey)` / `Utils.aiModelsEndpoint(url)`（`shared/utils.js`）—— 端点规范化后 `GET {base}/models`（带上 `Authorization: Bearer <key>`、`cache:'no-store'`、20s 超时），解析 `{data:[{id}]}` / `{models:[...]}` / 纯数组三种返回，去重排序后 resolve 模型名数组；失败抛可读原因（401/403 Key 无效、404 接口不存在、非 JSON、超时、空列表）。设置界面（首页 + 模块页）据此渲染可滚动列表，**点条目即选用，输入框仍可手输**。注意：该请求跨域（真实服务商域名），`sw.js` 只缓存同源 GET，不会拦截；若把 Base URL 指到本站同源路径则会让 SW 命中缓存（正常用法不会发生）。
- **追问 AI 人设**（v1.19.0）：`S.data.aiPersona`（未设置用 `Utils.DEFAULT_AI_PERSONA`），两个预设（可爱猫娘 / 暴躁老哥）由 `Utils.personaPreset()` 提供，人设只作用于追问问答语气、不影响知识卡生成。
- **知识卡生成**：非流式，`response_format:{type:"json_object"}`, `temperature:0.2`, `max_tokens:1600`；JSON 容错（去代码块/尾逗号/漏逗号，缺字段补一次）。
- **追问 AI**：SSE 流式，`max_tokens:800`，system prompt 带当前词上下文。
- **推理模型兼容**（v1.23.0）：DeepSeek V4 等推理模型流式先吐 `delta.reasoning_content`（思考）再吐 `delta.content`；`callGLMStream`/`streamOnce` **两路 delta 都解析**并记录 `finish_reason`，思考阶段 UI 显示「思考中…」。因为**思考同样占用 `max_tokens`**（预算小 ⇒ `finish_reason=length` 且正文为空，实测 260 必空、800 时好时坏），首次请求预算下限 2000，收完流仍无正文则 **×3 加码重试一次**（2000→6000）。非流式的 `callGLM`（知识卡 JSON）同样在「正文空但有 `reasoning_content`」时 ×3 重试（1600→4800）。回归测试：`scripts/verify-askai.mjs`（假推理模型 SSE，走真实 UI 路径）。
- **关思考开关**（v1.24.0）：`S.data.aiNoThink`（设置里的「深度思考」：关闭（快）/ 开启（更准），缺省视为**关闭**）。关掉时请求带 `reasoning_effort:'none'`（实测 DeepSeek 官方：思考 0 字，flash 3563→1740ms、v4-pro 6971→2859ms；另 `thinking:{type:'disabled'}` 与别名 `deepseek-chat` 同样生效，而 `enable_thinking`/`chat_template_kwargs`/`thinking_budget` 无效）。若某服务商不认这个参数返回 400，自动**去掉参数重试一次**并在本会话记住（`reasoningEffortRejected`）。重试总次数有界：最多 1 次参数降级 + 1 次预算加码。
- **预生成**：点「开始学习」后按组并发生成（`PREGEN_CONCURRENCY=2`），已缓存跳过；`setTimeout` 延迟宏任务避免阻塞。




### 6.2 语音 TTS（本地，离线 Piper —— v1.20.0 起内置主方案）

- **App 内离线发音**：内置 **Piper TTS**（ONNX 神经网络），两个女声模型打包进 APK —— 美音 `en_US-lessac-medium`、英音 `en_GB-alba-medium`（各约 63MB）。零联网、**不依赖系统 TTS 引擎**。
- **路线（关键）**：构建机 `scripts/tts/prepare-phonemes.mjs` 用 host 工具 `scripts/tts/host/`（piper-phonemize + 编译的 espeak-ng）把知识库全部**单词+例句+短语**（35740 条）预计算成音素 → `mobile-app/android/app/src/main/assets/tts/phonemes.json`；App 内仅用 `onnxruntime-android`（Java 原生）做 VITS 合成，**不含 espeak-ng 运行时、无 WebView WASM**。**不要走 sherpa-onnx 的 .so / WASM 内置路线**（历史在真机闪退，见 §15）。
- **原生插件**：`mobile-app/android/app/src/main/java/.../TTSPlugin` + `TtsEngine`（Java）—— `speak(text,{voice:en-US|en-GB,rate,pitch})` / `stop()` / `hasPhonemes()` / `isAvailable()`；22050Hz PCM 用 `AudioTrack` 播放。
- **Web 通用 API**：`Utils.tts`（`shared/utils.js`）—— `speak/stop/hasPhonemes/isAvailable/voice()`，音色随设置「发音口音」（`S.data.accent`，默认 us）。**为后续听力练习预留**：新文本在构建时补进预计算脚本即可支持，无需改 App。
- **接线**：知识页单词/例句“点按朗读”现**优先离线 Piper**（有音素则用，无音素如雅思词 → 降级系统 TTS / Web Speech）；单词行与例句新增 🔊 图标。
- 网页端（无原生插件）仍走同源 `/api/tts`，失败自动降级（断网安全）。
- ⚠️ **覆盖范围**：仅六级 5407 词及其中文例句、短语（知识库已预生成）。雅思/自定义等无可读音素的文本自动回退系统 TTS。
---

## 7. 构建 / 打包

### 7.1 网页版

静态站点，任意静态服务器或直接打开均可：

```bash
# 语法自检（改代码后必做）
node --check shared/fsrs-adapter.js
node --check shared/utils.js
node --check modules/vocabulary/script.js
```

### 7.2 安卓 App（`mobile-app/`）

前置：JDK17 + Android SDK（platform 34 + build-tools）；在 `mobile-app/android/local.properties` 写 `sdk.dir=<你的SDK路径>`（该文件被 git 忽略，本机不提交）。

```bash
cd mobile-app
npm install                    # 装 @capacitor/* 等
npm run pack-web               # 生成 web/（复制主站 + 注入 APP_API_BASE）
npx cap sync android           # 同步 web/ 到 android 工程
cd android
./gradlew assembleDebug        # 产出 android/app/build/outputs/apk/debug/app-debug.apk
```

APK 拷贝到安卓手机直接安装（debug 签名，需允许"安装未知来源应用"）；正式分发改用 release 签名。
`pack-web.mjs` 每次清空重建 `web/`，保证与主站一致。

### 7.3 打包注入原理（`mobile-app/scripts/pack-web.mjs`）

- `FILES` 列表决定打进 App 的网页资源（含 `words/cet6.json`、`ielts.json`、`sw.js`、`manifest`、`icons`、`start.webp` 等）。
- 顶部 `SERVER_BASE=''` → **完全本地**；注入 `window.APP_API_BASE`（在 `utils.js` 之前写入 HTML），并把 `utils.js` 里的 `var SERVER_API='/api/state'` 替换为 `APP_API_BASE + '/api/state'`（同样处理 knowledge）。
- 结尾自检：离线词库是否随包、`APP_API_BASE` 是否注入，失败即抛错。

---

## 8. PWA（离线网页）实现

- 文件：`manifest.webmanifest`（安装清单）、`sw.js`（Service Worker）、`icons/`。
- `sw.js` 缓存名 `CACHE = 'wxs-v1.18.3'`（**发版必须升**，旧缓存 activate 时自动删除）。
- `PRECACHE` 预缓存清单与各 HTML 的 `?v=1.18.3` 引用保持一致（v1.00 基线复核）。
- 策略：
  - HTML 导航：网络优先，失败回退缓存（联网总拿最新）；
  - 静态资产（CSS/JS/词库/图标/manifest）：stale-while-revalidate（命中秒回 + 后台刷新）；
  - `/api/*` 动态数据：**绝不缓存**、直通（本地无后端时自然走失败→本地兜底）。
  - 跨域 AI 请求直通（`origin!==self.origin` 放行）。
- 注册携带 `updateViaCache:'none'` 兜底。

---

## 9. 代码地图（关键函数索引）

### 9.1 `shared/utils.js`（全局 `Utils`）

- 用户：`getCurrentUser / setCurrentUser / clearCurrentUser / getUserStorageKey / migrateOldStorage`。
- 常量：`USERS=['cet6','ielts']`、`BASE_STUDY_KEY='cet6study.v1'`、`BASE_KNOWLEDGE_KEY='cet6knowledge.v1'`、`CURRENT_USER_KEY`、`DEFAULT_AI_PERSONA`；`PERSONA_PRESETS` / `personaPreset()`（v1.19.0 起不再有 `DEFAULT_API_KEY`）。
- 存储/同步：`initStorage / loadData / saveData / normalizeStudyData / clearAllStorage / queuePush / flushPush`。
- 词库：`wordBankFile / wordBankUrl / ensureWordBank / makeWordRecord / parseImportTxt`。
- FSRS 口径：`isMasteredWord / isDueWord / wordStateName / syncDerived`。
- 统计：`computeStats`（及 dailyGoal/newRatio 相关）。
- 知识缓存（IndexedDB）：`loadKnowledge / saveKnowledge / getKnowledge / setKnowledge / _ensureKnowledgeLoaded / _flushKnowledge / _scheduleFlushKnowledge / loadKnowledgeFromDb / migrateKnowledgeFromLocalStorage / trimKnowledgeCache / openKnowledgeDb`。
- 主题：`applyTheme / chooseTheme / ensureThemeChosen`。
- 杂项：`dateStr / todayStr / addDays / daysBetween / formatCN / shuffle / clamp / toast / escapeHtml`。

### 9.2 `modules/vocabulary/script.js`（全部模块逻辑，约 2400 行）

- 会话：`init / doInit / bindEvents / ensureDaily / beginSession / showCard / exitStudy`。
- 选词：`selectSessionWords / dueMs`。
- 评分/撤销：`onSwipe / onCardClick / onUnsure / gradeAndContinue / applyRating / updateStreak / showFeedback / captureApplied / restoreApplied / latestAppliedFor / undoLastApplied / correctionAvailable / correctGradeToUnsure / goBack`。
- 知识页：`showKnowledge / hideKnowledge / ensureKnowledge / fetchKnowledge / refreshKnowledge / renderKnowledge* / bindKnowledgeGesture / kcNext`。
- AI：`getAIConfig / callGLM / callGLMStream / extractJson / normalizeKnowledge / pregenWords / askAI`。
- 查找：`findWordById`（O(1) `_wordById`）、`_buildWordMap / currentWord`。
- 听写：`startDictation / dictCheck / dictShowAnswer / dictNext / dictPlayHint`。
- 语音：`initSpeech / speakEn / speakNative / speakEnLocal`。
- 设置/列表：`renderOverview / openWordList / addCustomWord / renderChart / exportBackup / handleImport`。

### 9.3 其它

- `shared/fsrs-adapter.js`：`FSRSAdapter.next / migrateWordRecord / stateName`。
- `sw.js` / `manifest.webmanifest`：PWA 离线与安装。
- `mobile-app/scripts/pack-web.mjs`：打包注入（见 §7.3）。

---

## 10. 常用脚本与命令

| 命令 | 作用 |
|---|---|
| `node --check shared/utils.js` 等 | 语法自检 |
| `npm run vendor:fsrs`（webstudy/root） | 重新生成 `shared/vendor` 打包（先 `npm install`） |
| `node scripts/migrate-fsrs.mjs` | 一次性 SM-2→FSRS 迁移 |
| `powershell scripts/gen-icons.ps1` | 重新生成 PWA/App 图标 |
| `cd mobile-app && npm run pack-web` | 重建 `web/` 资源包 |
| `cd mobile-app && npx cap sync android` | 同步网页资源进安卓工程 |
| `cd mobile-app/android && ./gradlew assembleDebug` | 编译 APK |
| `cd mobile-app && node scripts/verify-offline.mjs` | 离线词库验证 |
| `cd mobile-app && node scripts/verify-idb.mjs` | IndexedDB 持久化验证 |

---

## 11. 版本与发版纪律

- `update.md` 是**逐版本变更日志 + 当前数据结构 + 交互规则**（最权威细节）；每次改动按版本追加一节。
- `1.md` 是需求原文存档。
- 发版清单（每次改版照做）：
  - [ ] `node --check` 全过
  - [ ] `update.md` 追加版本节、数据结构/交互规则同步
  - [ ] HTML 引用升 `?v=`；若涉 PWA 同步升 `sw.js` 的 `CACHE` 名
  - [ ] 若改 App 资源：`mobile-app` 里 `npm run pack-web && npx cap sync android` 后编译 APK 正常
  - [ ] 离线词库/IndexedDB 验证脚本跑通
  - [ ] 未经用户要求不 `git push`

> 版本号说明：**本交接版本 v1.00** 是"完全本地化为纯本地 App"这一里程碑的新基线。
> 代码内部旧 web 版本号仍写 `1.18.3`（`?v=` 与 `wxs-` 缓存名）。建议后续发版把两处统一抬升
> （如直接采用 v1.00 语义或在 `update.md` 里从 v1.00 起新编号），避免双版本号混淆。

---

## 12. 已知坑与术语

1. **手指方向 vs 页面方向**：学习页用手指方向（上滑=Good）；知识页用**页面方向**（上滑页面=手指下滑）。别改混。
2. **due 是 ISO 字符串**：比较用 `new Date(card.due) <= new Date()`，不要字符串比较。
3. **state=3 是 Relearning（重学中）**，不是"已掌握"；"已掌握"= state 2。
4. **新词评分后可能 10 分钟内再到期**（学习步骤 1m/10m），ts-fsrs 默认行为，选词 dedupe 已处理。
5. **脚本加载顺序**：`vendor/ts-fsrs` → `fsrs-adapter` → `utils` → 页面脚本；改了会炸。
6. **缓存参数**：改 JS/CSS 不升 `?v=`，旧缓存会让改动不生效。
7. **`localStorage` 配额**：知识卡千万别塞回 localStorage（~6MB 超 5MB 配额静默写爆）——一定要走 IndexedDB。
8. **`response_format:{type:"json_object"}` 不是所有 API 都支持**：硅基流动部分模型不支持，换 API 后知识卡失败先查这项。
9. **`global.css` 有通用 `input[type="text"]` 样式**，会覆盖自定义输入框 → 需更高特异性/`!important`。
10. **APK/web/ 是构建产物不入库**：克隆后先 `npm install` + `pack-web` + `cap sync`，别在仓库找 `web/` 或 `.apk`。
11. **git 换行**：仓库有 LF/CRLF 告警，`git add` 会有换行提示，属正常（`.gitattributes`/autocrlf 管理）。

---

## 13. Git 操作

```bash
git status / git diff          # 查看改动
git add -A && git commit -m "..."   # 提交到本地
git push origin codex/arknights-ui-v1.17.0   # 推送（需网络到 github.com；不可达则网络恢复后再推）
git remote -v                  # origin → https://github.com/Bocchiiiiiii/wordexcite.git
```

> 若从 `D:\Coding\webstudy`（旧副本）工作，同样提交/推送即可；两副本是同一仓库（历史一致）。

---

## 14. 文档索引

- 需求原文 / 历史补充：`1.md`
- 变更日志 / 数据结构 / 交互规则（权威）：`update.md`
- 安卓 App 构建说明：`mobile-app/README.md`
- 本交接手册：`readme.md`（v1.00）

---

## 15. 当前待办 / 未决事项（接手时可优先考虑）

1. **更自然的离线语音**（未决）：当前用系统 TTS（稳定可靠但"不够自然"）。内置 sherpa WASM 浏览器版有
   `memory access out of bounds`、原生 .so 真机**闪退**——两条内置路线均已失败并移除。若要做内置高质量语音，
   需在真机用 adb/logcat 定位崩溃，或换更成熟方案（如 `android.speech.tts` 绑定更高质引擎 / 下载式语音模型）。
   在用户明确点头前**不要**默认改回 sherpa .so 路线。
2. **Git push 依赖网络**：当前 GitHub 从本机不可达；推送到 origin 需网络恢复（§13）。
3. **双版本号收口**：把内部 `1.18.3` 缓存参数统一到 v1.00 语义（§11）。
4. **可选优化**：`server.py` 已删，`updated` 的"在线同步"章节已不再适用；如需在线同步需重写后端（当前不计划）。

---

*（END · v1.00）*
