# 树莓派学习小站 · 手机端 App（Capacitor Android）

把现有网站**全部内容**打包成真正的安卓 App（可安装、可分享 APK）。
**核心保证：网页断网也能背单词（离线词库已内置）**——`words/cet6.json`、`words/ielts.json`
随 App 一起打进 `web/` 资源包，即使完全没有网络也能：选词、翻转卡片、FSRS 间隔重复、
听写复习、进度统计全部正常。

> 📦 **APK 是构建产物（不入版本库）**：按下方「构建 APK」产出的
> `android/app/build/outputs/apk/debug/app-debug.apk` 拷贝到安卓手机即可安装
> （需允许“安装未知来源应用”）。若要正式分发请改用 release 签名。
>
> 📌 **完全本地优先**：当前 App **默认不连任何外部服务器**（断网不受影响）。
> 学习进度存在手机本地（localStorage + IndexedDB），词库内置。

## 品牌：图标 & 启动动图

- **App 桌面图标**：`icons/icon-512-maskable.png`。已在构建时按安卓各密度
  （mdpi 48 / hdpi 72 / xhdpi 96 / xxhdpi 144 / xxxhdpi 192）生成 `ic_launcher` /
  `ic_launcher_round` / `ic_launcher_foreground`，写入
  `android/app/src/main/res/mipmap-*/`。
- **启动画面**：`start.webp`（1080×1920 动画图）。App 启动时在应用内启动页
  （`index.html` 的 `.app-splash-img`）播放该动图，随后淡出。
- 两者都由 `scripts/pack-web.mjs` 一起打进 `web/`，随 `npx cap sync android` 进入 APK。

## 发音（TTS）——安卓系统 TTS（稳定可靠）

- 使用 **安卓系统 TTS**（`@capacitor-community/text-to-speech` → `android.speech.tts`），
  绝大多数手机开箱即用、可靠出声；Web Speech（`speechSynthesis`）作为兜底。
- 发音顺序：**系统 TTS → Web Speech 兜底**（见 `modules/vocabulary/script.js` 的
  `speakEnLocal` / `speakNative`）。
- 完全离线、不依赖网络；音质取决于手机当前安装的 TTS 引擎（可在系统设置里更换更自然的引擎）。
- ⚠️ 曾尝试内置离线神经网络语音（sherpa-onnx + VITS，包体 ~119MB），但在真机上会闪退，
  为稳定起见已**移除**该原生插件路径，沿用系统 TTS。

## 目录结构

```
mobile-app/
├── package.json            # Capacitor 依赖 + 构建脚本
├── capacitor.config.json   # appId / appName / webDir（web/）——已用，无 TS 依赖
├── web/                    # 由 pack-web 生成：完整网站 + 离线词库（可重复构建）
├── scripts/
│   ├── pack-web.mjs        # 复制主站资源到 web/ 并注入在线同步基址
│   ├── verify-offline.mjs  # 离线词库验证（起本地服务 + 断网重载断言）
│   └── serve.mjs           # 本地预览
├── android/                # 已生成的原生安卓工程（Capacitor 6，SDK 34）
├── verify-out/             # 离线验证截图与结果日志
└── README.md
```

`android/` 已生成并把 `web/` 同步进 `android/app/src/main/assets/public/`（含离线词库），
不需要再 `npm install && npx cap add android`，直接打开就能编译。

## 构建 APK

前置要求：

- **Android SDK（platform 34 + build-tools）**——`ANDROID_HOME` 已设置，或用 Android Studio 自带 SDK。
  本仓库机器上**未安装 Android SDK**，因此在这里无法产出 APK 二进制。
- **JDK 17**（Capacitor 6 的 Gradle wrapper 是 8.2.1，不支持 JDK 25）。

### 方式 A：Android Studio（推荐，最省事）

1. 用 Android Studio 打开 `mobile-app/android`（Android Studio 自带 JDK 17 与 Android SDK）。
2. 顶部菜单 **Build → Build APK(s)**。
3. 生成 `mobile-app/android/app/build/outputs/apk/debug/app-debug.apk`，拷贝到手机安装即可
   （需允许“安装未知来源应用”）。

### 方式 B：命令行（有 JDK 17 + SDK 的机器）

```bash
cd mobile-app
npm install
# 若没生成 android/（本仓库已生成，可跳过）：
npx cap add android
# 同步资源 + 编译：
npx cap sync android
cd android
./gradlew.bat assembleDebug        # Windows
# ./gradlew assembleDebug          # macOS / Linux
```

APK 产物同上 `app-debug.apk`。

> 若机器只有 JDK 25：`android/gradle/wrapper/gradle-wrapper.properties` 固定 Gradle 8.2.1，
> 无法在 JDK 25 上启动，请用 Android Studio（自带 JDK 17）构建，不要盲目升级 Gradle/AGP
> （会与 Capacitor 6 的插件配置冲突）。

## 离线词库是怎么实现的

- 主站本身是 PWA（`sw.js` + `manifest.webmanifest`），已把词库预缓存。
- App 更进一步：`pack-web` 把 `words/cet6.json`、`words/ielts.json` 直接复制进
  `web/words/`，作为 App 内置静态资源随 APK 一起发布。
- 原生 WebView 以 `https://localhost` 加载本地打包资源，不依赖网络，所以
  **首装即离线，无需联网“先下载一遍词库”**。主站上 `utils.js` 的
  `fetch('words/xxx.json')` 会命中这些内置文件。
- 验证脚本 `verify-offline.mjs` 实测：断网后经 Service Worker 缓存重载，
  词库统计仍为 `0 / 5407`（5407 词）——离线单词数据可用（见 `verify-out/result.log`）。

## 知识缓存存哪（不受 localStorage 5MB 限制）

- **AI 知识缓存**（例句/变形/词根/短语，会随背词不断增长）改为 **IndexedDB** 持久化
  （数据库 `wordexcite-db`，object store `knowledge`），本地不再有 5MB 上限；写入即落库，跨重载保留。
- 旧版本放在 localStorage 里面的知识缓存，启动时会**自动一次性迁移**进 IndexedDB 后清掉旧 key。
- 学习进度/词库（很小，几千 KB 内）仍用 localStorage，永远撞不上 5MB，不动。
- 验证脚本 `scripts/verify-idb.mjs`：`IDB-PERSIST-OK: YES`（写入 IndexedDB、非 localStorage、重载后仍在）。

## 在线同步（可选，默认关闭）

默认 `SERVER_BASE = ''` → **完全本地优先**：App 不向任何外部服务器发请求，
学习、词库、进度全在手机本地，最快的启动、零外部依赖。

将来树莓派恢复后，如需重新启用在线同步与 TTS：

1. 把 `scripts/pack-web.mjs` 顶部的 `SERVER_BASE` 改成 `'https://example.com'`（或局域网 `'http://192.168.1.10'`）。
2. 重新 `npm run pack-web && npx cap sync android`，再打包安装。

启用后，`fetch('/api/...')` 会通过注入的 `window.APP_API_BASE` 指向服务器：
`/api/state`、`/api/knowledge`、`/api/tts` 统一同步；断网时自动落到本地缓存
（`initStorage` / `flushPush` 本来就有离线降级）。AI 追问走外部模型接口，与服务器无关。

> ⚠️ 跨域同步要求树莓派后端对 App 产地（`https://localhost`）放开 CORS
> （`Access-Control-Allow-Origin: *`）。未放开时 App 仍可**完整离线学习**，
> 只是联网同步/TTS 会被浏览器拦住。这属于服务器侧配置，不进本仓库代码。

## 修改服务器地址

编辑 `scripts/pack-web.mjs` 顶部的 `SERVER_BASE`，重新 `npm run pack-web && npx cap sync android`。

## 重新打包（后续升级主站）

```bash
cd mobile-app
npm run pack-web && npx cap sync android
```

`pack-web` 每次先清空再重建 `web/`，保证和主站一致；`cap sync` 把最新 `web/` 拷进
`android/app/src/main/assets/public`。
