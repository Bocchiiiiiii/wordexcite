# 更新日志（Update Log）

> 文档用途：记录「树莓派学习小站 · 六级背单词模块」的历次变更、当前交互逻辑与数据结构。
> 维护约定：以后每次改动都按版本追加一节，并同步修改「数据结构」章节中的对应字段，保证字段定义与代码一致。
> 2026-08-17 起：根目录 `readme.md` 已重写为 v1.12.1 交接手册；原始需求文档由用户改名为 `1.md` 存档。

---

## 版本历史

### v1.26.0（2026-09）· 开源前隐私清理 + 内部标识改为词库名

**背景**：仓库要公开，先做隐私体检（工作区 + git 历史全量扫描）。

1. **内部标识去人名**：`USERS=['cet6','ielts']`、`USER_LABELS`、`WORD_BANKS={ielts:'ielts.json'}`、页面 `data-user`、`BANK_BY_USER` 全部改用词库标识。旧标识（两个汉字）写在 `LEGACY_USERS` 里——**用码位构造**，公开仓库不出现姓名——`getCurrentUser()` 命中即刻改写 `currentUser` 并调用 `migrateLegacyUserKeys()` 把 `base+'.'+旧名` 的存储键改名（首位词库沿用 base key，零迁移）。**老用户进度不丢**，回归测试 `scripts/verify-migrate.mjs`（11/11 PASS）。
2. **去掉个人标识**：文档/脚本里的自有域名 → `example.com`、内网 IP → `192.168.1.10`、Windows 用户名 → `USER`、Linux 用户名 → `pi`。
3. **移除泄漏的 API Key**：`1.md` 里两处智谱 API Key 已打码。⚠️ 该 key 曾硬编码在 `shared/utils.js`（`DEFAULT_API_KEY`，v1.19.0 已删）与 `modules/vocabulary/script.js` 的 `Authorization` 头里，**并已存在于历史提交中**（已在远端），必须到服务商后台吊销重发。
4. **`.gitignore` 扩充**（公开仓库只留源码与必要数据）：排除 `backups/`（个人学习数据）、`1.md`（私有需求文档）、`words/worddatas/`（批量生成中间产物 39MB）、`host-build/`、`*.onnx`（第三方语音模型，各 63MB）、`assets/tts/phonemes.json`（8.4MB 生成物）、`mobile-app/web/` 与 `assets/public/`（pack-web 生成副本）、各类构建产物。最终入库 111 个文件 / 约 18MB。
5. 包名 `top.cloudgenshin.wordexcite` 按用户决定**保留**（自有域名已属公开信息；改包名会让已装 App 变成另一个应用、进度需导出导入）。
6. 版本：HTML `?v=1.25.0 → 1.26.0`；`sw.js` `CACHE='wxs-v1.26.0'`。

### v1.25.0（2026-09）· 修复「选了猫娘却按暴躁老哥回答」+ 追问强制简短/纯文本

**Bug 根因（数据层静默丢字段）**

`Utils.normalizeStudyData()` 是**白名单重建**：它 new 一个默认对象，再逐条把认识的字拷贝过去。
`aiPersona` **从未被列进白名单** → 于是：
1. 点「可爱猫娘」→ `S.data.aiPersona = 猫娘提示词` → `saveData()` 正常写入 localStorage；
2. 一旦 `loadData()`（进模块页、刷新、切词库）→ 规范化时 `aiPersona` 被丢掉；
3. 之后任何一次保存（学一个词就存一次）会把「没有人设」的版本写回本地 → 人设永久消失；
4. `getPersona()` 见字段为空 → 回落到 `Utils.DEFAULT_AI_PERSONA`，而**默认值正好是暴躁老哥的那段**。
   于是表现为「我选了猫娘，它却用暴躁老哥回答」。

**修复**

1. `normalizeStudyData()` 增加**未知字段继承**：规范化前先把原对象里所有未登记的字段原样带过来（`__` 开头的内部临时标记除外），新增字段不会再因为忘记登记而静默丢失。
2. 同时把 `aiPersona` 显式纳入规范化（`defaultStudyData()` 里也补上该字段声明）。
3. 审计结论：20 个默认字段中当时**只有 `aiPersona` 一个**不在白名单里，其余设置（URL/Key/模型/主题/口音/词库/目标等）都正常——即这次只影响人设。

**追问提示词调整（按需求）**

4. system prompt 由「不需要刻意精简，该详细就详细」改为：**回答要简短**（默认 2–3 句、100 字以内，要例句最多给 2 条，不要重复问题）。
5. 明确要求**纯文本、不要 Markdown**（不用 `**加粗`、`# 标题`、`- / 1. 列表`、行内代码、代码块、表格）。
6. 回归测试扩到 16 项（`scripts/verify-askai.mjs`，16/16 PASS）：新增「点猫娘后刷新页面人设仍在」「追问请求带的是猫娘而不是默认暴躁老哥」「提示词含简短要求与禁止 Markdown」。第 2 条正是这次 bug 的探针。
7. 版本：HTML `?v=1.24.0 → 1.25.0`；`sw.js` `CACHE='wxs-v1.25.0'`。

### v1.24.0（2026-09）· 新增「深度思考」开关（推理模型可关掉思考）

**背景**：v1.23.0 让推理模型的回答能被收全了，但**思考本身很慢**（实测 flash 3563ms / v4-pro 6971ms，且思考动辄上千字）。
思考是模型自带的，但**服务商接口提供开关**——实测（用 App 的请求形状直打 DeepSeek 官方）：

| 参数写法 | 是否生效 |
| --- | --- |
| `reasoning_effort: "none"` | ✅ 思考 0 字；flash 3563→1740ms，v4-pro 6971→2859ms |
| `thinking: {"type":"disabled"}` | ✅ 思考 0 字（flash 1194ms） |
| 模型名 `deepseek-chat` | ✅ 非思考别名（思考 0 字） |
| `reasoning_effort: "minimal"` / `enable_thinking:false` / `chat_template_kwargs` / `thinking_budget:0` | ❌ 仍会思考 |

1. **设置项**：首页与模块页的 AI 配置区都新增「**深度思考**」——`关闭（快）` / `开启（更准）`，字段 `data.aiNoThink`（**缺省视为关闭**，即默认走快路径）。
2. **请求侧**：`aiNoThink !== false` 时，流式与非流式请求都带 `reasoning_effort:'none'`。
3. **自动降级**：别的服务商不认这个参数会返回 400 → `isParamRejection()` 识别后**去掉参数重试一次**，并用模块级 `reasoningEffortRejected` 在本会话记住，不改用户设置。
4. **重试有界**（修 v1.23.0 引入的隐患）：最多 **1 次参数降级 + 1 次预算加码**（2000→6000）。此前放宽到 4 次，遇到「永远只吐思考」的模型会把预算一路飙到 54000 tokens——白烧钱，已由回归测试钉住。
5. **回归测试**扩展为 4 个阶段、12 项断言（`scripts/verify-askai.mjs`，12/12 PASS）：新增「关思考请求必带 `reasoning_effort=none`」「服务商 400 拒绝后降级为不带参数且仍能回答」「think-only 只加码一次不无限烧 token」。
6. 版本：HTML `?v=1.23.0 → 1.24.0`；`sw.js` `CACHE='wxs-v1.24.0'`。

### v1.23.0（2026-09）· 修复「追问 AI 一直提示没有收到回答」（推理模型）

**真机实测到的根因（用 App 的请求形状直接打 DeepSeek 官方接口复现）**

DeepSeek V4 这类**推理模型**的流式响应会先吐 `delta.reasoning_content`（思考），此时 `delta.content` 是 `null`；
旧的 SSE 解析只读 `delta.content` → 正文一个字都收不到 → 界面只显示「这次没有收到回答，请再问一次」。
并且**思考同样占用 `max_tokens`**：思考把预算吃光时 `finish_reason=length` 且正文为空。
实测（用 App 的请求形状直打 DeepSeek 官方，`scripts` 之外的临时探针，见 `/tmp/askai-rootcause.txt`）：
`max_tokens=260` 必空；`max_tokens=800` **时好时坏**（同一模型同一问法，实测有 0 字 / 186 字 / 258 字且有 `length` 截断）；`max_tokens=2000` 稳定拿到正文。
即失败是**概率性**的（取决于这次思考多久），所以表现为「有时能答、有时一直答不出来」。
注意：这与「选人设」无关（有人设/无人设实测同样会空），人设只是让回答更长、更容易撞上预算。

1. **流式解析重写**：`callGLMStream` 拆为 `callGLMStream`（预算控制 + 重试）+ `streamOnce`（一次请求），两路 delta 都解析，并记录 `finish_reason`。
2. **预算自适应**：首次请求 `max_tokens` 取 `max(调用值, 2000)`；若收完流仍没有正文，自动 **×3 重试一次**（2000 → 6000），仍无正文才放弃。
3. **过程可见**：思考阶段显示「思考中…」；触发重试时显示「思考较长，正在重试…」；最终仍无正文时提示「（模型思考过长被截断）」。
4. **非流式路径同样加固**：`callGLM`（知识卡 JSON 模式）在「正文空但存在 `reasoning_content`」时也自动 ×3 重试一次（1600 → 4800），不再直接报「AI 返回为空」。
5. **回归测试** `scripts/verify-askai.mjs`（8/8 PASS，全离线假接口）：模拟「预算不足只吐思考」与「永远只吐思考」两种模型，走真实 UI 路径（**触摸**点击单词 → 知识卡 → 追问）断言能拿到正文、重试序列、可读提示；另验证知识卡加码重试后卡片真的渲染。
6. 版本：HTML `?v=1.22.0 → 1.23.0`；`sw.js` `CACHE='wxs-v1.23.0'`。

> 测试踩坑记录：无头浏览器里用鼠标 `click()` 点学习卡片会被 `suppressClickUntil` 吞掉（卡片用手势 pointer/touch 判定），必须用 `touchscreen.tap()` 模拟手指——真机行为以此为准。

### v1.22.0（2026-09）· AI 模型列表一键获取 + 关于页清理

**Feature：设置里可拉取接口的模型列表，挑一个用，也可以继续手输**

1. **新增 `Utils.fetchAIModels(aiUrl, apiKey)`**（`shared/utils.js`）：
   - 端点规范化 `Utils.aiModelsEndpoint()`：只填 `.../v1` 即可，误填 `.../chat/completions` 会自动纠正，末尾统一补 `/models`；
   - `GET {base}/models` + `Authorization: Bearer {key}`，20 秒超时；
   - 解析兼容三种返回：`{data:[{id}]}`（OpenAI 系）/ `{models:[...]}` / 纯数组；去重、排序；
   - 失败给可读原因：401/403「API Key 无效或无权限」、404「接口不存在，请检查 Base URL」、非 JSON「Base URL 可能填错了」、超时、空列表。
2. **首页设置**（`index.html`）：模型名称输入框下方新增「获取模型列表」按钮 + 可滚动列表（`.ai-model-list`），点条目即填入并保存（`data.aiModel`），当前生效项高亮；输入框**保持可编辑**，手输同样可用。每次打开设置时列表收起，重新获取。
3. **模块页设置**（`modules/vocabulary/index.html` + `script.js`）：同款按钮（`#fetchModelsBtn`）与列表（`#aiModelList`），行为一致。
4. **样式**：`shared/global.css` 加基础样式，`shared/arknights.css` 加方角描边皮肤覆盖（两个皮肤都贴合）。
5. **关于弹窗**：删除过时的「部署：树莓派 5B + Cloudflare Tunnel」，改为「运行方式：纯本地（数据只存在本机，无需服务器）」；词库行更新为「CET6 5407 词 / IELTS-8000 8364 词」。
6. 版本：HTML `?v=1.21.0 → 1.22.0`；`sw.js` `CACHE='wxs-v1.22.0'`。

> 说明：模型列表走用户自己的 Base URL（OpenAI 兼容 `/models`）；若某服务商不提供该接口，按钮会提示失败，手输模型名不受影响。

### v1.21.0（2026-09）· 账户改为词库选择 + 站点更名

**改动（App 已完全离线，无账户概念）**

1. **“用户”改为“词库”**：原 `USERS=['cet6','ielts']` 的内部标识**保持不变**（保证已有学习进度不丢），界面一律按词库显示 —— `USER_LABELS={'cet6':'CET6','ielts':'IELTS-8000'}`，新增 `Utils.userLabel()`。
2. **首启弹窗**：标题“选择用户”→“选择词库”，按钮文案改为 `CET6` / `IELTS-8000`（`data-user` 内部值不变）。
3. **首页设置**：“当前用户 / 切换”行改为“词库选择”，两个可直接点的选项（CET6 / IELTS-8000），当前词库高亮；点击即切换并重载对应词库（两库进度独立）。
4. **模块页设置**：“当前用户”行改为“词库选择”，按钮“切换”→ 文案“切换词库”，显示当前词库名。
5. **站点更名**：首页标题与模块页 `document.title` 的“树莓派学习小站”→“四人帮的学习小站”。
6. **文案纠偏（与“完全离线”一致）**：设置副标题不再说“同步到树莓派服务器”，改为“所有数据都保存在本机，完全离线可用”；清空数据的二次确认文案去掉“服务器”字样。
7. 版本：HTML `?v=1.20.0 → 1.21.0`；`sw.js` `CACHE='wxs-v1.21.0'`。

### v1.20.0（2026-09）· 内置离线 Piper TTS（美音/英音，纯本地合成）

**Feature：离线本地发音（嵌入 APK，无需联网、不依赖系统 TTS 引擎）**

1. **引擎路线**：Piper TTS（ONNX 神经网络）。集成方式为「构建机预计算音素 + 运行时 onnxruntime 合成」——
   - 不用 sherpa / WebView 里跑 WASM（避开历史崩溃路线）；
   - App 内只跑成熟稳定的 `onnxruntime-android`（Java 原生）做 VITS 合成，**不含 espeak-ng 运行时、无 WASM**。
2. **音色**：打包两个女声模型 —— 美音 `en_US-lessac-medium`、英音 `en_GB-alba-medium`（各约 63MB），由设置里的「发音口音」（`S.data.accent` us/gb）选择，默认 us。
3. **音素预计算**：`scripts/tts/prepare-phonemes.mjs` 在构建机用自编的 host 工具 `scripts/tts/host/`（piper-phonemize + 编译的 espeak-ng）把知识库全部**单词 + 例句 + 短语**（35740 条）音素化，产出 `mobile-app/android/app/src/main/assets/tts/phonemes.json`，随 APK 打包；两个音色共享这一份音素（两模型 `phoneme_id_map` 一致，运行时各自映射成 id）。
4. **原生插件**：`TTSPlugin` + `TtsEngine`（Java）—— `speak(text,{voice,rate,pitch})` / `stop()` / `hasPhonemes(text)` / `isAvailable()`；合成 22050Hz PCM 用 `AudioTrack` 播放。
5. **Web 通用 API**：`Utils.tts` —— `speak/stop/hasPhonemes/isAvailable/voice()`（音色随 `accent`）。**为后续听力练习预留**：新文本在构建时跑预计算脚本补进 `phonemes.json` 即可支持。
6. **接线**：知识页单词与例句已有“点按朗读”，现改为**优先走离线 Piper**（有音素则用，无音素如雅思词降级到系统 TTS / Web Speech）；单词行与例句新增 🔊 图标。
7. **覆盖范围**：仅六级 5407 词及其中文例句、短语（知识库已预生成）。雅思/自定义词无可读音素时自动回退系统 TTS。后续听力练习文本需在构建时经预计算脚本补入。
8. **体积**：APK 由约 16MB 增至约 180MB（两个 63MB 模型 + onnxruntime 原生库 + 音素数据）。
9. 构建：`node scripts/tts/prepare-phonemes.mjs`（依赖 `scripts/tts/host/` 编译出的 `tts_phonemize.exe`）→ `cd mobile-app && npm run pack-web && npx cap sync android` → Gradle `assembleDebug`。
10. 版本：HTML `?v=1.19.0 → 1.20.0`；`sw.js` `CACHE='wxs-v1.20.0'`。

### v1.19.0（2026-09）· 内置离线知识打包 + 原生保存 + 启动页全屏 + AI 人设 + 写词 + 去内置 AI 密钥

**Bug 修复**

1. **离线预生成知识真正进 App（不再“等待知识生成”）**：
   - 根因：App 完全本地（`SERVER_BASE=''`），推送到服务器的 5407 词知识缓存到不了手机；每台设备只在本机 IndexedDB 命中时不调 AI。
   - 新增 `scripts/build-knowledge.mjs`：读取 `words/worddatas/` 下两个 `batch_*.jsonl`（SiliconFlow 批量输出，`custom_id=w<5位索引>` 对应 cet6.json 下标），提取 `choices[0].message.content` 并归一化为 v3 词条，合并输出 `words/knowledge-cet6.json`。
   - `mobile-app/scripts/pack-web.mjs` 的 `FILES` 增加 `words/knowledge-cet6.json`（打包进 APK）；`sw.js` `PRECACHE` 同步加入。
   - `shared/utils.js` 新增 `seedBundledKnowledge()`，启动时（`initStorage` 内）fetch 内置文件并把缺失词条种入 IndexedDB/内存缓存；只对 cet6 词库生效，雅思暂无数据、不覆盖设备上已有的词条。
   - 未覆盖词（自定义导入 / 雅思 / 预生成失败的词）仍会在首次打开时联网生成并缓存，之后离线可用。
2. **导出备份改为真正保存**：
   - 新增原生插件 `SaveDocument`（Android `ACTION_CREATE_DOCUMENT`），点击“导出备份”→ 系统弹出“保存到…”文件选择页，写入选定位置。
   - `modules/vocabulary/script.js` 的 `exportBackup()`：App 内走 `Capacitor.Plugins.SaveDocument.save`（base64 数据），网页/其它环境回退到浏览器下载。
   - 插件在 `MainActivity.onCreate` 注册。
3. **启动页补满整屏**：`index.html` 内联样式 `.app-splash-img` 改为 `position:absolute; inset:0; width/height:100%; object-fit:cover` 铺满屏幕；名称/副标题叠加在上方，加载条 `.app-splash-progress` 置于最顶层（`z-index:3`）。
4. **删除内置 AI baseurl 和 key**：
   - 删除 `shared/utils.js` 的 `DEFAULT_API_KEY` 常量及默认注入；`defaultStudyData`/`normalizeStudyData` 的 `apiKey` 默认改为空字符串。
   - `script.js` 删除 `DEFAULT_GLM_URL`/`DEFAULT_GLM_MODEL`；`getAIConfig()` 不再回退内置值；新增 `requireAIConfig()`，URL/Key/模型 有空缺时抛“请先在设置中填写 AI 的 URL、API Key 与模型名称”。
   - 两处设置面板文案改为“必填”，保存逻辑不再回填默认 Key。

**功能**

1. **AI 人设（只作用于“追问 AI”问答）**：
   - `shared/utils.js` 新增人设预设 `PERSONA_PRESETS`（`cat` 可爱猫娘 / `bro` 暴躁老哥，用用户给定 prompt）、`DEFAULT_AI_PERSONA` 与 `personaPreset(name)`，导出到 `Utils`。
   - 首页与词汇模块设置面板均新增“AI 人设”行：两个预设按钮 + 自定义文本框；保存到 `S.data.aiPersona`。
   - `script.js` 新增 `getPersona()`；`askAI()` 的 system 提示词改为 `getPersona()` + 单词上下文，不再硬编码贴吧老哥；知识卡生成提示词不受影响。
2. **知识页“写一遍这个单词”**：
   - 知识页新增 `.kc-write` 区块：“点击写一遍这个单词”→ 输入框 → 回车 → `trim()+小写` 与当前单词比对，显示“拼写正确 / 拼写不对，再试一次…”。
   - 纯字符串比对，**不触发 FSRS、无任何算法**；答对后短暂显示提示并收起，答错可重试。

**数据与发版**
- 主数据新增字段：`aiPersona`（字符串，缺省用 `DEFAULT_AI_PERSONA`）。旧数据兼容（`normalizeStudyData` 未显式声明，`getPersona()` 在缺省时用默认人设）。
- 版本：HTML `?v=1.18.3 → 1.19.0`；`sw.js` `CACHE='wxs-v1.19.0'`、`PRECACHE` 加 `words/knowledge-cet6.json`。
- ⚠️ 打包 App 前需先跑 `node scripts/build-knowledge.mjs` 生成 `words/knowledge-cet6.json`，否则 `pack-web` 会因源文件缺失报错。

### v1.18.2（2026-08-25）· 知识缓存改为按词查询

**背景与根因**：v1.18.1 把 5407 词知识卡整包（~6.3MB 字符）写进服务器 `cet6knowledge.v1` 成功，但前端 `initStorage()` 每次整包 GET 到 localStorage 时会触发 **QuotaExceededError**（约 6MB > 浏览器 localStorage 常见 5MB 配额），异常被静默吞掉 → `_knowledgeCache` 永远为空 → `isCached` 永不命中 → 每个词仍实时调 AI。线上核验确认：服务器缓存正确（5407 条，v3 结构完整），问题在"整包塞 localStorage"这条路本身走不通。

1. **server.py 新增只读端点 `GET /api/knowledge?key=<key>[&word=<en>]`**：
   - 带 `word`：从缓存中解析出该词的**单条**知识卡返回（`{ok, key, word, entry}`），entry 为 null 表示服务器无此词；大小写不敏感（word 转小写）。
   - 不带 `word`：仅返回轻量元信息 `{ok, key, exists, count}`，避免整包 6MB 回传。
   - 内置 30 秒 TTL 解析缓存（`_KN_CACHE`），避免每次请求反复 `json.loads` 6MB。
2. **`shared/utils.js`**：
   - `initStorage()` 不再整包 GET 知识缓存到 localStorage（杜绝 QuotaExceeded 静默失败）；只加载本地已有旧缓存到内存（离线仍可命中）。
   - 新增 `getServerKnowledge(en)`：按词向 `/api/knowledge` 查询单条，失败/无词返回 null（调用方回退调 AI）。
3. **`modules/vocabulary/script.js`**：`fetchKnowledge` 在本地未命中时，**先按词查服务器**；命中则 `setKnowledge` 缓存 + 返回（不再调 AI）；未命中才走实时 AI。知识页打开与「开始学习」预生成都自动走这条路径。
4. **`scripts/test-server.mjs`** 同步新增 `/api/knowledge` mock，本地联调一致。
5. **兼容性**：本地已学词的旧缓存仍可命中；知识页「刷新」仍强制实时生成；AI 生成的新词条仍会写回本地缓存。前端仍保持学习页只显示单词+音标、无卡片 UI（产品红线不变）。
6. **部署注意**：`server.py` 改动需同步到树莓派 `/opt/study-api/server.py` 并 `sudo systemctl restart study-api`；`sw.js` CACHE 升为 `wxs-v1.18.2`（旧缓存自动清理）。

### v1.18.1（2026-08-24）· 全量知识卡批量预生成并写回服务器

1. 新增 `scripts/pregen-knowledge-batch.py`：基于 SiliconFlow **Batch API** 批量预生成知识卡，流程全自动（上传 jsonl → 创建 batch → 轮询 → 下载结果 → 归一化 → 合并 → 写回树莓派）。
2. 已全量生成 **5407 个六级单词**的 v3 知识卡并写回服务器 `cet6knowledge.v1`：写回前自动备份旧值到 `kv_history`（保留 30 份，与 server.py 逻辑一致）；服务器验证确认 5407 条、字段结构 v3 完整（`meanings` / `variants` / `phrases` / `etymology`）。
3. 模型：`deepseek-ai/DeepSeek-V4-Flash`（SiliconFlow 支持批量价）；批量输入 prompt 与前端 `fetchKnowledge` **逐字一致**，归一化逻辑与 `normalizeKnowledge` **完全对齐**；单文件 ≤5000 行限制，5407 词拆 2 批（5000+407）。
4. ~~前端零改动~~（此条已证伪，勿采纳）：原以为 `initStorage()` 整包拉服务器缓存到 localStorage 即可命中，但整包 6MB 超出 localStorage 5MB 配额导致 QuotaExceeded 静默失败、缓存永远为空。**实际需要按词查询，见 v1.18.2**。
5. 写回走 Cloudflare Tunnel SSH 直写 sqlite，绕过 HTTP PUT 的 8MB 体积上限（合并后约 6.3MB 字符 / 8.4MB 字节）。
6. 批量预生成的小批量试跑（3 词）已验证字段与前端 v3 结构兼容；知识卡 TTL 30 天（`isKnowledgeValid`），到期自动按需重新生成。

### v1.18.0（2026-08-24）· PWA：支持安装与离线使用

1. **新增 PWA 三件套**：
   - `manifest.webmanifest`：name「你还不背？」/ short_name「你还不背？」/ `id: "/"` / `start_url: "/index.html"` / `scope: "/"` / `display: "standalone"` / theme & background `#181a1d`；三个图标（192 any / 512 any / 512 maskable）。
   - `sw.js`：Service Worker，缓存名 `CACHE = 'wxs-v1.18.0'`；`install` 逐条预缓存 + `skipWaiting`；`activate` 删除旧缓存 + `clients.claim`。
   - `icons/`：`icon-192.png` / `icon-512.png` / `icon-512-maskable.png`（由新增 `scripts/gen-icons.ps1` 生成，PowerShell + System.Drawing，深色圆角方块 + 金色「词」字）。
2. **sw.js 缓存策略**：HTML 导航网络优先（失败回退缓存）；静态资产 stale-while-revalidate（命中先秒回 + 后台刷新）；`/api/*` 动态数据**绝不缓存、直通网络**（服务器为权威）。跨域 AI 接口（智谱/硅基流动）直通。
3. **离线行为**：词库 `cet6.json`/`ielts.json` 已预缓存，离线可背词；离线评分仍存 localStorage，联网后 `queuePush` 自动补齐（`revision` 防覆盖）。TTS `/api/tts` 离线时静默跳过。
4. **前端改造**：`index.html` 与 `modules/vocabulary/index.html` 各加 `<link rel="manifest">` 与 SW 注册（`navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })`，根绝对路径，静默失败忽略）；全部 `?v=` 升为 `v1.18.0`（`ts-fsrs-5.4.1.js` 文件名版本不变）。
    - 新增站点 favicon：`icons/favicon.ico`（32x32，由 `scripts/gen-icons.ps1` 一并生成），两个 HTML 的 `<head>` 用 `<link rel="icon" href="/icons/favicon.ico">` 引用。浏览器每次加载都会自动请求 `/favicon.ico`，不提供会制造 404 噪音并使 e2e「无页面错误」断言失败（SW 注册后该噪音更明显）。
5. **脚本**：`scripts/test-server.mjs` 加 `.webmanifest` MIME + `sw.js`/`manifest.webmanifest` 的 `Cache-Control: no-cache`；`scripts/deploy.py` 的 `DEFAULT_FILES` 补入 `index.html`/`manifest.webmanifest`/`sw.js`/`icons/*.png` 并对远程父目录 `mkdir -p`（幂等）。
6. **线上 Nginx 备注**：Debian 默认 `mime.types` 不映射 `.webmanifest`，需在 `server {}` 内加 `location ~* \.webmanifest$ { types {...}; add_header Cache-Control "no-cache"; }`（只限定 location，勿放 server 级）。部署并 `sudo nginx -t && sudo systemctl reload nginx` 后验证 `Content-Type: application/manifest+json`。
7. **发版纪律**：以后改动前端，必须**同步升 `sw.js` 里的 `CACHE` 缓存名**（如 `wxs-v1.18.0`），否则旧缓存不清、用户手机拿不到新资源。

### v1.17.0（2026-08-21）· 明日方舟风格视觉与可读性改版（本地）

1. 新增 `shared/arknights.css` 与 `modules/vocabulary/arknights.css`，以独立覆盖层迁移视觉，不改 FSRS、词库、同步接口、AI 请求和本地数据结构。
2. 首页改为罗德岛行动终端式信息结构：深色任务抬头、黄黑状态导轨、方角功能面板与真实的 ACTIVE / LOCKED 状态标签；保留原模块入口和全部设置。
3. 学习概览将统计区改为桌面四列、平板两列、手机单列；统计标签、设置说明、列表和知识页正文统一提高字号与行高，手机端不再缩小根字号。
4. 学习页继续只显示单词与音标，不新增评分提示或业务控件；知识页保持原内容顺序，仅优化章节分组、例句、AI 对话和长文本行宽。
5. 交互控件统一为方角高对比样式，保留键盘焦点与 `prefers-reduced-motion`；新增高对比偏好适配，并保证 320px 起可用。
6. 新增资源引用使用 `?v=1.17.0`；本版本未部署、未推送，验收只使用 `127.0.0.1:8810` 本机假服务器。

### v1.17.9（2026-08-23）· 彻底修复预生成卡顿

1. `pregenWords.launch` 对已缓存词直接跳过（`isCached` 检查），不进入 `fetchKnowledge`，彻底消除 `.then` 同步回调链。
2. `pregenWords.schedule` 改为 `setTimeout(doSchedule, 0)` 延迟宏任务，避免同步递归。
3. 知识缓存 flush 改用 `requestIdleCallback`（回退 `setTimeout`），避免 `JSON.stringify` 阻塞主线程。
4. 资源引用更新为 `v1.17.9`。

### v1.17.8（2026-08-23）· 修复预生成导致的严重卡顿

1. **根因**：`getKnowledge()` 每次调用都 `JSON.parse` 整个知识缓存（数千词 = 几 MB），`setKnowledge()` 每次都 `JSON.stringify` + `localStorage.setItem` 整个缓存；预生成循环对 30 个词逐个调用 `isCached` → 30 次完整 parse，每个 AI 返回又触发 parse + stringify + write，导致主线程长时间阻塞。
2. **修复**：知识缓存新增内存层（`_knowledgeCache`），首次加载时 parse 一次，后续所有读写走内存对象；写入通过 `_scheduleFlushKnowledge()` 异步批量 flush（500ms debounce），不再每次 set 都 stringify。
3. **查找优化**：新增 `_wordById` 映射表，`findWordById` 和 `currentWord` 从 O(n) 线性扫描改为 O(1) 哈希查找；避免预生成 30 词 × 8000 词 = 24 万次循环。
4. 用户切换时自动失效内存缓存（`setCurrentUser` / `clearCurrentUser`）；`clearAllStorage` 前先 flush + 清空缓存。
5. 资源引用更新为 `script.js?v=1.17.8`、`utils.js?v=1.17.8`。

### v1.17.7（2026-08-22）· AI 模型自定义配置

1. 移除硬编码的智谱 GLM 模型限制，用户可自行配置 AI API 的 URL、Key、模型名称。
2. 设置页面新增「AI 模型配置」区域：API Base URL / API Key / 模型名称三个输入框。
3. 支持所有 OpenAI 兼容接口（硅基流动 SiliconFlow、智谱、DeepSeek 等）。
4. 留空任何字段使用内置默认值（智谱 GLM-4-Flash-250414）。
5. 新增 `getAIConfig()` 统一解析 URL / model / key，自动补全 `/chat/completions` 后缀。
6. 数据结构新增 `aiUrl`、`aiModel` 字段，向后兼容旧数据。
7. 错误消息从「智谱 API」改为通用的「AI 请求失败」。
8. 资源引用更新为 `script.js?v=1.17.7`、`utils.js?v=1.17.7`。

### v1.17.5（2026-08-22）· 并发预生成 + 模型升级 glm-4.7-flash

1. `startPregen` 重写为 `pregenWords`：2 路并发队列替代原有逐词顺序处理，每个请求完成后立即调度下一个，无固定 delay。
2. 优先级调度：每次调度时优先生成当前正在显示的词，其次按列表顺序。
3. 听写模式新增预生成：`startDictation` 启动时调用 `pregenWords`，不再每个词都现等 AI。
4. 模型从 `glm-4-flash` 升级为 `glm-4.7-flash`（200K 上下文，能力更强，同样免费）。
5. `isCached` 检查增加 `etymology` 字段存在性判断，旧缓存自动触发重新生成。
6. 资源引用更新为 `script.js?v=1.17.5`。

### v1.17.4（2026-08-22）· 同根词增加释义与词性

1. 「词根词缀」板块的同根词由纯单词列表改为每项展示词性 + 中文释义。
2. AI 提示词 related 格式改为对象数组 `[{"word":"...", "pos":"...", "zh":"..."}]`。
3. `normalizeKnowledge` 兼容新旧两种格式（对象或字符串）。
4. 两套主题 CSS 新增 `.ety-related-item` / `.ety-related-word` / `.ety-related-pos` / `.ety-related-zh` 样式。
5. 资源引用更新为 `v1.17.4`。

### v1.17.3（2026-08-21）· 知识卡新增「词根词缀」板块

1. 知识卡新增「词根词缀」板块：展示词根、前缀、后缀、词源简述、联想记忆口诀、同根词。
2. AI 提示词新增第 5 条要求，引导生成 etymology 对象；基础词汇（go, run 等）允许留空。
3. `normalizeKnowledge` 新增 etymology 字段解析与默认值兜底。
4. `missingFields` 新增 etymology 空值检测；`mergeFollowUp` 新增 etymology 合并逻辑。
5. 两套主题 CSS 均新增 `.ety-row` / `.ety-label` / `.ety-value` / `.ety-tip` 样式。
6. 资源引用更新为 `script.js?v=1.17.3`、`style.css?v=1.17.3`、`arknights.css?v=1.17.3`。
7. 旧缓存知识卡（无 etymology 字段）会显示"暂无词根词缀分析"，刷新可重新生成完整内容。

### v1.17.2（2026-08-21）· 修复知识卡词性丢失 + 补全逻辑失效

1. 修复 `missingFields` 不检查 meanings 中 `pos`（词性）是否为空的问题：AI 返回 `pos: ""` 时校验通过、直接缓存，补全提示词永远不触发。
2. 修复 `mergeFollowUp` 按 `pos+zh` 匹配失败时无降级：当第一次 pos 为空、补全结果 pos 为 `"n."` 时匹配不上，例句合并不进去；新增按索引降级匹配。
3. 补全提示词增加 `pos` 缺失的显式说明，引导 AI 重新生成完整 meanings 数组。
4. 资源引用更新为 `script.js?v=1.17.2`。

### v1.17.1（2026-08-21）· 知识页点击单词朗读

1. 知识页单词标题（`.kc-en`）支持点击朗读，复用已有 `speakEn()` TTS 逻辑。
2. 单词标题增加 `cursor: pointer` 视觉提示。
3. 资源引用更新为 `script.js?v=1.17.1`、`style.css?v=1.17.1`。

### v1.15.0（2026-08-19）· 单词听写复习

1. 学习概览页新增「听写复习」按钮（与「开始学习」并列）。
2. 听写模式：TTS 朗读待复习单词（到期词 + 难词池），用户手动拼写输入，回车检查。
3. 评分逻辑：一次拼对 = Good(3)；多次或用了例句提示 = Again(1)；看答案 = Again(1) + 难词池。
4. 例句提示：优先从 AI 知识缓存中随机取例句朗读；无缓存时调 AI 生成一句例句。
5. 答对或看答案后进入知识页（复用现有知识页组件，无"返回上一词"），下滑进入下一个听写词。
6. 听写完成自动回到概览页并保存数据。
7. 口音设置对听写朗读生效。
8. 听写页布局：左上退出、顶部"再次朗读单词"、"点击朗读例句"、中央输入框、底部"看答案"。

### v1.14.0（2026-08-19）· Piper TTS 本地语音

1. 语音引擎替换：Web Speech API → Piper TTS（树莓派本地运行），告别浏览器 TTS 质量差的问题。
2. 口音选择：设置面板新增「美音 / 英音」切换。
   - 美音：`en_US-lessac-medium`（Piper 模型，22050Hz，~60MB）
   - 英音：`en_GB-alan-medium`（Piper 模型，22050Hz，~60MB）
3. 架构：树莓派运行 Piper TTS HTTP 服务（`/opt/piper-tts/server.py`，端口 5000），Nginx 反代 `/api/tts` → 127.0.0.1:5000，浏览器 fetch 同源 API。
4. 前端 `speakEn()` 改为 fetch `/api/tts` 返回 WAV 用 `Audio` 播放；支持 AbortController 取消进行中的请求。
5. `initSpeech()` 清空（Piper 无需预热）；`exitStudy()` 改为停 `currentAudio`。
6. 数据结构：`accent` 字段（`'us'` / `'gb'`），默认 `'us'`。
7. 测试服务器新增 TTS mock 端点（返回最小有效 WAV），58 项断言全部通过。
8. 树莓派新增：`piper-tts.service`（systemd）、`/opt/piper-tts/server.py`、两个语音模型（`/home/pi/piper-voices/`）。
9. Nginx 配置新增 `location /api/tts` 反代（写在 `/api/` 之前，最长前缀匹配）。

### v1.13.0（2026-08-19）· 多用户数据隔离

1. 新增用户选择：首次打开页面显示用户选择覆盖层（"cet6" / "ielts"），选后才加载数据。
2. 数据按用户隔离：localStorage key 加用户名后缀（"cet6" 沿用原 key `cet6study.v1` 零迁移；"ielts" 用 `cet6study.v1.ielts`）；服务器同理。
3. 设置面板新增「当前用户 / 切换」，切换后清空 `currentUser` 并 reload 回到选择页。
4. 两个页面（首页仪表盘 + 学习模块）均支持用户选择与切换。
5. `server.py` `ALLOWED_KEYS` 新增 `cet6study.v1.ielts` / `cet6knowledge.v1.ielts`（需同步部署到树莓派）。
6. 端到端测试通过 `addInitScript` 预设用户 "cet6" 跳过选择覆盖层，58 项断言全部通过。
7. `shared/utils.js` 新增 API：`getCurrentUser` / `setCurrentUser` / `clearCurrentUser` / `getUserStorageKey` / `migrateOldStorage`；原 `STORAGE_KEY` / `KNOWLEDGE_KEY` 常量改为动态函数。

### v1.12.1（2026-08-17）· 点击单词 / 下滑评分映射对调

1. 按用户要求对调两个操作的 FSRS 映射：
   - 点击单词 = 记不清 → **Again(1) + 加入难词池**（对应“记不清→加入难词本”）；
   - 下滑 = 再练练 → **Hard(2)**（不进难词池），反馈文案由「不认识」改为「再练练」；
   - 上滑 = 记得 → Good(3) 不变。
2. 知识页顶部再上滑的修正随之改为 **Good → Again(1) + 难词池**（与“点击单词”完全一致）。
3. 旧数据迁移的 `lastQ` 换算同步对调：q1（不认识）→ Hard(2)，q2（记不清）→ Again(1)。
4. 修复撤销快照引用问题：`restoreApplied()` 恢复 `learnedIds / wrongIds` 时改为复制副本，避免“修正评分 → 返回上一词”过程中评分 push 污染快照数组导致错词表无法完全回滚。
5. 端到端测试更新并扩充至 58 项断言（含 Good→记不清 修正路径），全部通过。
6. 交接文档：根目录 `readme.md` 重写为 v1.12.1 完整交接手册；原始需求文档按用户命名保存在 `1.md`。

### v1.12.0（2026-08-17）· SM-2 全面迁移 FSRS（ts-fsrs 5.4.1）

1. 算法与数据结构：
   - 引入 ts-fsrs 5.4.1（本地打包 `shared/vendor/ts-fsrs-5.4.1.js`），适配层 `shared/fsrs-adapter.js`；
   - 调度只调用 `scheduler.next(card, now, rating)`，手写间隔公式全部删除；
   - 参数：`request_retention=0.9`、`enable_fuzz=true`、`maximum_interval=36500`、默认学习步骤 `1m/10m`；
   - `words[].fsrsCard` 保存 ts-fsrs Card（`due`/`last_review` 为 ISO 字符串；`state` 0=新词 1=学习中 2=复习中 3=重学中）；
   - 删除 SM-2 字段：`correctCount / wrongCount / consecutiveCorrect / lastMode / lastReviewDate / nextReviewDate / interval / easiness`；`lastQ` 改名为 `lastRating`（FSRS 1-4，仅用于错词优先与当日错词表）；`inHardPool` 保留（UI 层）。
2. 评分映射：
   - 上滑 = Good(3)；点击单词 = Hard(2) + 难词池；下滑 = Again(1)；知识页顶部再上滑 = Good → Hard；Easy 暂未接入手势。（⚠️ v1.12.1 已对调：点击=Again+难词池、下滑=Hard，以最新版为准）
3. 选词与统计：
   - 到期条件改为 `fsrsCard.due <= now`；新词 = `fsrsCard === null`；
   - 「已掌握」口径 = `fsrsCard.state === 2`（复习中）；列表排序用 stability；
   - 今日错词表、难词池、复习配额、返回上一词回滚逻辑全部保留（回滚现在恢复整个 `fsrsCard` 快照）。
4. 旧数据迁移：
   - 页面启动自动迁移：`normalizeStudyData()` 用 `memoryStateFromSm2(interval, ease)` 把旧状态换算成 Card，revision+1 并同步服务器；旧字段迁移后即删除；
   - 一次性脚本 `scripts/migrate-fsrs.mjs`：对 JSON 备份/导出文件执行同样迁移，输入已是 FSRS 格式时拒绝重写；
   - `memory_state_from_sm2` 属于 fsrs-rs，ts-fsrs 未内置；本项目按官方 Rust 实现移植（sm2_retention=0.9）。换算结果：stability=旧间隔，difficulty 由 easiness 反推，reps/lapses 用对错次数近似，精度不如原生 FSRS 积累。
5. 测试：`scripts/test-server.mjs`（本机假 API）+ `scripts/e2e-fsrs.mjs`（Playwright + Edge），52 项断言覆盖新词评分、Again/Hard、撤销、旧数据迁移、服务器同步、due 筛选、仪表盘。测试只连 `127.0.0.1:8810`，绝不连树莓派。
6. 文档：readme 第八章与 update 数据结构章节已改写为 FSRS 格式。

### v1.11.0（2026-08-16）· 返回上一词 + 复习算法修正 + 每日目标提醒

1. 学习页顶部新增「返回上一词」：
   - 正常前进到下一词后可见；点击后撤销上一词的评分（连同其后的评分一起回滚），回到该词重新标记；
   - 任务完成弹窗同样提供「返回上一词」，最后一词标错也能修正；
   - 撤销会完整恢复 `correctCount / wrongCount / interval / easiness / inHardPool / lastQ / 日期 / 当日计数 / 错词表 / 连对`，重新评分生成新快照，不会重复计数；
   - 知识页顶部“改为记不清”的修正也接入同一套快照，可再被“返回上一词”完整回滚。
2. 选词算法修正：
   - 修复难词池与到期复习池各自拿满复习配额的 bug（一组会超过每日目标），现在到期词、今日错词、难词池**共用**复习配额，总词数恒等于每日目标；
   - 词条新增 `lastQ`（最近一次评分），到期词中最近标错（1/2）的排在普通到期词之前；
   - 复习名额自动抬高：当“到期错词数”超过设定的复习比例时，错词占满复习名额并压缩新词，保证标错的词隔天全部回来；
   - 当天标错的词（`wrongIds`）在当天“再背一组”时优先重现；之后答对（4/5）即从当日错词表移除，避免整天反复出现。
3. 每日目标提醒与超额学习：
   - 达到目标那一刻 toast 提示“再背将计入超额”；
   - 完成弹窗显示「今日累计 / 目标（超 N）」并新增「再背一组」按钮，可连续超额学习；
   - 目标已达成后再次点“开始学习”，先弹「今日目标已达成」确认弹窗（每天一次，`goalRemindedDate` 记录），可选继续或休息。
4. 数据结构新增：`words[].lastQ`、`goalRemindedDate`；旧数据自动兼容（无 `lastQ` 视为非错词，无 `goalRemindedDate` 视为未提醒）。

### v1.11.1（2026-08-16）· 追问 AI 上下文 + 正常回答

1. 追问 AI 提示词取消「50-80 字、不超过 100 字」限制，改为：正常、准确地回答，不需要刻意精简，该详细就详细；与前面对话有关时结合上下文回答。
2. 每个单词在本次学习会话内维护独立对话历史（`S.aiChats[wordId]`，内存态，不落盘）：
   - 追问时发送 `system + 该词历史 + 新问题`，AI 带上下文回答；
   - 不同单词的上下文完全隔离；
   - 重新打开同一单词知识页会恢复显示其问答记录；换单词则显示空白；
   - 会话结束 / 重新开始学习时清空；
   - 生成失败时回滚刚写入的问题，保持上下文干净。
3. `max_tokens` 260 → 800；模型仍强制 `glm-4-flash`。

### v1.11.2（2026-08-16）· 返回上一词改为学习页顶部一行文字

1. 撤回控件按用户要求重做：在学习页（只显示一个单词的页面）顶部显示一行文字「点击返回上一个单词」，不再使用挤在 ✕ 旁的小按钮；
2. 点击后跳回上一个单词，该词恢复为未评分状态，可重新用手势标记；支持连续点击逐步向前回退（每点一次退一个词），第一词时自动隐藏；
3. 任务完成弹窗的按钮文案统一为「返回上一个单词」，用于修正最后一词；
4. 删除知识页顶部重复的单词标题（`kc-title`），知识页只保留内容区开头的单词 + 音标，顶部只剩 ✕ 与刷新；
5. 数据与撤销逻辑不变（仍完整恢复 SM-2 状态、当日计数、错词表、连对）。

### v1.11.3（2026-08-16）· 数据安全防护（含事故恢复）

1. 事故记录：一次自动化回归测试的 API 写入未完全隔离，测试词库覆盖了服务器上的真实学习数据；已从电脑浏览器 localStorage 快照恢复到 2026-08-15 进度（学过 49 词、累计 72 次、AI 缓存 57 条）。8 月 16 日当天新增进度未能找回。
2. 服务器防护：`server.py` 新增 `kv_history` 历史表，每次 PUT/DELETE 前自动备份旧值，每个 key 保留最近 **30** 份，可人工从 SQLite 回滚。
3. 客户端防覆盖：学习数据新增 `revision` 字段，每次 `saveData()` 自动 +1；启动同步时比较本地与服务器修订号，**高者生效**：
   - 服务器为空 → 本地上传；
   - 服务器版本更高 → 本地采用服务器；
   - 本地版本更高 → 本地保留并反推服务器（自愈，防止被重置/污染数据反向覆盖）。
4. 手动备份：设置页新增「导出备份 / 从备份恢复」，备份含学习进度、设置与 AI 知识缓存；恢复时会把 `revision` 提升为当前时间戳，确保备份优先于服务器旧数据。
5. 正式备份文件：`backups/study-backup-2026-08-16.json`（合并恢复后的完整数据）。

### v1.11.4（2026-08-16）· 返回上一词控件调整

1. 「点击返回上一个单词」移到学习页**最顶部**，与 ✕ 退出按钮同一行、同高（36px）；
2. 字号缩小为 0.76rem（小于顶栏按钮的 0.88rem），纯文字无背景；
3. 显示逻辑不变：第一词隐藏，从第二词起可见。

### v1.11.5（2026-08-16）· 修复朗读偶发无声

1. 加固 `speakEn()`（自动朗读与点击例句朗读共用）：
   - `cancel()` 后延迟一拍再 `speak()`，修复 Chrome/Android 上“取消后立即朗读被静默丢弃”；
   - 播放前 `resume()`，兼容 iOS；
   - 优先选择英文音色，初始化时预加载 `getVoices()`。
2. 朗读逻辑本身（自动读单词、点例句朗读）经本地回归验证调用正常。

### v1.10.0（2026-08-15）· 公网部署：Cloudflare Tunnel + 公网域名

1. 域名 `example.com` 的 DNS 托管从 DNSPod 迁移到 Cloudflare（注册商仍在腾讯云）：
   - NS 改为 `luke.ns.cloudflare.com` / `natasha.ns.cloudflare.com`；
   - 迁移记录：`@ AAAA`、`switch AAAA`（均为灰云「仅 DNS」，TTL 自动）；
   - `laptop` 的 `fe80::` 链路本地记录不迁移（公网本就不通）。
2. 树莓派安装 cloudflared 2026.8.2（arm64 deb），登录授权证书位于 `/home/pi/.cloudflared/cert.pem`。
3. 创建隧道 `stu`（ID `083c3c9e-13e1-44b4-be70-d5ee17bae441`），配置文件 `/home/pi/.cloudflared/config.yml`：
   - ingress：`example.com → http://127.0.0.1:80`；
   - 兜底规则：`http_status:404`。
4. DNS 路由：`cloudflared tunnel route dns stu example.com`（Cloudflare 侧自动创建 CNAME）。
5. systemd 服务 `cloudflared-stu.service`（User=pi，`cloudflared tunnel --config /home/pi/.cloudflared/config.yml run stu`，Restart=always），已 enable + 开机自启。
6. 访问地址：
   - 公网：`https://example.com`（Cloudflare 自动 HTTPS）；
   - 局域网：`http://192.168.1.10` 保持不变。
7. 已验证：首页与 `/api/health` 均通过公网链路返回 200；数据同步、AI、语音等前端逻辑无改动。
8. 待办：各 ddns-go 目前仍在更新 DNSPod。NS 完全生效后需把每台 ddns-go 的 DNS 服务商改为 Cloudflare（API Token + 对应域名），否则 `@` / `switch` 的 IPv6 变化后不会自动更新。

### v1.9.0（2026-08-15）· 数据存储升级为树莓派服务器 + 本地缓存

1. 架构从"纯 localStorage"升级为：
   - **树莓派 SQLite 为权威数据源**（`cet6study.v1` / `cet6knowledge.v1` 两个键值）；
   - 浏览器 localStorage 作为**镜像缓存**，离线仍可读写；
   - 页面打开时先从服务器同步；每次保存自动防抖推送到服务器（600ms）；失败保留待重试。
2. 新增后端 `server.py`（Python 标准库 + SQLite，无第三方依赖），监听 `127.0.0.1:8001`，提供 `GET/PUT/DELETE /api/state` 与 `GET /api/health`，由 Nginx 反代 `/api/`。
   - Nginx 需在 `/api/` 设置 `client_max_body_size 8m`（学习数据约 1.2MB，默认 1MB 会 413）。
3. 老用户数据自动迁移：服务器为空且本地有数据时，首次打开会把本地上传到服务器。
4. "清空全部数据"现在会同时删除本地与服务器数据。
5. 部署新增 systemd 服务 `study-api.service`，开机自启。

### v1.8.1（2026-08-15）· 修复新词抽样总是 a 开头

1. 根因：词库按字母序排列，旧逻辑先从 `fresh` 池**前 N 个**截取再洗牌，等于一直在 a 开头里选；
2. 修复：截取前先对整个新词池（和难词池）做全量洗牌，实现全词库随机抽样；
3. 到期复习词仍按 `nextReviewDate` 从早到晚排序（SRS 正确性优先），最后混合列表仍整体洗牌一次。

### v1.8.0（2026-08-15）· AI 知识生成稳定性增强

1. 明确架构隔离：每次知识生成都是**全新单条消息请求**，不携带任何历史对话，不存在上下文累积/占满问题；追问 AI 同样每次独立，不把之前的问答传回模型。
2. 知识生成 `temperature` 从 0.7 降到 **0.2**，结构化输出更稳定；
3. `max_tokens` 从 1100 提高到 **1600**，给变形/例句留足空间；
4. 新增完整性校验：解析成功后检查 `meanings`、每个释义的例句、`variants` 字段、`phrases` 字段；有缺失时自动发起一次**只补缺失字段**的跟进请求并合并，仍失败则保留已有内容，不阻塞学习。

### v1.7.4（2026-08-15）· 统一"页面方向"表述并修正手势逻辑

方向约定（以后统一按页面方向描述）：

- **上滑页面** = 手指下滑（内容向上走，往页面顶端去）；
- **下滑页面** = 手指上滑（内容向下走，往页面底端去）。

知识页最终手势规则：

1. 页面顶端 + 再次上滑页面 = 把当前词改为「记不清」并跳过（仅当该词刚被标为「记得」时才改；其余情况只跳过）；
2. 页面底端 + 再次下滑页面 = 直接跳过，不更改熟练属性；
3. 中间位置的上滑/下滑页面都只是普通滚动，不触发任何动作；
4. 桌面滚轮：顶端上滚 = 规则 1；底端下滚 = 规则 2。

### v1.7.3（2026-08-15）· 换词手势最终定稿

> 注：v1.7.3 的"手指下滑任意位置换词"已在 v1.7.4 改为"仅在顶端/底端的边界手势触发"，中间位置只滚动。

1. 删除"到底后再次上滑 = 下一词"手势；
2. 最终规则：**手指下滑 = 下一词**（顶部且刚标"记得"时先改为"记不清"）；手指上滑始终只是普通滚动，不触发任何动作；
3. 底部提示恢复为"手指下滑 = 下一词"。

### v1.7.2（2026-08-15）· 恢复"到底后再次上滑 = 下一词"

> 注：该手势在 v1.7.3 中按用户要求移除。

1. 恢复旧手势：知识页滚到底后，**手指再次上滑**也会跳下一词；
2. 两种换词手势并存：
   - 手指下滑 = 下一词（顶部且刚标"记得"时先改为"记不清"）；
   - 手指上滑到最底后再上滑 = 下一词；
3. 手指上滑在未到底时仍只是正常滚动阅读。

### v1.7.1（2026-08-15）· 修复知识页手势方向冲突

1. 修复恶性 bug：进入知识页后，手指上滑（正常向下滚动阅读）会被误判为"修正评分"；
2. 最新方向规则：
   - 手指上滑 = 正常向下滚动阅读，**永不触发**任何动作；
   - 手指下滑 = 跳下一词；若此时在页面顶部且该词刚被标"记得"，先改为"记不清"再跳下一词；
   - 桌面滚轮向上滚等效手指下滑。
3. 底部提示更新为"手指下滑 = 下一词"。

### v1.7.0（2026-08-15）· 知识页顶部可修正评分为「记不清」

> 注：v1.7.0 的触发手势是"顶部手指上滑"，与正常向下滚动手势冲突，已在 v1.7.1 改为"手指下滑"。

1. 场景：学习页上滑把单词标成「记得」（评分 5）后，进入知识页发现记错了，可以把该词评分撤回并改为「记不清」（评分 2），效果与直接点击单词完全一致（进入难词池、安排复习）；
2. 实现为**先回滚上一次评分**（correctCount/streak/dailyHistory/派生索引全部恢复），再按评分 2 重新记录，不会重复计数；
3. 该修正只对「本次会话中刚标为记得（q=5）」的词生效；直接点击=记不清、下滑=不认识的情况不需要修正；
4. 修正后知识页停留在当前词，可继续阅读；正常跳下一词仍是「滑到底再上滑」。

### v1.6.0（2026-08-15）· 知识页新增「单词变形」

1. 知识页在「中文释义」和「例句」之间新增「单词变形」区块（中等标题，居中）：
   - 每行格式：词性 + 变形词 + 中文释义（例如 `n. abandonment 放弃`）；
   - 没有变形时显示「无」。
2. 知识缓存结构升级到 v3，新增 `variants` 字段；
3. 缓存兼容策略：v2 与 v3 都视为有效缓存、不会自动重新生成。v2 旧缓存没有 variants 数据，会显示「无」，用户手动点「刷新」后会生成 v3 并补全变形信息。

### v1.5.0（2026-08-15）· 部署上线

部署到树莓派 5B（Debian 13 trixie，arm64）：

- SSH：`pi@192.168.1.10`
- Web 服务器：Nginx 1.26.3（systemd 开机自启）
- 网站目录：`/var/www/html`
- Nginx 站点配置：`/etc/nginx/sites-available/default`
- 局域网访问地址：`http://192.168.1.10`
- 配置要点：80 端口默认站点；`html/js/css/json` 响应头 `Cache-Control: no-cache`；gzip 开启。
- 后续更新代码：把新文件覆盖到 `/var/www/html`（保持目录结构），然后 `sudo systemctl reload nginx`（静态文件不需要 reload，但换了配置才需要）。

### v1.4.1（2026-08-15）

1. 学习页滑动评分扩展到**全屏**：上滑=记得、下滑=不认识，在学习页任意位置（按钮/输入框除外）都生效；
2. 点击操作保持不变：只有点击单词本身 = 记不清，点击其他空白位置不触发。

### v1.4.0（2026-08-15）

本轮改动：

1. 首页卡片排版优化：加大卡片高度、标题与描述留白、行高，右上角标签预留空间。
2. 学习概览统计修正：
   - 「已掌握」改为直接从 `words[].correctCount >= 3` 实时计算；
   - 「待复习」统计口径改为「今日到期 + 难词池」；
   - 退出学习页时立即写 localStorage 并刷新统计。
3. AI 知识缓存策略调整：**AI 生成过的单词永久缓存，不再自动重新生成**；只有用户手动点击「刷新」才重新生成。
4. 学习概览新增三个可点击统计卡片，点击查看明细列表：
   - 已掌握：单词 + 「答对 N 次」；
   - 待学习：未学习单词；
   - 待复习：单词 + SM-2 状态标注（今天复习 / N 天后复习 / 已逾期 N 天 / 难词池）；
   - 列表分页加载，每批 120 词。
5. 「记住了 / 不认识 / 记不清」反馈改为纯文字（无背景、无边框、无阴影）。
6. 知识页点击英文例句可朗读该句。

### v1.3.0（2026-08-15）

前端整体重做（极简方向）：

1. 删除全部 emoji。
2. 首页标题与日期居中、纵向排列；删除首页底部统计。
3. 页面切换增加缓动动画。
4. 学习页去卡片化：屏幕中央只显示「单词 + 音标」。
5. 交互调整：
   - 上滑 = 记得（SM-2 评分 5）；
   - 下滑 = 不认识（SM-2 评分 1）；
   - 点击单词 = 记不清（SM-2 评分 2，进难词池）。
6. 知识页去卡片化，纯文本排版，顺序固定为：
   - 单词 + 音标（居中）；
   - 中文释义（词性 + 释义，全部列出）；
   - 例句（每个释义各配一句，英文 + 中文）；
   - 短语组合（短语 + 中文释义）；
   - 追问 AI（SSE 流式输出，打字效果）。
7. 新增「纯色」主题，主题共三种：暖白 / 冷白 / 纯色（无渐变）。
8. AI 知识结构升级为 v2（见「知识缓存」章节）。

### v1.2.0（2026-08-15）

1. 修复移动端上下滑动被浏览器接管导致无法评分、下拉刷新的问题：
   - 卡片手势改为 touch 事件优先，`touchmove` 中 `preventDefault()`；
   - `touch-action: none` + `overscroll-behavior-y: none` 禁止学习页下拉刷新。
2. 允许未翻卡直接滑动评分。
3. 知识页「滑到底再滑 = 下一词」方向最终确定为：
   - **手势开始时已到底 + 手指继续上滑 = 下一词**；
   - 在底部手指下滑 = 往回翻浏览，不跳词。
4. 下一词切换改为并行动画（知识页淡出与下一词滑入同时进行）。
5. 点击单词 = 记不清后，先显示「记不清」反馈，再进入知识页。

### v1.1.0（2026-08-15）

1. 完成全部核心功能初版：仪表盘、学习概览、卡片学习、知识卡、AI 预生成与追问、SM-2、语音朗读、主题切换。
2. 内置词库 5407 词（词 + 音标 + 释义），来源为 ECDICT 中 `tag` 含 `cet6` 的词条（ECDICT 是 readme 指定 endict 的底层词典数据源）。
3. 修复选词补足时多取词、滑动后 click 误翻转两个 bug。
4. 新增 AI 返回 JSON 的自动修复与自动重试：
   - 请求加 `response_format: {"type":"json_object"}`；
   - 本地修复尾逗号、漏逗号等常见瑕疵；
   - 仍失败则带原文让模型修正重试一次。

### v1.0.0（2026-08-15）

按 readme.md 完成项目初版，文件结构见下。

---

## 文件结构

```
/ (项目根目录)
├── index.html                  # 功能仪表盘
├── readme.md                   # 原始需求文档（定稿）
├── update.md                   # 本文档：更新日志 + 数据结构
├── server.py                   # 数据同步后端（树莓派 /opt/study-api/server.py）
├── shared/
│   ├── global.css              # 全局样式、主题变量、通用组件
│   ├── utils.js                # 通用工具：存储/服务器同步、日期、词库加载、统计、主题
│   ├── fsrs-adapter.js         # FSRS 适配层：scheduler / Card 序列化 / SM-2→FSRS 迁移
│   └── vendor/
│       └── ts-fsrs-5.4.1.js    # ts-fsrs 5.4.1 UMD 构建（本地打包，含 LICENSE）
├── modules/
│   └── vocabulary/
│       ├── index.html          # 学习概览 + 学习页 + 知识页骨架
│       ├── style.css           # 背单词模块样式
│       └── script.js           # 模块逻辑：FSRS + 选词 + 手势 + AI + 语音
├── scripts/
│   ├── migrate-fsrs.mjs        # 一次性迁移脚本（SM-2 JSON → FSRS）
│   ├── test-server.mjs         # 本地假 API 服务器（测试专用，不连树莓派）
│   └── e2e-fsrs.mjs            # Playwright 端到端测试
└── words/
    └── cet6.json               # 内置六级词库（5407 词）
```

树莓派上的部署布局：

```
/var/www/html                  # 前端静态文件（Nginx root）
/opt/study-api/server.py       # 数据同步后端
/var/lib/study-api/state.db    # SQLite 权威数据
/etc/nginx/sites-available/default  # Nginx：静态 + /api/ 反代 127.0.0.1:8001
/etc/systemd/system/study-api.service  # 后端 systemd 服务
```

架构约定：**服务器为权威数据源，浏览器 localStorage 为镜像缓存**；离线可用，联网自动同步。

---

## 数据结构

数据分为两类：**权威数据**（树莓派 SQLite）与**浏览器镜像缓存**（localStorage）。两者结构完全相同：

| Key | 用途 |
|---|---|
| `cet6study.v1` | 学习进度、设置、词条状态（FSRS，v1.12.0 起） |
| `cet6knowledge.v1` | AI 生成的知识内容缓存 |
| （无 key）`words/cet6.json` | 内置词库文件，首次使用时读入 `cet6study.v1.words` |

同步规则（`shared/utils.js`）：

- 页面启动 `Utils.initStorage()`：GET 服务器两个 key；有值则覆盖本地；服务器为空而本地有值则上传（老数据迁移）；
- 每次 `saveData()` / `saveKnowledge()`：先写 localStorage，再防抖 600ms PUT 到服务器；
- 请求失败不阻塞：保留待推送，下一次保存时自动重试；
- `Utils.clearAllStorage()`：DELETE 服务器两个 key + 清空本地。

服务器端（`server.py`）SQLite 表：

```sql
CREATE TABLE kv (
  key TEXT PRIMARY KEY,          -- 'cet6study.v1' 或 'cet6knowledge.v1'
  value TEXT NOT NULL,           -- JSON 字符串
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### 1. 主数据 `cet6study.v1`

```javascript
{
  version: 2,                    // 主数据结构版本（v2 = FSRS；v1 旧 SM-2 数据加载时自动迁移）
  algorithm: "fsrs",             // 调度算法标识

  // 全量词条。内置词库首次加载时生成，导入 txt 时追加。
  // 调度状态集中在 fsrsCard，其余是 UI/会话层字段：
  words: [
    {
      id: 0,                     // 词条唯一 ID，等于加入时的数组下标
      en: "abandon",             // 英文
      zh: "放弃；抛弃；遗弃；使屈从",   // 中文释义（内置词库已去词性，AI 知识页会补词性）
      phonetic: "ə'bændən",      // 音标（原样，不含斜杠，展示时包 /.../）

      // ---- FSRS 调度状态（由 ts-fsrs scheduler.next 直接回写） ----
      fsrsCard: {                // 新词为 null；第一次评分时 createEmptyCard()
        due: "2026-08-18T04:00:00.000Z",   // 下次复习时间（ISO 字符串；到期条件 due <= now）
        stability: 6.9,          // 稳定期（天）
        difficulty: 5.3,         // 难度 1 ~ 10
        elapsed_days: 0,
        scheduled_days: 6,
        learning_steps: 0,
        reps: 3,                 // 累计复习次数
        lapses: 0,               // Review 状态下 Again 的次数
        state: 2,                // 0=新词 1=学习中 2=复习中 3=重学中
        last_review: "2026-08-17T04:00:00.000Z"   // 上次复习时间（ISO 字符串）
      },

      // ---- UI / 会话层字段（不参与调度计算） ----
      lastRating: 0,             // 最近一次 FSRS 评分 1-4（1/2 = 错词，选词时优先复习）
      inHardPool: false          // 是否在难词池（点“记不清”Again 置 true；Good 及以上置 false）
    }
  ],

  // ---- 派生索引（加载时由 words 重建，不要手工修改） ----
  learnedIds: [0, 3, 5],         // 已掌握词 ID 列表（fsrsCard.state === 2 复习中）
  wrongIds: [],                  // 今日错词 ID 列表（评分 1/2 加入，3/4 移出，每日重置）

  // ---- 设置 ----
  dailyGoal: 30,                 // 每日目标词数（1 ~ 300）
  newRatio: 0.7,                 // 新词/复习比例（0 ~ 1，默认 0.7 = 70% 新词）
  apiKey: "",                    // v1.19.0 起用户自行填写，不再有内置默认 Key
  theme: "warm",                 // "warm" 暖白 / "cool" 冷白 / "solid" 纯色；null = 尚未选择

  // ---- 每日统计 ----
  sessionDate: "2026-08-15",     // 当前会话日期，用于跨天重置
  consecutiveDays: 5,            // 连续学习天数
  dailyHistory: {                // K 线图数据：日期 -> 当日完成的答题次数
    "2026-08-09": 25,
    "2026-08-10": 30
  },
  goalRemindedDate: "",          // 最近一次弹出“目标已达成”确认的日期（每天一次）
  revision: 42                   // 数据修订号：每次 saveData() +1，本地/服务器高者生效
}
```

字段维护注意：

- 旧 v1 数据（含 SM-2 字段）在 `Utils.normalizeStudyData()` 中自动迁移：用 `memoryStateFromSm2(interval, ease)` 生成 Card 后删除全部 SM-2 字段；页面启动检测到迁移会立即 `saveData()` 并同步服务器。
- 迁移换算只执行一次；不要在业务代码里再读写任何 SM-2 字段。
- `learnedIds` 会在 `Utils.loadData()` 时通过 `syncDerived()` 从 `words` 重建，保证统计永远和真实词条一致。
- `wrongIds` 在跨天时清空。
- `dailyHistory[today]` 在每次评分时 +1（同一词重复答题也计数，用于体现当日学习量）。
- 修改主数据结构时，请同步改 `shared/utils.js` 的 `defaultStudyData()` 和 `loadData()`。

### 2. AI 知识缓存 `cet6knowledge.v1`

以「单词英文（小写）」为 key 的对象：

```javascript
{
  "abandon": {
    v: 3,                        // 知识结构版本；当前 v3（v2 仍兼容读取）
    en: "abandon",               // 英文（冗余保存，便于展示）
    zh: "放弃；抛弃；遗弃；使屈从",   // 词库释义（冗余保存）
    phonetic: "ə'bændən",        // 音标（冗余保存）

    // 中文释义：每个义项一条，词性 + 释义 + 对应例句
    meanings: [
      {
        pos: "v.",               // 词性缩写：n. / v. / vt. / vi. / adj. / adv. / prep. 等
        zh: "放弃",              // 单个中文释义
        exampleEn: "She abandoned her dream.",
        exampleZh: "她放弃了自己的梦想。"
      }
    ],

    // 单词变形：变形词 + 词性 + 中文释义；没有变形时是空数组
    variants: [
      { "word": "abandonment", "pos": "n.", "zh": "放弃" },
      { "word": "abandoned", "pos": "adj.", "zh": "被抛弃的" }
    ],

    // 短语组合：短语 + 中文释义
    phrases: [
      { "en": "abandon hope", "zh": "放弃希望" }
    ],

    generatedAt: "2026-08-15T10:30:00.000Z"   // 生成时间（ISO 字符串）
  }
}
```

缓存策略（v1.4.0 起，v1.6.0 修订）：

- `v === 2` 或 `v === 3` 的缓存**永久有效**，不再按时间过期；
- 打开知识页 / 预生成队列看到已有缓存时，**直接使用，不再调用 AI**；
- 只有用户点击知识页右上角「刷新」时，才强制重新生成并覆盖缓存（新生成内容为 v3）；
- v1 及更早缓存视为无效，遇到时会自动重新生成一次并覆盖；
- v2 旧缓存没有 `variants` 字段，知识页「单词变形」会显示「无」；手动刷新后生成 v3 补全。

### 3. 内置词库 `words/cet6.json`

```javascript
[
  { "en": "abandon", "phonetic": "ə'bændən", "zh": "放弃；抛弃；遗弃；使屈从" },
  { "en": "abbreviation", "phonetic": "ə.bri:vi'eiʃən", "zh": "缩写词；缩写；缩短；节略" }
  // ... 共 5407 条
]
```

- 来源：ECDICT 中 `tag` 含 `cet6` 的词条（2016 版四六级考试大纲口径），约 5407 词。
- `zh` 已清洗：去掉词性前缀和网络释义，多个义项用中文分号 `；` 连接，最多保留 4 个。
- 首次打开任意页面时由 `Utils.ensureWordBank()` 读入并转成 `words[]` 存入主数据。
- 导入 txt 格式：每行 `英文 - 中文`，解析后追加到 `words[]`（音标为空）。

---

## 当前交互规则（v1.12.1）

### 学习页（单词 + 音标居中，无卡片无提示）

| 操作 | 含义 | FSRS 评分 | 后续 |
|---|---|---|---|
| 手指上滑 | 记得 | Good (3) | 反馈「记住了」→ 知识页 |
| 手指下滑 | 再练练 | Hard (2) | 反馈「再练练」→ 知识页 |
| 点击单词 | 记不清 | Again (1) + 难词池 | 反馈「记不清」→ 知识页 |

- 滑动手势以整个学习页为感应区域；按钮、输入框、链接位置除外（避免误触退出按钮）。
- 学习页手势方向：以**手指移动方向**为准；阈值 50px。
- 顶部状态：左侧「✕ 退出」，右上「连对 N」（Good 及以上 +1，Hard/Again 清零）。
- 顶部「刷新」按钮仅在知识页打开时出现。
- 下次复习时间完全由 `FSRSAdapter.next(card, now, rating)` 计算并回写，无手写公式。

### 知识页

方向约定（按**页面方向**描述）：

- 上滑页面 = 手指下滑（内容向上走）；
- 下滑页面 = 手指上滑（内容向下走）。

1. 从顶部开始展示，内容顺序：单词+音标 → 中文释义 → 单词变形 → 例句 → 短语组合 → 追问 AI。
2. 点击任意英文例句朗读该句。
3. 追问 AI：SSE 流式输出，逐字显示；回答不落盘。
4. 进入下一词：
   - **页面顶端 + 再次上滑页面**：若该词刚被标「记得」，先改为「记不清」（Again(1)，进难词池）再进入下一词；其余情况直接进入下一词；
   - **页面底端 + 再次下滑页面**：直接进入下一词，不改熟练度；
   - 中间位置上滑/下滑页面都只是普通滚动。
5. 修正评分只回滚本次评分，不重复计数（实现见 v1.7.0/v1.7.4）。

### FSRS 评分映射（v1.12.1）

| Rating | 来源 | 说明 |
|---|---|---|
| 3 Good | 上滑=记得 | 稳定期增长 |
| 2 Hard | 下滑=再练练 | 记得不牢 |
| 1 Again | 点击=记不清 | 遗忘；加入难词池 |
| 4 Easy | （未接入手势） | 以后可用长按/双击补充 |

- 调度参数：`request_retention=0.9`、`enable_fuzz=true`、`maximum_interval=36500`、学习步骤 `1m/10m`。
- 每次评分调用 `scheduler.next(card, now, rating)`，库返回的新 Card 直接序列化回存。
- `fsrsCard.state === 2`（复习中）计入「已掌握」；FSRS 没有 mastered 状态。
- Rating >= 3 时难词池移除；1/2 加入当日错词表（`wrongIds`）。

### 每日选词顺序

1. 到期复习词（`fsrsCard.due <= now`），错词（lastRating 1/2）优先，再按 due 从早到晚；
2. 难词池（`inHardPool === true`），全池随机抽取；
3. 新词（`fsrsCard === null`），**全池随机抽取**（词库字母序，必须先洗牌再截取）。

按 `dailyGoal` 和 `newRatio` 分配配额（到期词、今日错词、难词池共用复习配额），最后复习词 + 新词整体随机打乱。

---

## AI 接口约定

- 地址：`https://open.bigmodel.cn/api/paas/v4/chat/completions`
- 模型：**`glm-4-flash`（强制，永远不要改成其他模型）**
- 隔离性：每次知识生成和每次追问都是**独立的新请求**，消息数组只包含当前任务一条内容，不携带历史对话；不存在上下文累积问题。
- 知识生成：非流式 + `response_format: {"type":"json_object"}` + `temperature: 0.2` + `max_tokens: 1600`，请求体结构见 `script.js / fetchKnowledge()`。
- 完整性校验：解析成功后检查 `meanings` / 每个释义的例句 / `variants` 字段 / `phrases` 字段；缺失时自动发起一次针对性补全并合并。
- 追问 AI：`stream: true` + `temperature: 0.7`，SSE 解析 `data:` 行，读取 `choices[0].delta.content` 增量。
- JSON 容错：剥离代码块围栏 → 修复尾逗号/漏逗号 → 失败自动重试一次。
- 返回结构依赖 `meanings[]`、`variants[]`、`phrases[]`；旧缓存按 `v` 版本兼容读取。

## 主题变量

| 主题 | `data-theme` | 背景 | 说明 |
|---|---|---|---|
| 暖白 | `warm` | `#f5f0eb` | 默认 |
| 冷白 | `cool` | `#f0f2f5` | 默认 |
| 纯色 | `solid` | `#f2f4f7` | 无渐变，主色单色 `#3d8bdb` |

主题由 `Utils.applyTheme()` 写 `document.documentElement.dataset.theme`，CSS 变量定义在 `shared/global.css`。

---

## 维护提示

- 前端保持**无 emoji、无框架、纯静态**；不要引入构建工具或后端依赖。
- 移动端手势依赖 touch 事件 + `preventDefault()`，`touch-action` / `overscroll-behavior` 已在 CSS 中设置，修改时不要删掉，否则会复现下拉刷新 bug。
- 所有页面路径必须保持相对路径，否则树莓派 + 域名部署后会 404。
- 修改数据结构必须同时升级主数据 `version` 或知识缓存 `v`，并写明迁移逻辑，避免旧用户数据损坏。
- localStorage 容量约 5MB；主数据约 1.2MB，知识缓存按词条增长，当前策略下可控。
