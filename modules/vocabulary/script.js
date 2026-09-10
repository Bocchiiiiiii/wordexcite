/* ============================================================
 * 六级背单词模块 · 完整逻辑
 * FSRS 间隔重复（ts-fsrs scheduler.next） + 选词 + 卡片手势 + 知识卡 + 智谱 API + 语音
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  var FEEDBACK_MS = 500;                // 记住了/再练练反馈时长
  var SWIPE_THRESHOLD = 50;             // 手势阈值
  var PREGEN_CONCURRENCY = 2;           // 预生成并发数
  var GRADE = window.FSRSAdapter.Grade; // Again=1 / Hard=2 / Good=3 / Easy=4

  function $(id) { return document.getElementById(id); }

  /* ---------------- 会话状态（内存，不落盘） ---------------- */
  var S = {
    data: null,
    list: [],            // 本次会话的单词 id 列表
    index: 0,
    knowledgeOpen: false,
    fullCard: false,
    streak: 0,
    aiChats: {},         // 追问 AI 上下文：wordId -> [{role, content}]，不同单词互相隔离
    pregenToken: 0,
    busyRefresh: false,
    busyAI: false
  };

  var inflight = new Map();      // 防止同一单词重复请求
  var markThinkButtons = null;   // v1.24.0 深度思考开关的高亮刷新（设置面板打开时调用）
  var _wordById = null;          // id -> word 映射（惰性构建，避免 O(n) 线性查找）
  var saveTimer = null;
  var suppressClickUntil = 0;    // 滑动手势后短时间内忽略鼠标 click
  var overlayHideTimer = null;   // 知识卡退场计时器（与下一词入场并行）
  var wordListState = { type: '', items: [], shown: 0, chunk: 120 };
  var lastApplied = null;        // 当前词最近一次评分快照，用于“改为记不清”时回滚
  var appliedStack = [];
  var dictState = null;          // 听写状态：{ list, index, attempts, hintUsed }         // 本次会话全部评分快照（按评分顺序），支持“返回上一词”撤销

  function currentWord() {
    if (!_wordById) _buildWordMap();
    return _wordById[S.list[S.index]] || null;
  }

  function _buildWordMap() {
    _wordById = {};
    for (var i = 0; i < S.data.words.length; i++) {
      _wordById[S.data.words[i].id] = S.data.words[i];
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { Utils.saveData(S.data); }, 150);
  }

  /* ================= 初始化 ================= */

  async function init() {
    /* 用户未选择时等待覆盖层 */
    if (!Utils.getCurrentUser()) {
      var overlay = document.getElementById('userSelectOverlay');
      overlay.querySelectorAll('[data-user]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          Utils.setCurrentUser(btn.getAttribute('data-user'));
          document.body.classList.add('user-selected');
          doInit();
        });
      });
      return;
    }
    document.body.classList.add('user-selected');
    await doInit();
  }

  async function doInit() {
    /* 完全离线：直接读取本机缓存（无服务器同步） */
    await Utils.initStorage().catch(function () { /* 离线时使用本地缓存 */ });
    S.data = Utils.loadData();
    if (S.data.__fsrsMigratedCount) {
      var migrated = S.data.__fsrsMigratedCount;
      Utils.saveData(S.data);   // 立即落盘并同步服务器；saveData 会剥掉迁移标记
      Utils.toast('已把 ' + migrated + ' 条 SM-2 记录迁移为 FSRS 卡片', 'success');
    }
    Utils.ensureThemeChosen(S.data);
    try {
      await Utils.ensureWordBank(S.data);
    } catch (err) {
      Utils.toast(err.message || '词库加载失败，请通过 HTTP 服务器打开页面', 'error');
    }
    /* 根据词库更新页面标题 */
    var titleMap = { 'ielts.json': '雅思词汇', 'cet6.json': '六级背单词' };
    var title = titleMap[S.data.wordBank] || '背单词';
    document.title = title + ' · 四人帮的学习小站';
    var el = document.getElementById('pageTitle');
    if (el) el.textContent = title;

    renderOverview();
    bindEvents();
  }

  function bindEvents() {
    /* -------- 概览页 -------- */
    $('startBtn').addEventListener('click', startLearning);
    $('cardMastered').addEventListener('click', function () { openWordList('mastered'); });
    $('cardNew').addEventListener('click', function () { openWordList('new'); });
    $('cardDue').addEventListener('click', function () { openWordList('due'); });
    $('wordListClose').addEventListener('click', closeWordList);
    $('wordListMore').addEventListener('click', renderWordListMore);
    /* 添加难词 */
    $('wordListAdd').addEventListener('click', function () {
      $('wordListAddRow').classList.toggle('hidden');
      if (!$('wordListAddRow').classList.contains('hidden')) $('wordListAddInput').focus();
    });
    $('wordListAddCancel').addEventListener('click', function () {
      $('wordListAddRow').classList.add('hidden');
      $('wordListAddInput').value = '';
    });
    $('wordListAddConfirm').addEventListener('click', addCustomWord);
    $('wordListAddInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') addCustomWord();
    });
    $('wordListModal').addEventListener('click', function (e) {
      if (e.target === this) closeWordList();
    });
    $('dailyGoalInput').addEventListener('change', function () {
      var v = Utils.clamp(parseInt(this.value, 10) || 30, 1, 300);
      this.value = v;
      S.data.dailyGoal = v;
      Utils.saveData(S.data);
      renderOverview();
      Utils.toast('每日目标已设为 ' + v + ' 词', 'success');
    });
    $('newRatioSlider').addEventListener('input', function () {
      S.data.newRatio = (parseInt(this.value, 10) || 70) / 100;
      renderRatioLabel();
      scheduleSave();
    });
    $('ovThemeWarm').addEventListener('click', function () {
      Utils.chooseTheme(S.data, 'warm'); markThemeButtons();
    });
    $('ovThemeCool').addEventListener('click', function () {
      Utils.chooseTheme(S.data, 'cool'); markThemeButtons();
    });
    $('ovThemeSolid').addEventListener('click', function () {
      Utils.chooseTheme(S.data, 'solid'); markThemeButtons();
    });
    $('apiKeyInput').addEventListener('change', function () {
      S.data.apiKey = this.value.trim();
      Utils.saveData(S.data);
      Utils.toast('API Key 已保存', 'success');
    });
    if ($('aiUrlInput')) $('aiUrlInput').addEventListener('change', function () {
      S.data.aiUrl = this.value.trim();
      Utils.saveData(S.data);
      Utils.toast('AI URL 已保存', 'success');
    });
    if ($('aiModelInput')) $('aiModelInput').addEventListener('change', function () {
      S.data.aiModel = this.value.trim();
      Utils.saveData(S.data);
      Utils.toast('模型名称已保存', 'success');
    });
    /* AI 模型列表（v1.22.0）：点按钮拉取（OpenAI 兼容 GET /models），点条目即选用，也可手输 */
    (function () {
      var btn = $('fetchModelsBtn');
      var listEl = $('aiModelList');
      var modelEl = $('aiModelInput');
      if (!btn || !listEl || !modelEl) return;
      btn.addEventListener('click', function () {
        var url = $('aiUrlInput') ? $('aiUrlInput').value.trim() : '';
        var key = $('apiKeyInput') ? $('apiKeyInput').value.trim() : '';
        if (!url) { Utils.toast('请先填写 API Base URL', 'error'); return; }
        btn.disabled = true;
        btn.textContent = '获取中…';
        Utils.fetchAIModels(url, key).then(function (list) {
          S.data.aiUrl = url;
          S.data.apiKey = key;
          Utils.saveData(S.data);
          listEl.innerHTML = '';
          var cur = modelEl.value.trim();
          list.forEach(function (id) {
            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'ai-model-item' + (cur === id ? ' active' : '');
            item.textContent = id;
            item.addEventListener('click', function () {
              modelEl.value = id;
              S.data.aiModel = id;
              Utils.saveData(S.data);
              Array.prototype.forEach.call(listEl.children, function (c) {
                c.classList.remove('active');
              });
              item.classList.add('active');
              Utils.toast('已选择模型 ' + id, 'success');
            });
            listEl.appendChild(item);
          });
          listEl.classList.remove('hidden');
          listEl.scrollTop = 0;
          Utils.toast('共 ' + list.length + ' 个模型，点选即可', 'success');
        }).catch(function (err) {
          listEl.classList.add('hidden');
          Utils.toast((err && err.message) ? err.message : '获取模型列表失败', 'error');
        }).then(function () {
          btn.disabled = false;
          btn.textContent = '获取模型列表';
        });
      });
    })();
    /* AI 人设（追问问答）：两个预设 + 自定义输入 */
    var personaInput = $('aiPersonaInput');
    if (personaInput) {
      personaInput.addEventListener('change', function () {
        S.data.aiPersona = this.value.trim();
        Utils.saveData(S.data);
        Utils.toast('AI 人设已保存', 'success');
      });
      $('personaCat').addEventListener('click', function () {
        var p = Utils.personaPreset('cat');
        personaInput.value = p;
        S.data.aiPersona = p;
        Utils.saveData(S.data);
        Utils.toast('人设已设为可爱猫娘', 'success');
      });
      $('personaBro').addEventListener('click', function () {
        var p = Utils.personaPreset('bro');
        personaInput.value = p;
        S.data.aiPersona = p;
        Utils.saveData(S.data);
        Utils.toast('人设已设为暴躁老哥', 'success');
      });
    }
    /* 深度思考开关（v1.24.0） */
    (function () {
      var off = $('thinkOff'), on = $('thinkOn');
      if (!off || !on) return;
      markThinkButtons = function () {
        var isOff = S.data.aiNoThink !== false;
        off.style.borderColor = isOff ? 'var(--grad-a)' : '';
        on.style.borderColor = isOff ? '' : 'var(--grad-a)';
      };
      markThinkButtons();
      off.addEventListener('click', function () {
        S.data.aiNoThink = true; Utils.saveData(S.data); markThinkButtons();
        Utils.toast('已关闭深度思考（更快）', 'success');
      });
      on.addEventListener('click', function () {
        S.data.aiNoThink = false; Utils.saveData(S.data); markThinkButtons();
        Utils.toast('已开启深度思考（更准，更慢）', 'success');
      });
    })();
    /* 写一遍这个单词（v1.19.0：纯比对，不触发任何算法、不影响 FSRS） */
    var kcWriteBtn = $('kcWriteBtn');
    if (kcWriteBtn) {
      kcWriteBtn.addEventListener('click', function () {
        $('kcWriteInputWrap').classList.remove('hidden');
        $('kcWriteInput').focus();
      });
      $('kcWriteInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.keyCode === 13) checkWriteWord();
      });
      $('kcWriteCheck').addEventListener('click', function () {
        checkWriteWord();
        $('kcWriteInput').focus();
      });
    }
    $('importFile').addEventListener('change', handleImport);
    $('exportBackup').addEventListener('click', exportBackup);
    $('importBackupFile').addEventListener('change', handleRestoreBackup);
    $('ovSwitchUser').addEventListener('click', function () {
      Utils.clearCurrentUser();
      location.reload();
    });
    $('ovAccentUs').addEventListener('click', function () {
      S.data.accent = 'us'; scheduleSave(); markAccentButtons();
    });
    $('ovAccentGb').addEventListener('click', function () {
      S.data.accent = 'gb'; scheduleSave(); markAccentButtons();
    });
    $('resetProgress').addEventListener('click', resetProgress);
    $('wipeAll').addEventListener('click', wipeAll);
    /* 听写复习 */
    $('dictationBtn').addEventListener('click', startDictation);
    $('dictExit').addEventListener('click', dictExit);
    $('dictReplay').addEventListener('click', function () {
      if (dictState) speakEn(dictState.list[dictState.index].en);
    });
    $('dictHint').addEventListener('click', dictPlayHint);
    $('dictShowAnswer').addEventListener('click', dictShowAnswer);
    $('dictInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') dictCheck();
    });
    window.addEventListener('resize', function () {
      clearTimeout(window.__chartTimer);
      window.__chartTimer = setTimeout(renderChart, 150);
    });

    /* -------- 学习页：全屏滑动评分（触摸优先，鼠标拖拽兼容） --------
       上滑/下滑在学习页任意位置生效；只有点击单词本身才是“记不清” */
    var card = $('wordDisplay');
    var surface = $('studyPage');
    card.addEventListener('click', onCardClick);

    var gesture = null;

    function canStartSwipe(e) {
      if (S.knowledgeOpen) return false;
      return !(e.target && e.target.closest &&
        e.target.closest('button, input, textarea, a, .ai-row'));
    }

    function startCardGesture(x, y) {
      gesture = { startX: x, startY: y, moved: false };
      card.style.transition = 'none';
    }

    function moveCardGesture(x, y, prevent) {
      if (!gesture) return;
      var dy = y - gesture.startY;
      var dx = x - gesture.startX;
      if (Math.abs(dy) > 6 || Math.abs(dx) > 6) gesture.moved = true;
      /* 竖向为主时立即阻止浏览器滚动/下拉刷新（对 iOS Safari 同样有效） */
      if (prevent && Math.abs(dy) >= Math.abs(dx) && prevent.cancelable) prevent.preventDefault();
      if (Math.abs(dy) < Math.abs(dx)) return;
      card.style.transform = 'translateY(' + (dy * 0.9) + 'px) rotate(' + (dx * 0.04) + 'deg)';
    }

    function endCardGesture(x, y) {
      if (!gesture) return;
      var dy = y - gesture.startY;
      var dx = x - gesture.startX;
      var wasSwipe = false;
      card.style.transition = '';
      card.style.transform = '';
      if (Math.abs(dy) >= SWIPE_THRESHOLD && Math.abs(dy) >= Math.abs(dx)) {
        wasSwipe = true;
        onSwipe(dy < 0 ? 'up' : 'down');
      }
      if (wasSwipe || gesture.moved) suppressClickUntil = Date.now() + 450;
      gesture = null;
    }

    function cancelCardGesture() {
      gesture = null;
      card.style.transition = '';
      card.style.transform = '';
    }

    /* 触摸：整个学习页都可滑，touchmove 里 preventDefault 抢回手势 */
    surface.addEventListener('touchstart', function (e) {
      if (!canStartSwipe(e)) { cancelCardGesture(); return; }
      if (e.touches.length !== 1) { cancelCardGesture(); return; }
      startCardGesture(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    surface.addEventListener('touchmove', function (e) {
      if (!gesture || e.touches.length !== 1) return;
      var t = e.touches[0];
      moveCardGesture(t.clientX, t.clientY, e);
    }, { passive: false });

    surface.addEventListener('touchend', function (e) {
      var t = e.changedTouches[0];
      if (t) endCardGesture(t.clientX, t.clientY);
    });

    surface.addEventListener('touchcancel', cancelCardGesture);

    /* 鼠标：保留 Pointer 事件做桌面拖拽（同样全屏可用） */
    surface.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || !canStartSwipe(e)) return;
      if (e.button !== 0) return;
      startCardGesture(e.clientX, e.clientY);
      try { surface.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });

    surface.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      moveCardGesture(e.clientX, e.clientY, null);
    });

    surface.addEventListener('pointerup', function (e) {
      if (e.pointerType !== 'mouse') return;
      endCardGesture(e.clientX, e.clientY);
    });

    surface.addEventListener('pointercancel', cancelCardGesture);

    /* 学习页兜底：按钮以外的区域同样禁止浏览器下拉刷新 */
    surface.addEventListener('touchmove', function (e) {
      if (S.knowledgeOpen) return;   // 知识卡打开时，滚动交给 kc-sheet
      if (e.cancelable) e.preventDefault();
    }, { passive: false });

    $('studyExit').addEventListener('click', exitStudy);
    $('studyRefresh').addEventListener('click', refreshKnowledge);

    /* -------- 知识卡 -------- */
    $('kcExit').addEventListener('click', exitStudy);
    $('kcRefresh').addEventListener('click', refreshKnowledge);
    $('aiSend').addEventListener('click', askAI);
    $('aiInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') askAI();
    });
    $('kcNextHint').addEventListener('click', function () { kcNext(); });
    /* 点击例句朗读（知识页） */
    $('kcContent').addEventListener('click', function (e) {
      var enEl = e.target && e.target.closest ? e.target.closest('.kc-en') : null;
      if (enEl && enEl.textContent.trim()) { speakEn(enEl.textContent.trim()); return; }
      var block = e.target && e.target.closest ? e.target.closest('.example-block') : null;
      if (!block) return;
      var en = block.querySelector('.ex-en');
      if (en && en.textContent.trim()) speakEn(en.textContent.trim());
    });
    bindKnowledgeGesture();
    $('studyBack').addEventListener('click', goBack);
    $('doneReturnWord').addEventListener('click', goBack);
    $('doneMore').addEventListener('click', function () {
      $('doneOverlay').classList.add('hidden');
      beginSession();
    });
    $('goalContinue').addEventListener('click', function () {
      $('goalOverlay').classList.add('hidden');
      beginSession();
    });
    $('goalStop').addEventListener('click', function () {
      $('goalOverlay').classList.add('hidden');
    });
    $('doneBack').addEventListener('click', function () {
      $('doneOverlay').classList.add('hidden');
      exitStudy();
    });
  }

  /* ================= 概览页渲染 ================= */

  function renderOverview() {
    var stats = Utils.computeStats(S.data);
    $('statMastered').textContent = stats.mastered + ' / ' + stats.total;
    $('statNew').textContent = stats.newRemaining;
    $('statDue').textContent = stats.due;
    $('statDays').textContent = stats.newRemaining ? stats.estDays : '0';

    var goalInput = $('dailyGoalInput');
    goalInput.value = S.data.dailyGoal;
    $('newRatioSlider').value = Math.round(S.data.newRatio * 100);
    renderRatioLabel();
    $('apiKeyInput').value = S.data.apiKey || '';
    if ($('aiUrlInput')) $('aiUrlInput').value = S.data.aiUrl || '';
    if ($('aiModelInput')) $('aiModelInput').value = S.data.aiModel || '';
    if ($('aiModelList')) $('aiModelList').classList.add('hidden');   // 模型列表每次打开重新获取
    var personaInput = $('aiPersonaInput');
    if (personaInput) personaInput.value = S.data.aiPersona || '';
    markThemeButtons();
    markAccentButtons();
    if (markThinkButtons) markThinkButtons();
    renderChart();

    /* 显示当前词库 */
    var userEl = $('ovCurrentUser');
    if (userEl) userEl.textContent = Utils.userLabel(Utils.getCurrentUser());
  }

  function renderRatioLabel() {
    var pct = Math.round(S.data.newRatio * 100);
    $('ratioLabel').textContent = '新词 ' + pct + '% · 复习 ' + (100 - pct) + '%';
  }

  function markThemeButtons() {
    $('ovThemeWarm').style.borderColor = S.data.theme === 'warm' ? 'var(--grad-a)' : '';
    $('ovThemeCool').style.borderColor = S.data.theme === 'cool' ? 'var(--grad-a)' : '';
    $('ovThemeSolid').style.borderColor = S.data.theme === 'solid' ? 'var(--grad-a)' : '';
  }

  function markAccentButtons() {
    $('ovAccentUs').style.borderColor = S.data.accent === 'us' ? 'var(--grad-a)' : '';
    $('ovAccentGb').style.borderColor = S.data.accent === 'gb' ? 'var(--grad-a)' : '';
  }

  /* ---------------- 单词明细列表 ---------------- */

  function reviewLabel(w) {
    if (w.inHardPool) return { text: '难词池', cls: 'hard' };
    var c = w.fsrsCard;
    if (!c || !c.due) return { text: '未学习', cls: '' };
    var days = Utils.daysBetween(Utils.todayStr(), Utils.dateStr(new Date(c.due)));
    if (days < 0) return { text: '已逾期 ' + (-days) + ' 天', cls: 'overdue' };
    if (days === 0) return { text: '今天复习', cls: 'today' };
    return { text: days + ' 天后复习', cls: '' };
  }

  function dueMs(w) {
    var c = w && w.fsrsCard;
    if (!c || !c.due) return Infinity;
    var t = new Date(c.due).getTime();
    return isNaN(t) ? Infinity : t;
  }

  function openWordList(type) {
    var words = S.data.words;
    var items = [];
    var title = '';
    if (type === 'mastered') {
      title = '已掌握（' + Utils.computeStats(S.data).mastered + ' 词）';
      for (var i = 0; i < words.length; i++) {
        if (Utils.isMasteredWord(words[i])) items.push(words[i]);
      }
      items.sort(function (a, b) {
        return (b.fsrsCard ? b.fsrsCard.stability : 0) - (a.fsrsCard ? a.fsrsCard.stability : 0);
      });
    } else if (type === 'new') {
      title = '待学习（' + Utils.computeStats(S.data).newRemaining + ' 词）';
      for (var j = 0; j < words.length; j++) {
        if (!words[j].fsrsCard) items.push(words[j]);
      }
    } else {
      var now = new Date();
      title = '待复习（' + Utils.computeStats(S.data).due + ' 词）';
      for (var k = 0; k < words.length; k++) {
        if (Utils.isDueWord(words[k], now)) items.push(words[k]);
      }
      items.sort(function (a, b) {
        if (a.inHardPool !== b.inHardPool) return a.inHardPool ? 1 : -1;
        return dueMs(a) - dueMs(b);
      });
    }

    wordListState = { type: type, items: items, shown: 0, chunk: 120 };
    $('wordListTitle').textContent = title;
    $('wordListBody').innerHTML = '';
    $('wordListModal').classList.remove('hidden');
    renderWordListMore();
  }


  function addCustomWord() {
    var input = $('wordListAddInput');
    var word = input.value.trim().toLowerCase();
    if (!word) return;

    // 检查词库中是否已存在
    var existing = null;
    for (var i = 0; i < S.data.words.length; i++) {
      if (S.data.words[i].en.toLowerCase() === word) {
        existing = S.data.words[i];
        break;
      }
    }

    if (existing) {
      existing.inHardPool = true;
      Utils.syncDerived(S.data);
      scheduleSave();
      Utils.toast('已将 "' + existing.en + '" 加入难词池', 'success');
      input.value = '';
      $('wordListAddRow').classList.add('hidden');
      if (wordListState.type) openWordList(wordListState.type);
      return;
    }

    // 词库无此词，调 AI 校验拼写
    var rawWord = input.value.trim();
    var confirmBtn = $('wordListAddConfirm');
    confirmBtn.disabled = true;
    confirmBtn.textContent = '校验中...';

    callGLM([{
      role: 'system',
      content: '你是一个英语拼写检查助手。用户会输入一个英文单词，你需要判断它是否是一个真实存在的英语单词。\n只返回JSON：{"valid": true/false, "suggestion": "如果拼写错误，给出正确拼写；如果正确，留空"}'
    }, {
      role: 'user',
      content: rawWord
    }], 100, true, 0.2).then(function (text) {
      var result = extractJson(text);
      if (result && result.valid === false && result.suggestion) {
        // AI 检测到可能拼写错误
        if (window.confirm('你输入的 "' + rawWord + '" 可能有拼写错误，你是不是想输入 "' + result.suggestion + '"？\n点"确定"继续添加 "' + rawWord + '"，点"取消"修改。')) {
          doAddWord(rawWord, input);
        }
      } else {
        // AI 确认拼写正确
        doAddWord(rawWord, input);
      }
    }).catch(function (err) {
      // AI 调用失败，跳过校验直接添加
      doAddWord(rawWord, input);
    }).finally(function () {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '添加';
    });
  }

  function doAddWord(rawWord, input) {
    var newWord = Utils.makeWordRecord({ en: rawWord, zh: '', phonetic: '' }, S.data.words.length);
    newWord.inHardPool = true;
    S.data.words.push(newWord);
    _wordById = null;
    Utils.syncDerived(S.data);
    scheduleSave();
    Utils.toast('已添加 "' + rawWord + '" 到词库并加入难词池', 'success');
    input.value = '';
    $('wordListAddRow').classList.add('hidden');
    if (wordListState.type) openWordList(wordListState.type);
  }

  function closeWordList() {
    $('wordListModal').classList.add('hidden');
    wordListState = { type: '', items: [], shown: 0, chunk: 120 };
  }

  function renderWordListMore() {
    var st = wordListState;
    var next = Math.min(st.items.length, st.shown + st.chunk);
    var frag = document.createDocumentFragment();
    for (var i = st.shown; i < next; i++) {
      var w = st.items[i];
      var div = document.createElement('div');
      div.className = 'word-item';
      var tag = '';
      if (st.type === 'mastered') {
        var days = Math.max(0, Math.round(w.fsrsCard ? w.fsrsCard.stability : 0));
        tag = '<span class="w-tag">稳定期 ' + days + ' 天</span>';
      } else if (st.type === 'due') {
        var r = reviewLabel(w);
        tag = '<span class="w-tag ' + r.cls + '">' + Utils.escapeHtml(r.text) + '</span>';
      } else {
        tag = '<span class="w-tag">未学习</span>';
      }
      div.innerHTML =
        '<span class="w-en">' + Utils.escapeHtml(w.en) + '</span>' +
        '<span class="w-zh">' + Utils.escapeHtml(w.zh) + '</span>' +
        tag;
      frag.appendChild(div);
    }
    $('wordListBody').appendChild(frag);
    st.shown = next;
    var more = $('wordListMore');
    if (st.shown < st.items.length) {
      more.textContent = '加载更多（剩余 ' + (st.items.length - st.shown) + ' 词）';
      more.classList.remove('hidden');
    } else {
      more.classList.add('hidden');
    }
  }

  /* K线图：近 7 天，Canvas 简约柱状图 */
  function renderChart() {
    var canvas = $('trendChart');
    if (!canvas || !S.data) return;
    var rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var W = rect.width;
    var H = rect.height;
    var padL = 34, padR = 12, padT = 32, padB = 30;
    var days = [], labels = [], values = [];
    for (var i = 6; i >= 0; i--) {
      var d = Utils.addDays(Utils.todayStr(), -i);
      var p = d.split('-');
      days.push(d);
      labels.push((+p[1]) + '/' + (+p[2]));
      values.push(Number(S.data.dailyHistory[d]) || 0);
    }

    ctx.clearRect(0, 0, W, H);

    var maxV = Math.max(1, Math.max.apply(null, values), S.data.dailyGoal);
    var yMax = Math.ceil(maxV * 1.15);
    var innerW = W - padL - padR;
    var innerH = H - padT - padB;
    var yFor = function (v) { return padT + innerH - (v / yMax) * innerH; };

    /* 网格 + Y 轴刻度 */
    ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    var steps = 4;
    for (var s = 0; s <= steps; s++) {
      var gv = Math.round((yMax / steps) * s);
      var gy = yFor(gv);
      ctx.strokeStyle = 'rgba(120,130,145,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(W - padR, gy);
      ctx.stroke();
      ctx.fillStyle = '#9a9a9a';
      ctx.fillText(String(gv), padL - 7, gy);
    }

    /* 每日目标虚线（学习目标线） */
    if (S.data.dailyGoal > 0) {
      var gy2 = yFor(S.data.dailyGoal);
      ctx.strokeStyle = 'rgba(79,172,254,0.55)';
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(padL, gy2);
      ctx.lineTo(W - padR, gy2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#4facfe';
      ctx.textAlign = 'left';
      ctx.fillText('目标 ' + S.data.dailyGoal, padL + 6, gy2 - 9);
    }

    /* 柱状图 */
    var slot = innerW / 7;
    var barW = Math.min(34, slot * 0.55);
    var anyData = values.some(function (v) { return v > 0; });
    ctx.textAlign = 'center';
    for (var b = 0; b < 7; b++) {
      var cx = padL + slot * b + slot / 2;
      var v = values[b];
      var barH = (v / yMax) * innerH;
      var x = cx - barW / 2;
      var y = yFor(v);
      if (v > 0) {
        var grad = ctx.createLinearGradient(0, y, 0, y + barH);
        grad.addColorStop(0, '#4facfe');
        grad.addColorStop(1, '#00f2fe');
        ctx.fillStyle = grad;
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(x, y, barW, Math.max(barH, 3), [7, 7, 0, 0]);
        } else {
          ctx.rect(x, y, barW, Math.max(barH, 3));
        }
        ctx.fill();
        ctx.fillStyle = '#1a1a1a';
        ctx.font = 'bold 12px "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.fillText(String(v), cx, y - 9);
      } else {
        ctx.fillStyle = 'rgba(120,130,145,0.18)';
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(x, yFor(0) - 2, barW, 2, 1);
        } else {
          ctx.rect(x, yFor(0) - 2, barW, 2);
        }
        ctx.fill();
      }
      ctx.fillStyle = '#8a8a8a';
      ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(labels[b], cx, H - padB + 16);
    }

    if (!anyData) {
      ctx.fillStyle = '#a0a0a0';
      ctx.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('开始学习后，这里会出现你的每日趋势', W / 2, padT + innerH / 2);
    }
  }

  /* ---------------- 每日会话 / 连续天数 ---------------- */

  function ensureDaily() {
    var today = Utils.todayStr();
    if (S.data.sessionDate !== today) {
      var yesterday = Utils.addDays(today, -1);
      S.data.consecutiveDays = (S.data.sessionDate === yesterday) ? S.data.consecutiveDays + 1 : 1;
      S.data.sessionDate = today;
      S.data.wrongIds = [];
    }
    if (!S.data.dailyHistory[today]) S.data.dailyHistory[today] = 0;
    scheduleSave();
  }

  /* ================= 选词（readme 8.3） ================= */

  function selectSessionWords() {
    var now = new Date();
    var goal = Utils.clamp(S.data.dailyGoal, 1, 500);
    var baseReview = Math.round(goal * (1 - S.data.newRatio));

    var due = [], hard = [], fresh = [], wrongToday = [];
    var wrongIdSet = {};
    for (var i = 0; i < S.data.wrongIds.length; i++) wrongIdSet[S.data.wrongIds[i]] = true;

    for (var j = 0; j < S.data.words.length; j++) {
      var w = S.data.words[j];
      /* FSRS 到期条件：card.due <= now（不再看 nextReviewDate） */
      if (w.fsrsCard && w.fsrsCard.due && dueMs(w) <= now.getTime()) due.push(w);
      /* 今天标错的词：当天“再背一组”时优先重现，而不是必须等到明天 */
      if (wrongIdSet[w.id]) wrongToday.push(w);
    }

    /* 到期池排序：最近一次评分是 1/2 的错词优先，其余按 due 从早到晚 */
    function isWrong(w) { return w.lastRating === GRADE.AGAIN || w.lastRating === GRADE.HARD; }
    due.sort(function (a, b) {
      var aw = isWrong(a) ? 0 : 1;
      var bw = isWrong(b) ? 0 : 1;
      if (aw !== bw) return aw - bw;
      return dueMs(a) - dueMs(b);
    });

    var dueIds = {};
    for (var d = 0; d < due.length; d++) dueIds[due[d].id] = true;
    for (var h = 0; h < S.data.words.length; h++) {
      var w2 = S.data.words[h];
      if (w2.inHardPool && !dueIds[w2.id]) hard.push(w2);
      if (!w2.fsrsCard) fresh.push(w2);
    }

    /* 关键：词库按字母序排列，先整体洗牌再截取，否则每次都会抽到 a 开头 */
    wrongToday = Utils.shuffle(wrongToday);
    hard = Utils.shuffle(hard);
    fresh = Utils.shuffle(fresh);

    /* 复习名额 = max(设定比例, 到期错词数)：错词多时自动压缩新词名额，
       保证标错的词隔天一定能回来，且本组总词数仍等于每日目标 */
    var wrongDueCount = 0;
    for (var k = 0; k < due.length; k++) if (isWrong(due[k])) wrongDueCount++;
    var reviewQuota = Math.min(goal, Math.max(baseReview, wrongDueCount));
    var newQuota = goal - reviewQuota;

    var chosen = [];
    var chosenIds = {};
    function take(list, quota) {
      var n = 0;
      for (var i = 0; i < list.length && n < quota; i++) {
        if (!chosenIds[list[i].id]) {
          chosen.push(list[i]);
          chosenIds[list[i].id] = true;
          n++;
        }
      }
      return n;
    }

    /* 复习名额内部顺序：今日错词 → 到期词（错词优先）→ 难词池 */
    var wrongTaken = take(wrongToday, reviewQuota);
    var dueTaken = take(due, reviewQuota - wrongTaken);
    var hardTaken = take(hard, reviewQuota - wrongTaken - dueTaken);
    take(fresh, newQuota);

    /* 复习名额没用完时，剩余名额按 到期 → 今日错词 → 难词 → 新词 补足到目标 */
    var remaining = goal - chosen.length;
    if (remaining > 0) {
      take(due, remaining);
      take(wrongToday, remaining);
      take(hard, remaining);
      take(fresh, remaining);
    }

    /* 复习词 + 新词随机打乱混合 */
    return Utils.shuffle(chosen.map(function (w) { return w.id; }));
  }

  /* ================= 学习会话 ================= */

  function startLearning() {
    if (!S.data.words.length) {
      Utils.toast('词库还没准备好，请刷新页面', 'error');
      return;
    }
    ensureDaily();
    var today = Utils.todayStr();
    var doneToday = Number(S.data.dailyHistory[today]) || 0;
    /* 目标已达成时再点“开始学习”：先弹提醒，由用户选择继续超额或休息 */
    if (doneToday >= S.data.dailyGoal && S.data.goalRemindedDate !== today) {
      showGoalOverlay();
      return;
    }
    beginSession();
  }

  function beginSession() {
    if (!S.data.words.length) {
      Utils.toast('词库还没准备好，请刷新页面', 'error');
      return;
    }
    ensureDaily();   // 覆盖“任务完成弹窗停留跨天”等边界，保持错词表按天重置
    S.list = selectSessionWords();
    if (!S.list.length) {
      Utils.toast('今天没有需要学习的词，明天再来吧');
      return;
    }
    S.streak = 0;
    S.index = 0;
    S.aiChats = {};      // 每次学习会话重新开始；同一会话内每个单词保留自己的追问上下文
    appliedStack = [];
    lastApplied = null;
    initSpeech();   // readme 9.4：点击“开始学习”时初始化语音上下文
    $('overviewPage').classList.add('hidden');
    var study = $('studyPage');
    study.classList.remove('hidden');
    study.classList.remove('page-enter');
    void study.offsetWidth;   // 重新触发页面切换缓动
    study.classList.add('page-enter');
    hideKnowledge(false);
    updateStreak(false);

    S.pregenToken++;
    pregenWords(S.list.slice(), S.pregenToken, function () {
      return S.list[S.index];
    });
    showCard(0);
  }

  function showCard(index) {
    S.index = index;
    S.fullCard = false;
    lastApplied = latestAppliedFor(index);   // 回到已评分过的词时恢复其快照，知识页顶部仍可修正
    hideKnowledge(false);
    $('doneOverlay').classList.add('hidden');

    var card = $('wordDisplay');
    card.classList.remove('fly-up', 'fly-down', 'docked');
    card.style.transition = '';
    card.style.transform = '';

    var w = currentWord();
    if (!w) { exitStudy(); return; }

    /* 极简学习页：永远只显示英文单词 + 音标，居中 */
    $('frontMain').textContent = w.en;
    $('frontPhonetic').textContent = w.phonetic ? '/' + w.phonetic + '/' : '';

    card.classList.add('enter-bottom');
    card.addEventListener('animationend', function onAnim() {
      card.classList.remove('enter-bottom');
      card.removeEventListener('animationend', onAnim);
    });

    updateBackControl();
    speakEn(w.en);   // 单词出现即自动朗读
  }

  function onCardClick() {
    if (S.knowledgeOpen) return;
    /* 滑动刚结束时浏览器会补发 click，忽略它，避免误判为“记不清” */
    if (Date.now() < suppressClickUntil) return;
    var card = $('wordDisplay');
    if (card.style.transition === 'none') return;
    onUnsure();   // 点击单词 = 记不清
  }

  /* 手势：上滑=记得(Good) / 下滑=再练练(Hard)，随后进入知识页 */
  function onSwipe(dir) {
    gradeAndContinue(dir === 'up' ? GRADE.GOOD : GRADE.HARD);
  }

  /* ---------------- 评分快照：撤销 / 返回上一词 / 知识页修正共用 ---------------- */

  function findWordById(id) {
    if (!_wordById) _buildWordMap();
    return _wordById[id] || null;
  }

  function latestAppliedFor(index) {
    for (var i = appliedStack.length - 1; i >= 0; i--) {
      var e = appliedStack[i];
      if (e && !e.undone && e.index === index) return e;
    }
    return null;
  }

  /* 记录评分前快照，供“改为记不清”与“返回上一词”回滚 */
  function captureApplied(w, rating) {
    /* 同一位置重新评分时，先作废该位置的旧快照，避免旧状态被错误恢复 */
    appliedStack = appliedStack.filter(function (e) { return e.index !== S.index; });
    lastApplied = {
      index: S.index,
      wordId: w.id,
      rating: rating,
      corrected: false,
      undone: false,
      before: {
        fsrsCard: w.fsrsCard ? JSON.parse(JSON.stringify(w.fsrsCard)) : null,
        inHardPool: w.inHardPool,
        lastRating: w.lastRating,
        learnedIds: S.data.learnedIds.slice(),
        wrongIds: S.data.wrongIds.slice(),
        dailyValue: Number(S.data.dailyHistory[Utils.todayStr()]) || 0,
        streak: S.streak
      }
    };
    appliedStack.push(lastApplied);
  }

  function restoreApplied(entry) {
    if (!entry || entry.undone) return false;
    var w = findWordById(entry.wordId);
    if (!w) return false;
    var b = entry.before;
    w.fsrsCard = b.fsrsCard ? JSON.parse(JSON.stringify(b.fsrsCard)) : null;
    w.inHardPool = b.inHardPool;
    w.lastRating = b.lastRating;
    /* 恢复副本而非引用：恢复后立刻再评分时，不会反过来污染快照里的数组 */
    S.data.learnedIds = b.learnedIds.slice();
    S.data.wrongIds = b.wrongIds.slice();
    var today = Utils.todayStr();
    S.data.dailyHistory[today] = b.dailyValue;
    S.streak = b.streak;
    entry.undone = true;
    updateStreak(false);
    return true;
  }

  function correctionAvailable() {
    if (!lastApplied || lastApplied.corrected || lastApplied.undone) return false;
    var w = currentWord();
    return !!w && lastApplied.wordId === w.id && lastApplied.rating === GRADE.GOOD;
  }

  function undoLastApplied() {
    if (!lastApplied || lastApplied.undone) return false;
    var w = currentWord();
    if (!w || w.id !== lastApplied.wordId) return false;
    return restoreApplied(lastApplied);
  }

  /* 知识页顶部再上滑：把“记得”(Good) 改成“记不清”(Again)（与直接点单词的评分完全一致） */
  function correctGradeToUnsure() {
    if (!correctionAvailable()) return false;
    var w = currentWord();
    var originalBefore = lastApplied.before;
    if (!undoLastApplied()) return false;
    applyRating(w, GRADE.AGAIN);
    captureApplied(w, GRADE.AGAIN);
    /* 再按“返回上一词”时，应回滚到最初未评分状态，而不是已改“记不清”的状态 */
    lastApplied.before = originalBefore;
    lastApplied.corrected = true;
    Utils.saveData(S.data);
    Utils.toast('已改为记不清（Again），已加入复习', 'success');
    return true;
  }

  /* “点击返回上一个单词”：撤销上一个词（及其之后）的评分，回到上一个词重新标记。
     可连续点击继续往前退；第一词（index=0）没有上一词，按钮自动隐藏 */
  function goBack() {
    var target = S.index - 1;
    if (target < 0 || target >= S.list.length) return false;

    hideKnowledge(true);
    $('doneOverlay').classList.add('hidden');

    var undone = [];
    for (var i = appliedStack.length - 1; i >= 0; i--) {
      var e = appliedStack[i];
      if (e && !e.undone && e.index >= target) undone.push(e);
    }
    /* 从后往前逐条回滚，保证多次评分叠加时状态还原正确 */
    undone.sort(function (a, b) { return b.index - a.index; });
    for (var j = 0; j < undone.length; j++) restoreApplied(undone[j]);

    S.index = target;
    showCard(S.index);
    updateBackControl();
    Utils.saveData(S.data);
    return true;
  }

  function updateBackControl() {
    var show = S.index > 0 && S.index < S.list.length;
    $('studyBack').classList.toggle('hidden', !show);
  }

  function gradeAndContinue(rating) {
    var w = currentWord();
    if (!w) return;
    captureApplied(w, rating);
    applyRating(w, rating);

    var card = $('wordDisplay');
    card.classList.remove('enter-bottom');
    card.classList.add(rating === GRADE.GOOD ? 'fly-up' : 'fly-down');

    showFeedback(rating === GRADE.GOOD ? '记住了！' : '再练练！');
    setTimeout(function () {
      showKnowledge(false);
    }, FEEDBACK_MS);
  }

  /* 点击单词 = 记不清：映射 FSRS Again（记不清→加入难词本），
     同时加入 UI 层“难词池”；先弹提示，再进知识页 */
  function onUnsure() {
    if (S.knowledgeOpen) return;
    var w = currentWord();
    if (!w) return;
    captureApplied(w, GRADE.AGAIN);
    applyRating(w, GRADE.AGAIN);
    var card = $('wordDisplay');
    card.classList.remove('enter-bottom');
    card.classList.add('fly-up');

    showFeedback('记不清！');
    setTimeout(function () {
      showKnowledge(true);   // 完整知识卡：词根 + 口诀 + 标准内容
    }, FEEDBACK_MS);
  }

  /* ---------------- FSRS 评分（readme 8.2 评分映射） ----------------
     上滑 = Good(3) / 下滑 = Hard(2) / 点词 = Again(1)+难词池。
     间隔一律由 ts-fsrs scheduler.next(card, now, rating) 计算，
     这里没有任何手写间隔公式。 */

  function applyRating(w, rating) {
    var now = new Date();
    var today = Utils.todayStr();
    ensureDaily();

    /* 库返回的更新后 Card 直接序列化回存；新词由 createEmptyCard 创建 */
    w.fsrsCard = window.FSRSAdapter.next(w.fsrsCard, now, rating);
    w.lastRating = rating;

    if (rating === GRADE.AGAIN) w.inHardPool = true;   // 点“记不清”才进难词池
    if (rating >= GRADE.GOOD && w.inHardPool) w.inHardPool = false;

    /* 已掌握索引统一由 fsrsCard 重建（Again 掉回重学中时也会正确移出） */
    Utils.syncDerived(S.data);

    /* 当日错词表：1/2 加入；之后答对（3/4）说明已补救，移出，当天不再反复出现 */
    var wrongIdx = S.data.wrongIds.indexOf(w.id);
    if (rating >= GRADE.GOOD && wrongIdx !== -1) S.data.wrongIds.splice(wrongIdx, 1);
    if (rating <= GRADE.HARD && wrongIdx === -1) S.data.wrongIds.push(w.id);

    var doneBefore = S.data.dailyHistory[today] || 0;
    S.data.dailyHistory[today] = doneBefore + 1;

    /* 达到每日目标这一刻提示一次；弹窗式提醒在下次点“开始学习”时出现 */
    if (doneBefore < S.data.dailyGoal && S.data.dailyHistory[today] >= S.data.dailyGoal) {
      Utils.toast('今日目标 ' + S.data.dailyGoal + ' 词已达成，再背将计入超额', 'success');
    }

    if (rating >= GRADE.GOOD) {
      S.streak++;
      updateStreak(true);
    } else {
      S.streak = 0;
      updateStreak(false);
    }
    scheduleSave();
  }

  function updateStreak(bump) {
    var chip = $('streakChip');
    chip.textContent = '连对 ' + S.streak;
    if (bump) {
      chip.classList.remove('bump');
      void chip.offsetWidth;
      chip.classList.add('bump');
    }
  }

  function showFeedback(text) {
    var overlay = $('feedbackOverlay');
    $('feedbackText').textContent = text;
    overlay.classList.remove('hidden');
    setTimeout(function () {
      overlay.classList.add('hidden');
    }, FEEDBACK_MS);
  }

  /* ================= 语音朗读（readme 第九章） ================= */

  function initSpeech() {
    /* 预热本地离线 TTS（Web Speech 兜底）。必须在用户手势后调用
       （本 App 在“开始学习”按钮点击时调用），确保自动播放策略放行后续朗读。 */
    if (typeof window.speechSynthesis === 'undefined') return;
    try {
      window.speechSynthesis.cancel();
      if (window.speechSynthesis.getVoices) window.speechSynthesis.getVoices();
    } catch (e) { /* 忽略 */ }
  }

  var currentAudio = null;
  var ttsAbort = null;

  function speakEn(en) {
    if (!en) return;
    /* App 打包时注入 window.APP_API_BASE（空字符串=完全本地）：此时不连服务器，
       直接走手机本地 TTS。网页版没有该变量 → 走同源服务器 /api/tts，失败再降级本地。 */
    var hasAppBase = typeof window.APP_API_BASE !== 'undefined';
    var apiBase = hasAppBase ? String(window.APP_API_BASE || '').replace(/\/+$/, '') : '';
    if (hasAppBase && !apiBase) { speakEnLocal(en); return; }

    var url = apiBase ? apiBase + '/api/tts' : '/api/tts';
    if (ttsAbort) { ttsAbort.abort(); ttsAbort = null; }
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    var accent = (S.data && S.data.accent) || 'us';
    var ctrl = new AbortController();
    ttsAbort = ctrl;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(en), accent: accent }),
      signal: ctrl.signal
    })
    .then(function (r) { if (!r.ok) throw new Error('tts ' + r.status); return r.blob(); })
    .then(function (blob) {
      var audioUrl = URL.createObjectURL(blob);
      var audio = new Audio(audioUrl);
      currentAudio = audio;
      audio.onended = function () { URL.revokeObjectURL(audioUrl); currentAudio = null; };
      audio.onerror = function () { URL.revokeObjectURL(audioUrl); currentAudio = null; };
      audio.play().catch(function () {});
    })
    .catch(function (e) {
      if (e.name !== 'AbortError') {
        console.warn('server tts failed, fallback to local:', e);
        speakEnLocal(en);
      }
    });
  }

  /* 优先用安卓原生 TTS（@capacitor-community/text-to-speech，走 android.speech.tts），
     对绝大多数手机都能可靠出声。 */
  function speakNative(text) {
    if (typeof window === 'undefined' || !window.Capacitor || !window.Capacitor.Plugins ||
        !window.Capacitor.Plugins.TextToSpeech) return false;
    var p = window.Capacitor.Plugins.TextToSpeech;
    if (!p || typeof p.speak !== 'function') return false;
    try {
      var pr = p.speak({ text: String(text), lang: 'en-US', rate: 0.85, pitch: 1.0 });
      if (pr && typeof pr.catch === 'function') { pr.catch(function (e) { console.warn('native tts:', e); }); }
      return true;
    } catch (e) { return false; }
  }

  /* 本地离线朗读：优先内置离线 Piper（美/英按设置口音），
     无对应音素（如雅思词）或插件不可用时，才降级系统 TTS / Web Speech。 */
  function speakEnLocal(en) {
    if (!en) return;
    var accent = (S.data && S.data.accent) || 'us';
    var voice = accent === 'gb' ? 'en-GB' : 'en-US';
    var usePiper = Utils.tts && typeof Utils.tts.speak === 'function' && Utils.tts.available();
    if (!usePiper) { fallbackSpeakEnLocal(en); return; }
    Utils.tts.hasPhonemes(String(en)).then(function (has) {
      if (has) {
        Utils.tts.speak(String(en), { voice: voice, rate: 1.0 }).then(function (ok) {
          if (!ok) fallbackSpeakEnLocal(en);   // Piper 失败绝不无声，降级原生
        });
      } else {
        fallbackSpeakEnLocal(en);
      }
    }).catch(function () { fallbackSpeakEnLocal(en); });
  }

  function fallbackSpeakEnLocal(en) {
    if (!en) return;
    if (speakNative(String(en))) return;     /* 系统 TTS（可靠出声） */
    if (window.OfflineTTS) {                 /* 内置神经网络（仅原生不可用时才懒加载尝试） */
      if (window.OfflineTTS.init) { try { window.OfflineTTS.init(); } catch (e) { /* 忽略 */ } }
      if (window.OfflineTTS.say && window.OfflineTTS.say(String(en))) return;
    }
    if (typeof window.speechSynthesis === 'undefined' ||        /* Web Speech 兜底 */
        typeof window.SpeechSynthesisUtterance === 'undefined') return;
    try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    var u = new window.SpeechSynthesisUtterance(String(en));
    u.lang = 'en-US';
    u.rate = 0.85;
    u.volume = 1.0;
    var voices = [];
    try { voices = window.speechSynthesis.getVoices() || []; } catch (e) { voices = []; }
    var pick = null;
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      var nm = String(v.name || '').toLowerCase();
      var lg = String(v.lang || '').toLowerCase();
      if ((nm.indexOf('voxsherpa') !== -1 || nm.indexOf('sherpa') !== -1) &&
          (lg.indexOf('en') === 0)) { pick = v; break; }
    }
    if (!pick) {
      for (var j = 0; j < voices.length; j++) {
        var v2 = voices[j];
        var lg2 = String(v2.lang || '').toLowerCase();
        if (lg2 === 'en-us' || lg2 === 'en_US') { pick = v2; break; }
      }
    }
    if (pick) u.voice = pick;
    try { window.speechSynthesis.speak(u); } catch (e) { /* 忽略 */ }
  }

  /* ================= 知识卡 ================= */

  function showKnowledge(full) {
    S.knowledgeOpen = true;
    S.fullCard = full;

    var overlay = $('knowledgeOverlay');
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
    overlay.classList.remove('hidden', 'closing');
    $('wordDisplay').classList.add('docked');
    $('studyRefresh').classList.remove('hidden');
    $('kcRefresh').classList.remove('hidden');

    var w = currentWord();
    if (!w) return;
    $('kcSheet').scrollTop = 0;   // 知识页始终从顶部打开

    $('kcNextHint').classList.remove('hidden');
    $('aiInput').value = '';
    renderAIChat(w.id);   // 同一单词重新打开时恢复其专属对话；换单词则展示空对话（上下文隔离）

    ensureKnowledge(w, false);
  }

  function hideKnowledge(immediate) {
    var overlay = $('knowledgeOverlay');
    if (immediate) {
      clearTimeout(overlayHideTimer);
      overlayHideTimer = null;
      overlay.classList.add('hidden');
      overlay.classList.remove('closing');
    } else if (overlay.classList.contains('closing')) {
      /* 已经在退场动画中：交给既有的计时器，不重复排队 */
    } else if (!overlay.classList.contains('hidden')) {
      overlay.classList.add('closing');
      overlayHideTimer = setTimeout(function () {
        overlay.classList.add('hidden');
        overlay.classList.remove('closing');
        overlayHideTimer = null;
      }, 200);
    }
    $('wordDisplay').classList.remove('docked');
    $('studyRefresh').classList.add('hidden');
    $('kcRefresh').classList.add('hidden');
    S.knowledgeOpen = false;
  }

  function ensureKnowledge(w, force) {
    var cached = Utils.getKnowledge(w.en);
    /* AI 生成过的单词不再自动生成；只有手动点“刷新”才重新生成。
       但如果缓存缺少 etymology 字段（v1.17.3 之前的旧数据），自动重新生成。 */
    if (!force && cached && (cached.v === 2 || cached.v === 3)) {
      if (cached.etymology) {
        renderKnowledge(cached);
        return;
      }
      force = true;
    }
    renderKnowledgeLoading(w);
    fetchKnowledge(w, force).then(function (k) {
      if (S.knowledgeOpen && currentWord() && currentWord().id === w.id) renderKnowledge(k);
    }).catch(function (err) {
      if (S.knowledgeOpen && currentWord() && currentWord().id === w.id) {
        renderKnowledgeError(w, err);
      }
    });
  }

  function refreshKnowledge() {
    if (S.busyRefresh) return;
    var w = currentWord();
    if (!w || !S.knowledgeOpen) return;
    S.busyRefresh = true;
    $('kcRefresh').classList.add('spinning');
    $('studyRefresh').classList.add('spinning');
    renderKnowledgeLoading(w);
    fetchKnowledge(w, true).then(function (k) {
      if (S.knowledgeOpen && currentWord() && currentWord().id === w.id) renderKnowledge(k);
      Utils.toast('知识卡已刷新并更新缓存', 'success');
    }).catch(function (err) {
      if (S.knowledgeOpen && currentWord() && currentWord().id === w.id) renderKnowledgeError(w, err);
      Utils.toast('刷新失败：' + err.message, 'error');
    }).finally(function () {
      S.busyRefresh = false;
      $('kcRefresh').classList.remove('spinning');
      $('studyRefresh').classList.remove('spinning');
    });
  }

  /* ---------------- 知识页渲染（纯文本排版） ---------------- */

  function knowledgeSectionsHTML(k) {
    var out = '';
    var meanings = (k.meanings && k.meanings.length) ? k.meanings : [];
    if (!meanings.length) {
      /* 旧缓存/异常兜底：用词库释义拆分，词性未知 */
      (k.zh || '').split(/[；;]/).forEach(function (zh) {
        if (zh.trim()) meanings.push({ pos: '', zh: zh.trim() });
      });
    }

    /* 中文释义：词性 + 释义 */
    out += '<h3 class="kc-h">中文释义</h3>';
    if (meanings.length) {
      meanings.forEach(function (m) {
        out += '<div class="meaning-line"><span class="pos">' +
          Utils.escapeHtml(m.pos || '') + '</span><span>' +
          Utils.escapeHtml(m.zh || '') + '</span></div>';
      });
    } else {
      out += '<p class="kc-empty">暂无释义</p>';
    }

    /* 单词变形：变形词 + 词性 + 中文释义；没有就显示“无” */
    out += '<h3 class="kc-h">单词变形</h3>';
    var variants = [];
    if (Array.isArray(k.variants)) {
      variants = k.variants.map(function (v) {
        if (v && typeof v === 'object') {
          return { word: String(v.word || v.en || '').trim(), pos: String(v.pos || '').trim(), zh: String(v.zh || '').trim() };
        }
        return { word: String(v || '').trim(), pos: '', zh: '' };
      }).filter(function (v) { return v.word || v.zh; });
    } else if (k.variants && typeof k.variants === 'object') {
      /* 兼容最早一版缓存：{noun, adj, adv} 对象结构 */
      [['noun', 'n.'], ['adj', 'adj.'], ['adv', 'adv.'], ['verb', 'v.']].forEach(function (pair) {
        if (k.variants[pair[0]]) variants.push({ word: k.variants[pair[0]], pos: pair[1], zh: '' });
      });
    }
    if (variants.length) {
      variants.forEach(function (v) {
        out += '<div class="variant-line"><span class="pos">' +
          Utils.escapeHtml(v.pos) + '</span><span class="ph-en">' +
          Utils.escapeHtml(v.word) + '</span><span class="ph-zh">' +
          Utils.escapeHtml(v.zh) + '</span></div>';
      });
    } else {
      out += '<p class="kc-empty">无</p>';
    }

    /* 例句：每个释义各配一句（AI 生成） */
    out += '<h3 class="kc-h">例句</h3>';
    var hasExample = meanings.some(function (m) { return m.exampleEn || m.exampleZh; });
    if (hasExample) {
      meanings.forEach(function (m) {
        if (!m.exampleEn && !m.exampleZh) return;
        out += '<div class="example-block">' +
          '<div class="ex-pos">' + Utils.escapeHtml(m.pos || '') +
          (m.zh ? ' · ' + Utils.escapeHtml(m.zh) : '') + '</div>' +
          '<div class="ex-en">' + Utils.escapeHtml(m.exampleEn || '') + '</div>' +
          '<div class="ex-zh">' + Utils.escapeHtml(m.exampleZh || '') + '</div>' +
          '</div>';
      });
    } else if (k.examples && k.examples.length) {
      k.examples.forEach(function (ex) {
        if (!ex || (!ex.en && !ex.zh)) return;
        out += '<div class="example-block">' +
          '<div class="ex-en">' + Utils.escapeHtml(ex.en || '') + '</div>' +
          '<div class="ex-zh">' + Utils.escapeHtml(ex.zh || '') + '</div>' +
          '</div>';
      });
    } else {
      out += '<p class="kc-empty">暂无例句</p>';
    }

    /* 短语组合：短语 + 中文释义 */
    out += '<h3 class="kc-h">短语组合</h3>';
    var phrases = (k.phrases || []).map(function (p) {
      if (p && typeof p === 'object') return { en: p.en || p.phrase || '', zh: p.zh || p.translation || '' };
      return { en: String(p || ''), zh: '' };
    }).filter(function (p) { return p.en || p.zh; });
    if (phrases.length) {
      phrases.forEach(function (p) {
        out += '<div class="phrase-line"><span class="ph-en">' +
          Utils.escapeHtml(p.en) + '</span><span class="ph-zh">' +
          Utils.escapeHtml(p.zh) + '</span></div>';
      });
    } else {
      out += '<p class="kc-empty">暂无短语</p>';
    }

    /* 词根词缀 */
    out += '<h3 class="kc-h">词根词缀</h3>';
    var ety = k.etymology;
    if (ety && (ety.root || ety.origin)) {
      if (ety.root) {
        out += '<div class="ety-row"><span class="ety-label">词根</span><span class="ety-value">' +
          Utils.escapeHtml(ety.root) + '</span></div>';
      }
      if (ety.prefix) {
        out += '<div class="ety-row"><span class="ety-label">前缀</span><span class="ety-value">' +
          Utils.escapeHtml(ety.prefix) + '</span></div>';
      }
      if (ety.suffix) {
        out += '<div class="ety-row"><span class="ety-label">后缀</span><span class="ety-value">' +
          Utils.escapeHtml(ety.suffix) + '</span></div>';
      }
      if (ety.origin) {
        out += '<div class="ety-row"><span class="ety-label">词源</span><span class="ety-value">' +
          Utils.escapeHtml(ety.origin) + '</span></div>';
      }
      if (ety.tip) {
        out += '<div class="ety-tip">' + Utils.escapeHtml(ety.tip) + '</div>';
      }
      if (ety.related && ety.related.length) {
        out += '<div class="ety-related-head"><span class="ety-label">同根词</span></div>';
        ety.related.forEach(function (r) {
          out += '<div class="ety-related-item">' +
            '<span class="ety-related-word">' + Utils.escapeHtml(r.word) + '</span>' +
            (r.pos ? '<span class="ety-related-pos">' + Utils.escapeHtml(r.pos) + '</span>' : '') +
            (r.zh ? '<span class="ety-related-zh">' + Utils.escapeHtml(r.zh) + '</span>' : '') +
            '</div>';
        });
      }
    } else {
      out += '<p class="kc-empty">暂无词根词缀分析</p>';
    }

    return out;
  }

  function renderKnowledge(k) {
    var sheet = $('kcSheet');
    var hasOverflow = sheet.scrollHeight > sheet.clientHeight + 40;
    var wasBottom = hasOverflow && kcAtBottom();
    $('kcContent').innerHTML =
      '<div class="kc-wordline">' +
      '  <div class="kc-en">' + Utils.escapeHtml(k.en) + '</div>' +
      '  <div class="kc-ph">' + Utils.escapeHtml(k.phonetic ? '/' + k.phonetic + '/' : '') + '</div>' +
      '</div>' +
      knowledgeSectionsHTML(k);
    /* 只有内容真正溢出、且用户确实滑到了底部时，才保持贴底；
       否则一律从顶部开始阅读。 */
    if (wasBottom) sheet.scrollTop = sheet.scrollHeight;
  }

  function renderKnowledgeLoading(w) {
    $('kcContent').innerHTML =
      '<div class="kc-wordline">' +
      '  <div class="kc-en">' + Utils.escapeHtml(w.en) + '</div>' +
      '  <div class="kc-ph">' + Utils.escapeHtml(w.phonetic ? '/' + w.phonetic + '/' : '') + '</div>' +
      '</div>' +
      '<p class="kc-loading">正在生成知识内容…</p>';
  }

  function renderKnowledgeError(w, err) {
    var sheet = $('kcSheet');
    var hasOverflow = sheet.scrollHeight > sheet.clientHeight + 40;
    var wasBottom = hasOverflow && kcAtBottom();
    $('kcContent').innerHTML =
      '<div class="kc-wordline">' +
      '  <div class="kc-en">' + Utils.escapeHtml(w.en) + '</div>' +
      '  <div class="kc-ph">' + Utils.escapeHtml(w.phonetic ? '/' + w.phonetic + '/' : '') + '</div>' +
      '</div>' +
      '<div class="kc-error">知识内容生成失败：' + Utils.escapeHtml(err && err.message ? err.message : '未知错误') +
      '<br>可以点击右上角“刷新”重试；学习不受影响。</div>';
    if (wasBottom) sheet.scrollTop = sheet.scrollHeight;
  }

  /* ---------------- 智谱 GLM-4-Flash API ---------------- */

  function getAIConfig() {
    /* v1.19.0：不再内置任何 URL/Key/模型，全部由用户在设置里填写 */
    var url = (S.data && S.data.aiUrl ? String(S.data.aiUrl).trim() : '');
    var model = (S.data && S.data.aiModel ? String(S.data.aiModel).trim() : '');
    var key = (S.data && S.data.apiKey ? String(S.data.apiKey).trim() : '');
    if (url && !/\/chat\/completions$/.test(url)) url = url.replace(/\/+$/, '') + '/chat/completions';
    return { url: url, model: model, key: key };
  }

  function requireAIConfig() {
    var cfg = getAIConfig();
    if (!cfg.url || !cfg.model || !cfg.key) {
      throw new Error('请先在设置中填写 AI 的 URL、API Key 与模型名称');
    }
    return cfg;
  }

  function getPersona() {
    var p = S.data && S.data.aiPersona ? String(S.data.aiPersona).trim() : '';
    return p || (Utils.DEFAULT_AI_PERSONA || '');
  }

  /* v1.24.0：推理模型（DeepSeek V4 等）自带「深度思考」，官方接口可用开关关掉：
   *   reasoning_effort:'none' / thinking:{type:'disabled'} 实测均生效（思考 0 字，快 2–4 倍）。
   *   别的服务商若不吃这个参数会返回 400 —— 自动降级：去掉参数重试一次，并记住本会话不再发。 */
  var reasoningEffortRejected = false;
  function thinkingOffRequested() {
    return !!(S.data && S.data.aiNoThink !== false);
  }
  function needsThinkingOff() {
    return thinkingOffRequested() && !reasoningEffortRejected;
  }
  function isParamRejection(err) {
    var m = String((err && err.message) || '');
    return /\b400\b/.test(m) && /reasoning_effort|thinking|unknown|unsupported|extra|invalid/i.test(m);
  }

  /* v1.23.0：推理模型（DeepSeek V4 等）的思考也吃 max_tokens，正文可能被挤空；
   * 这种情况自动放大预算重试一次，而不是直接报「AI 返回为空」。 */
  async function callGLM(messages, maxTokens, jsonMode, temperature) {
    var cfg = requireAIConfig();
    var budget = maxTokens || 600;
    for (var attempt = 0; ; attempt++) {
      var out;
      try {
        out = await callGLMOnce(cfg, messages, budget, jsonMode, temperature, needsThinkingOff());
      } catch (err) {
        if (needsThinkingOff() && isParamRejection(err)) {   // 服务商不认这个参数 → 降级重试
          reasoningEffortRejected = true;
          continue;
        }
        throw err;
      }
      if (out.text.trim()) return out.text;
      if (attempt >= 3 || !out.reasoning) throw new Error('AI 返回为空');
      if (needsThinkingOff()) { reasoningEffortRejected = true; continue; }   // 先试着把思考关掉
      budget = Math.max(budget * 3, 4000);
    }
  }

  async function callGLMOnce(cfg, messages, maxTokens, jsonMode, temperature, noThink) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 25000);
    var body = {
      model: cfg.model,
      messages: messages,
      temperature: (temperature == null ? 0.7 : temperature),
      max_tokens: maxTokens
    };
    if (noThink) body.reasoning_effort = 'none';
    if (jsonMode) body.response_format = { type: 'json_object' };
    try {
      var res = await fetch(cfg.url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + cfg.key,
          'Content-Type': 'application/json'
        },
        signal: ctrl.signal,
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        var detail = '';
        try { detail = (await res.text()).slice(0, 200); } catch (e) { /* 忽略 */ }
        throw new Error('AI 请求失败 ' + res.status + (detail ? '：' + detail : ''));
      }
      var json = await res.json();
      var msg = json && json.choices && json.choices[0] && json.choices[0].message;
      return {
        text: String((msg && msg.content) || '').trim(),
        reasoning: String((msg && msg.reasoning_content) || '').trim()
      };
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('AI 请求超时');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /* 容忍 AI 常见 JSON 瑕疵：代码块、尾逗号、两行之间漏逗号 */
  function extractJson(text) {
    var t = String(text || '')
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    var start = t.indexOf('{');
    var end = t.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('AI 返回内容不是 JSON');
    var slice = t.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch (firstErr) {
      var fixed = slice
        .replace(/,\s*([}\]])/g, '$1')                       // 尾逗号
        .replace(/(")\s*\r?\n(\s*")/g, '$1,\n$2')           // 两行字符串属性之间漏逗号
        .replace(/([}\]0-9])\s*\r?\n(\s*")/g, '$1,\n$2');   // 值后换行漏逗号
      try {
        return JSON.parse(fixed);
      } catch (secondErr) {
        throw new Error('AI 返回内容不是合法 JSON：' +
          (firstErr && firstErr.message ? firstErr.message : ''));
      }
    }
  }

  function normalizeKnowledge(w, raw) {
    var obj = raw && typeof raw === 'object' ? raw : {};
    var meanings = Array.isArray(obj.meanings) ? obj.meanings : [];
    meanings = meanings.map(function (m) {
      if (!m || typeof m !== 'object') return { pos: '', zh: String(m || ''), exampleEn: '', exampleZh: '' };
      return {
        pos: String(m.pos || '').trim(),
        zh: String(m.zh || '').trim(),
        exampleEn: String(m.exampleEn || (m.example && m.example.en) || '').trim(),
        exampleZh: String(m.exampleZh || (m.example && m.example.zh) || '').trim()
      };
    }).filter(function (m) { return m.pos || m.zh || m.exampleEn || m.exampleZh; });

    var phrases = Array.isArray(obj.phrases) ? obj.phrases : [];
    phrases = phrases.map(function (p) {
      if (p && typeof p === 'object') {
        return { en: String(p.en || p.phrase || '').trim(), zh: String(p.zh || p.translation || '').trim() };
      }
      return { en: String(p || '').trim(), zh: '' };
    }).filter(function (p) { return p.en || p.zh; }).slice(0, 5);

    /* 单词变形：变形词 + 词性 + 中文释义 */
    var variants = Array.isArray(obj.variants) ? obj.variants : [];
    variants = variants.map(function (v) {
      if (v && typeof v === 'object') {
        return { word: String(v.word || v.en || '').trim(), pos: String(v.pos || '').trim(), zh: String(v.zh || '').trim() };
      }
      return { word: String(v || '').trim(), pos: '', zh: '' };
    }).filter(function (v) { return v.word || v.zh; }).slice(0, 8);

    var ety = obj.etymology && typeof obj.etymology === 'object' ? obj.etymology : {};
    var etymology = {
      root: String(ety.root || '').trim(),
      origin: String(ety.origin || '').trim(),
      prefix: String(ety.prefix || '').trim(),
      suffix: String(ety.suffix || '').trim(),
      tip: String(ety.tip || '').trim(),
      related: Array.isArray(ety.related) ? ety.related.map(function (r) {
        if (r && typeof r === 'object') return { word: String(r.word || '').trim(), pos: String(r.pos || '').trim(), zh: String(r.zh || '').trim() };
        return { word: String(r || '').trim(), pos: '', zh: '' };
      }).filter(function (r) { return r.word; }).slice(0, 6) : []
    };

    return {
      v: 3,
      en: w.en,
      zh: w.zh,
      phonetic: w.phonetic || '',
      meanings: meanings,
      variants: variants,
      phrases: phrases,
      etymology: etymology,
      generatedAt: new Date().toISOString()
    };
  }

  async function fetchKnowledge(w, force) {
    var key = w.en.toLowerCase();
    if (!force) {
      var cached = Utils.getKnowledge(w.en);
      if (cached && (cached.v === 2 || cached.v === 3)) return cached;   // 已生成过：直接用缓存，不再请求 AI
      if (inflight.has(key)) return inflight.get(key);   // 已在请求中：复用，避免并发重复
      /* 本地未命中：先按词向服务器查询（约 6MB 整包放不进 localStorage，
         改为服务器单条查询）。命中则缓存并返回，不再调 AI。 */
      var ser = await Utils.getServerKnowledge(w.en);
      if (ser && (ser.v === 2 || ser.v === 3)) {
        Utils.setKnowledge(w.en, ser);
        return ser;
      }
    }
    var p = (async function () {
      var prompt =
        '你是六级英语词汇助教。\n' +
        '请为单词"' + w.en + '"（音标：' + (w.phonetic || '无') + '；词库释义：' + w.zh + '）生成六级学习内容，要求：\n' +
        '1. 中文释义：只列出该单词真实的常用词性及对应中文释义，每个释义一项，词性用 "n." "v." "vt." "vi." "adj." "adv." "prep." 等常见缩写，不要臆造词性或释义；\n' +
        '2. 例句：为上面每一个释义各配一个六级难度的英文例句和中文翻译，分别放在对应 meanings 项的 exampleEn 和 exampleZh 字段里；\n' +
        '3. 单词变形：列出该单词真实常见的变形词（名词、动词、形容词、副词等），每项包含 word（变形词）、pos（词性）、zh（中文释义）；确实没有变形时返回空数组；\n' +
        '4. 短语组合：2-3 个该单词真实常见短语及其中文释义。\n' +
        '5. 词根词缀：分析该单词的词根词缀构成。包括：root（核心词根及其含义，如 "spect = 看"）、origin（词源简述，如 "来自拉丁语 spectare"；英语本族词可写"古英语"）、prefix（前缀及含义，无前缀时留空）、suffix（后缀及含义，无后缀时留空）、tip（基于词根词缀的联想记忆口诀，一句话）、related（2-4 个同根词）。\n' +
        '如果单词较短或词源不明（如 go, run, good 等基础词汇），origin 可写"基础词汇，无明显词根词缀"，其余字段留空数组。\n\n' +
        '只返回JSON，结构如下：\n' +
        '{\n' +
        '  "meanings": [\n' +
        '    {"pos": "词性缩写", "zh": "对应释义", "exampleEn": "例句", "exampleZh": "例句翻译"}\n' +
        '  ],\n' +
        '  "variants": [\n' +
        '    {"word": "变形词", "pos": "词性缩写", "zh": "对应释义"}\n' +
        '  ],\n' +
        '  "phrases": [\n' +
        '    {"en": "词组", "zh": "对应释义"}\n' +
        '  ],\n' +
        '  "etymology": {\n' +
        '    "root": "词根及含义",\n' +
        '    "origin": "词源简述",\n' +
        '    "prefix": "前缀及含义",\n' +
        '    "suffix": "后缀及含义",\n' +
        '    "tip": "记忆口诀",\n' +
        '    "related": [{"word": "同根词1", "pos": "词性", "zh": "释义"}, ...]\n' +
        '  }\n' +
        '}\n' +
        '只返回JSON，不要输出其他文字。';

      var rawObj = null;
      function parseOnce(raw) {
        rawObj = extractJson(raw);
        return normalizeKnowledge(w, rawObj);
      }

      /* 完整性校验：缺失字段时做一次针对性补全，避免模型偶尔漏项 */
      function missingFields(k) {
        var missing = [];
        if (!k.meanings.length) {
          missing.push('meanings');
        } else {
          var missingPos = false;
          var missingExample = false;
          for (var i = 0; i < k.meanings.length; i++) {
            var m = k.meanings[i];
            if (!m.pos) missingPos = true;
            if (!m.exampleEn && !m.exampleZh) missingExample = true;
          }
          if (missingPos) missing.push('meanings.pos');
          if (missingExample) missing.push('meanings.examples');
        }
        if (!Array.isArray(rawObj.variants) || !k.variants.length) missing.push('variants');
        if (!k.phrases.length) missing.push('phrases');
        if (!k.etymology || (!k.etymology.root && !k.etymology.origin)) missing.push('etymology');
        return missing;
      }

      function mergeFollowUp(k, k2, missing) {
        var s = missing.join(',');
        var needsFullMeanings = s.indexOf('meanings.pos') !== -1 || s.indexOf('meanings') !== -1;
        if (needsFullMeanings && k2.meanings.length) {
          /* pos 缺失或 meanings 整体缺失：用补全结果替换，同时保留已有例句 */
          k.meanings = k2.meanings.map(function (m2, i) {
            var old = k.meanings[i];
            if (old && (old.exampleEn || old.exampleZh) && !m2.exampleEn && !m2.exampleZh) {
              m2.exampleEn = old.exampleEn;
              m2.exampleZh = old.exampleZh;
            }
            return m2;
          });
        } else {
          /* 只缺例句：按 pos+zh 匹配，匹配不上时退化为按索引 */
          k.meanings.forEach(function (m, i) {
            if (m.exampleEn || m.exampleZh) return;
            var matched = null;
            for (var j = 0; j < k2.meanings.length; j++) {
              if (k2.meanings[j].pos === m.pos && k2.meanings[j].zh === m.zh &&
                  (k2.meanings[j].exampleEn || k2.meanings[j].exampleZh)) {
                matched = k2.meanings[j];
                break;
              }
            }
            if (!matched && k2.meanings[i] && (k2.meanings[i].exampleEn || k2.meanings[i].exampleZh)) {
              matched = k2.meanings[i];
            }
            if (matched) {
              m.exampleEn = matched.exampleEn;
              m.exampleZh = matched.exampleZh;
            }
          });
        }
        if (s.indexOf('variants') !== -1) k.variants = k2.variants || [];
        if (s.indexOf('phrases') !== -1 && k2.phrases.length) k.phrases = k2.phrases;
        if (s.indexOf('etymology') !== -1 && k2.etymology && (k2.etymology.root || k2.etymology.origin)) {
          k.etymology = k2.etymology;
        }
        return k;
      }

      var k = null;
      var lastRaw = '';
      try {
        lastRaw = await callGLM([{ role: 'user', content: prompt }], 1600, true, 0.2);
        k = parseOnce(lastRaw);
      } catch (firstErr) {
        /* JSON 偶发瑕疵：带上原文让模型修一次，用户无需手动刷新 */
        var retryPrompt =
          '你上一次返回的内容无法被 JSON.parse 解析。请把它修正为合法的 JSON 对象，' +
          '保持 meanings / variants / phrases 结构不变，只返回 JSON，不要代码块和解释。\n' +
          '解析错误：' + (firstErr && firstErr.message ? firstErr.message : '未知') + '\n' +
          '上一次返回：\n' + (lastRaw || '（无内容）');
        k = parseOnce(await callGLM([{ role: 'user', content: retryPrompt }], 1600, true, 0.2));
      }

      /* 缺字段时再补一次；仍失败就保留已有内容，不阻塞学习 */
      var missing = missingFields(k);
      if (missing.length) {
        try {
          var hint = '';
          if (missing.indexOf('meanings.pos') !== -1) {
            hint = '\n注意：meanings 数组中每个对象的 "pos" 字段（词性缩写，如 "n." "v." "adj."）不能为空字符串，' +
              '请重新生成完整的 meanings 数组，每项都必须包含 pos、zh、exampleEn、exampleZh。';
          }
          var followPrompt =
            '你上一次返回的 JSON 缺少以下内容：' + missing.join('、') + '。\n' +
            '请只返回一个完整的 JSON 对象，保持 meanings / variants / phrases 结构，' +
            '已提供的部分不要改动，只补全缺失内容；确实没有 variants 时返回空数组。' +
            hint + '\n上一次返回：\n' + lastRaw;
          var k2 = parseOnce(await callGLM([{ role: 'user', content: followPrompt }], 1600, true, 0.2));
          k = mergeFollowUp(k, k2, missing);
        } catch (e) { /* 保留首次结果 */ }
      }
      Utils.setKnowledge(w.en, k);
      return k;
    })();
    inflight.set(key, p);
    p.then(function () { if (inflight.get(key) === p) inflight.delete(key); },
      function () { if (inflight.get(key) === p) inflight.delete(key); });
    return p;
  }

  /* readme 7.3：点击“开始学习”后，后台批量生成（队列间隔 1 秒） */
  /* ================= 预生成（并发队列） ================= */

  function isCached(w) {
    var c = Utils.getKnowledge(w.en);
    return c && (c.v === 2 || c.v === 3) && c.etymology;
  }

  function pregenWords(idList, token, getPriority) {
    var inFlight = 0;
    var running = {};  // id -> true，追踪正在请求的词
    var scheduled = false;

    function schedule() {
      if (token !== S.pregenToken) return;
      if (scheduled) return;       // 已有延迟调度排队，避免重复
      scheduled = true;
      setTimeout(doSchedule, 0);   // 延迟到下一个宏任务，避免同步递归链阻塞 UI
    }

    function doSchedule() {
      scheduled = false;
      if (token !== S.pregenToken) return;
      var launched = 0;
      while (inFlight < PREGEN_CONCURRENCY) {
        var id = pickNext();
        if (!id) return;
        launch(id);
        launched++;
      }
      /* 连续 launch 多个已缓存词时，每个 .then 会同步触发 schedule → doSchedule，
         仍然可能堆积；超过一批次后主动让出主线程。 */
      if (launched >= PREGEN_CONCURRENCY) {
        var anyUncached = false;
        for (var i = 0; i < idList.length; i++) {
          var w = findWordById(idList[i]);
          if (w && !isCached(w)) { anyUncached = true; break; }
        }
        if (!anyUncached) return;  // 全部已缓存，不再继续调度
      }
    }

    function pickNext() {
      // 优先：当前正在显示的词
      var priorityId = getPriority ? getPriority() : null;
      if (priorityId && !running[priorityId]) {
        var pw = findWordById(priorityId);
        if (pw && !isCached(pw)) return priorityId;
      }
      // 其次：按列表顺序找下一个未缓存、未在请求中的词
      for (var i = 0; i < idList.length; i++) {
        if (running[idList[i]]) continue;
        var w = findWordById(idList[i]);
        if (w && !isCached(w)) return idList[i];
      }
      return null;
    }

    function launch(id) {
      var w = findWordById(id);
      if (!w) return;
      /* 已缓存的词直接跳过，不进入 fetchKnowledge，避免 .then 同步回调链阻塞主线程 */
      if (isCached(w)) return;
      inFlight++;
      running[id] = true;
      fetchKnowledge(w, false).then(function () {
        inFlight--;
        delete running[id];
        schedule();
      }, function () {
        inFlight--;
        delete running[id];
        schedule();
      });
    }

    schedule();
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* ---------------- 追问 AI（流式输出） ---------------- */

  /* 优先走 SSE 真流式；浏览器不支持时退化为整段返回后逐字打字机输出
   * v1.23.0 修：推理模型（DeepSeek V4 / GLM-Z1 等）会先流 reasoning_content（思考）再流 content。
   *   ① 只读 delta.content 会导致「思考全能收到、正文一个字都没有」→ 一直提示「没有收到回答」；
   *   ② 思考同样占用 max_tokens，预算太小会出现 finish_reason=length 且 content 为空。
   *   所以：两路 delta 都读，且没拿到正文时自动放大预算重试一次。 */
  async function callGLMStream(messages, onDelta, maxTokens, onThinking) {
    var cfg = requireAIConfig();
    var budget = Math.max(Number(maxTokens) || 0, 2000);
    var budgetSteps = 0, degradations = 0;   // 各自最多一次：避免无限加码把 token 烧光
    while (true) {
      var noThink = needsThinkingOff();
      var out;
      try {
        out = await streamOnce(cfg, messages, budget, onDelta, onThinking, noThink);
      } catch (err) {
        if (noThink && isParamRejection(err) && degradations < 1) {   // 服务商不认关思考参数 → 去掉重试
          reasoningEffortRejected = true;
          degradations++;
          continue;
        }
        throw err;
      }
      if (out.content.trim()) return out;
      if (budgetSteps < 1) {                 // 思考吃光了预算 → 加码一次
        budgetSteps++;
        budget = Math.max(budget * 3, 6000);
        if (onThinking) onThinking(true);
        continue;
      }
      return out;                            // 已试过一轮，如实返回（上层给可读提示）
    }
  }

  async function streamOnce(cfg, messages, maxTokens, onDelta, onThinking, noThink) {
    var reqBody = {
      model: cfg.model,
      messages: messages,
      temperature: 0.7,
      max_tokens: maxTokens,
      stream: true
    };
    if (noThink) reqBody.reasoning_effort = 'none';
    var res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(reqBody)
    });

    if (!res.ok) {
      var detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch (e) { /* 忽略 */ }
      throw new Error('AI 请求失败 ' + res.status + (detail ? '：' + detail : ''));
    }

    var content = '', reasoning = '', finish = '';

    /* 逐行解析 SSE：同时吃 content / reasoning_content，并记住 finish_reason */
    function feed(text) {
      var lines = String(text).split('\n');
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (line.indexOf('data:') !== 0) continue;
        var data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        var json;
        try { json = JSON.parse(data); } catch (e) { continue; }
        var ch = json && json.choices && json.choices[0];
        if (!ch) continue;
        if (ch.finish_reason) finish = ch.finish_reason;
        var d = ch.delta || (ch.message || {});
        if (d.reasoning_content) {
          reasoning += d.reasoning_content;
          if (!content && onThinking) onThinking(false);   // 让 UI 显示“思考中”
        }
        if (d.content) {
          content += d.content;
          onDelta(d.content);
        }
      }
    }

    if (!res.body || !res.body.getReader) {
      /* 不支持流式读取：整段返回，再逐字输出 */
      var full = await res.json();
      var msg = full && full.choices && full.choices[0] && full.choices[0].message;
      var whole = String(msg && msg.content || '');
      reasoning = String(msg && msg.reasoning_content || '');
      if (!whole && !reasoning) throw new Error('AI 返回为空');
      for (var i = 0; i < whole.length; i += 2) {
        content += whole.slice(i, i + 2);
        onDelta(whole.slice(i, i + 2));
        await delay(16);
      }
      return { content: content, reasoning: reasoning, finish: '' };
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    while (true) {
      var step = await reader.read();
      if (step.done) break;
      buf += decoder.decode(step.value, { stream: true });
      var parts = buf.split('\n');
      buf = parts.pop();
      feed(parts.join('\n'));
    }
    if (buf.trim()) feed(buf);
    return { content: content, reasoning: reasoning, finish: finish };
  }

  async function askAI() {
    var input = $('aiInput');
    var q = input.value.trim();
    if (!q) return;
    if (S.busyAI) { Utils.toast('上一条还在生成，请稍等'); return; }
    var w = currentWord();
    if (!w || !S.knowledgeOpen) return;

    S.busyAI = true;
    var sendBtn = $('aiSend');
    sendBtn.disabled = true;
    input.value = '';

    var box = $('aiMessages');
    appendBubble('user', q);

    var thinking = document.createElement('div');
    thinking.className = 'ai-bubble typing';
    box.appendChild(thinking);
    box.scrollTop = box.scrollHeight;

    var acc = '';
    try {
      /* 每个单词独立上下文：只把当前词的问答历史带给 AI */
      var key = w.id;
      var history = S.aiChats[key] || (S.aiChats[key] = []);
      var messages = [{
        role: 'system',
        content:
          getPersona() + '\n' +
          '用户正在学习单词"' + w.en + '"（释义：' + w.zh + '）。\n' +
          '回答要简短：默认 2–3 句、100 字以内；用户要例句时最多给 2 条例句。不要长篇大论，不要重复问题。\n' +
          '用纯文本回答，不要使用 Markdown：不要用 ** 加粗、# 标题、- 或 1. 列表、`代码`、``` 代码块、表格。\n' +
          '如果用户的问题与前面的对话有关，请结合上下文回答。'
      }];
      for (var hi = 0; hi < history.length; hi++) {
        messages.push({ role: history[hi].role, content: history[hi].content });
      }
      messages.push({ role: 'user', content: q });
      history.push({ role: 'user', content: q });   // 先记录，生成失败再回滚，避免留下悬空问题

      var streamOut = await callGLMStream(messages, function (delta) {
        acc += delta;
        thinking.textContent = acc;
        box.scrollTop = box.scrollHeight;
      }, 800, function (retrying) {
        /* 推理模型先出思考：给个“思考中”状态；重试时也提示一下 */
        if (!acc) thinking.textContent = retrying ? '思考较长，正在重试…' : '思考中…';
      });
      thinking.classList.remove('typing');
      if (!acc.trim()) {
        /* 有思考但没正文通常是 token 预算被思考吃光 */
        thinking.textContent = (streamOut && streamOut.reasoning)
          ? '这次没有收到回答（模型思考过长被截断），请再问一次。'
          : '这次没有收到回答，请再问一次。';
      } else {
        history.push({ role: 'assistant', content: acc.trim() });   // 保存本词上下文供后续追问
      }
    } catch (err) {
      /* 失败时回滚刚写入的问题，保持上下文干净 */
      var key = w.id;
      var history = S.aiChats[key];
      if (history && history.length &&
          history[history.length - 1].role === 'user' &&
          history[history.length - 1].content === q) {
        history.pop();
      }
      thinking.classList.remove('typing');
      thinking.className = 'ai-bubble error';
      thinking.textContent = '追问失败：' + (err && err.message ? err.message : '未知错误');
    } finally {
      S.busyAI = false;
      sendBtn.disabled = false;
      box.scrollTop = box.scrollHeight;
    }
  }

  function appendBubble(type, text) {
    var box = $('aiMessages');
    var div = document.createElement('div');
    div.className = 'ai-bubble' + (type === 'user' ? ' user' : '');
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  /* 渲染当前单词的追问记录；不同单词用各自的 aiChats，互不可见 */
  function renderAIChat(wordId) {
    var box = $('aiMessages');
    box.innerHTML = '';
    var history = S.aiChats[wordId] || [];
    for (var i = 0; i < history.length; i++) {
      appendBubble(history[i].role === 'user' ? 'user' : 'ai', history[i].content);
    }
  }

  /* ---------------- 知识卡 → 下一词 ---------------- */

  function bindKnowledgeGesture() {
    var sheet = $('kcSheet');
    var drag = null;

    function clearDrag() {
      drag = null;
      $('kcNextHint').classList.remove('armed');
    }

    function canStart(e) {
      return S.knowledgeOpen && !e.target.closest('input, button, textarea, a, .ai-row');
    }

    /* 方向约定（页面视角）：
       - 上滑页面 = 手指下滑（内容向上走，往顶端去）；
       - 下滑页面 = 手指上滑（内容向下走，往底端去）。
       边界触发：
       - 页面顶端 + 再上滑页面 = 改为“记不清”并跳过（仅刚标“记得”时可改）；
       - 页面底端 + 再下滑页面 = 直接跳过，不改熟练度；
       - 中间位置：上滑/下滑页面都只是普通滚动。 */
    sheet.addEventListener('touchstart', function (e) {
      if (!canStart(e)) return;
      if (e.touches.length !== 1) { clearDrag(); return; }
      drag = {
        y: e.touches[0].clientY,
        startedAtTop: kcAtTop(),
        startedAtBottom: kcAtBottom()
      };
    }, { passive: true });

    sheet.addEventListener('touchmove', function (e) {
      if (!drag || e.touches.length !== 1) return;
      var dy = e.touches[0].clientY - drag.y;   // >0 手指下滑 = 页面向上；<0 手指上滑 = 页面向下
      var hint = $('kcNextHint');
      var topGesture = dy > 6 && drag.startedAtTop && kcAtTop();          // 顶端再上滑页面
      var bottomGesture = dy < -6 && drag.startedAtBottom && kcAtBottom(); // 底端再下滑页面
      if (topGesture || bottomGesture) {
        hint.classList.add('armed');
        if (e.cancelable) e.preventDefault();
      } else {
        hint.classList.remove('armed');
      }
    }, { passive: false });

    sheet.addEventListener('touchend', function (e) {
      if (!drag) return;
      var t = e.changedTouches[0];
      var dy = t ? t.clientY - drag.y : 0;
      var pageUpAtTop = dy > SWIPE_THRESHOLD && drag.startedAtTop && kcAtTop();
      var pageDownAtBottom = dy < -SWIPE_THRESHOLD && drag.startedAtBottom && kcAtBottom();
      clearDrag();
      if (pageUpAtTop) {
        if (correctionAvailable()) correctGradeToUnsure();
        kcNext();
      } else if (pageDownAtBottom) {
        kcNext();
      }
    });

    sheet.addEventListener('touchcancel', clearDrag);

    /* 鼠标：与触摸一致 */
    sheet.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || !canStart(e)) return;
      drag = {
        y: e.clientY,
        id: e.pointerId,
        startedAtTop: kcAtTop(),
        startedAtBottom: kcAtBottom()
      };
    });
    sheet.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse' || !drag || drag.id !== e.pointerId) return;
      var dy = e.clientY - drag.y;
      var hint = $('kcNextHint');
      if ((dy > 6 && drag.startedAtTop && kcAtTop()) ||
          (dy < -6 && drag.startedAtBottom && kcAtBottom())) {
        hint.classList.add('armed');
      } else {
        hint.classList.remove('armed');
      }
    });
    sheet.addEventListener('pointerup', function (e) {
      if (e.pointerType !== 'mouse' || !drag || drag.id !== e.pointerId) return;
      var dy = e.clientY - drag.y;
      var pageUpAtTop = dy > SWIPE_THRESHOLD && drag.startedAtTop && kcAtTop();
      var pageDownAtBottom = dy < -SWIPE_THRESHOLD && drag.startedAtBottom && kcAtBottom();
      clearDrag();
      if (pageUpAtTop) {
        if (correctionAvailable()) correctGradeToUnsure();
        kcNext();
      } else if (pageDownAtBottom) {
        kcNext();
      }
    });
    sheet.addEventListener('pointercancel', clearDrag);

    /* 桌面滚轮：上滚 = 上滑页面；下滚 = 下滑页面 */
    var wheelLock = false;
    sheet.addEventListener('wheel', function (e) {
      if (!S.knowledgeOpen || wheelLock) return;
      if (e.deltaY < -24 && kcAtTop()) {
        wheelLock = true;
        setTimeout(function () { wheelLock = false; }, 700);
        if (correctionAvailable()) correctGradeToUnsure();
        kcNext();
      } else if (e.deltaY > 24 && kcAtBottom()) {
        wheelLock = true;
        setTimeout(function () { wheelLock = false; }, 700);
        kcNext();
      }
    });
  }

  function kcAtBottom() {
    var sheet = $('kcSheet');
    return sheet.scrollTop + sheet.clientHeight >= sheet.scrollHeight - 40;
  }

  function kcAtTop() {
    var sheet = $('kcSheet');
    return sheet.scrollTop <= 40;
  }

  function kcNext() {
    if (!S.knowledgeOpen) return;
    S.knowledgeOpen = false;
    var overlay = $('knowledgeOverlay');

    /* 知识卡淡出与下一张卡片滑入并行，不再“先等退场” */
    overlay.classList.add('closing');
    clearTimeout(overlayHideTimer);
    overlayHideTimer = setTimeout(function () {
      overlay.classList.add('hidden');
      overlay.classList.remove('closing');
      overlayHideTimer = null;
    }, 200);

    if (dictState) {
      dictNext();
      return;
    }
    S.index++;
    if (S.index >= S.list.length) {
      showDone();
    } else {
      showCard(S.index);   // 立即从底部滑入，不需要等待；showCard 会同步“返回上一个单词”的显示状态
    }
  }

  /* ---------------- 结束 / 退出 ---------------- */

  function showDone() {
    var stats = Utils.computeStats(S.data);
    var today = Utils.todayStr();
    var doneToday = Number(S.data.dailyHistory[today]) || 0;
    var goal = S.data.dailyGoal;
    var over = doneToday > goal ? doneToday - goal : 0;
    var list = $('doneStats');
    list.innerHTML =
      '<li><b>' + S.list.length + '</b>本次学习词数</li>' +
      '<li><b>' + doneToday + ' / ' + goal + '</b>今日累计 / 目标' + (over ? '（超 ' + over + '）' : '') + '</li>' +
      '<li><b>' + stats.mastered + '</b>已掌握</li>' +
      '<li><b>' + S.streak + '</b>最后连续答对</li>';
    $('doneOverlay').classList.remove('hidden');
    Utils.saveData(S.data);
  }

  /* 目标已达成却再次点“开始学习”时：先提醒，由用户决定是否超额 */
  function showGoalOverlay() {
    var today = Utils.todayStr();
    S.data.goalRemindedDate = today;
    Utils.saveData(S.data);
    var doneToday = Number(S.data.dailyHistory[today]) || 0;
    var goal = S.data.dailyGoal;
    var over = doneToday > goal ? doneToday - goal : 0;
    $('goalStats').innerHTML =
      '<li><b>' + doneToday + '</b>今日已背</li>' +
      '<li><b>' + goal + '</b>每日目标</li>' +
      (over > 0 ? '<li><b>' + over + '</b>已超额</li>' : '');
    $('goalOverlay').classList.remove('hidden');
  }

  function exitStudy() {
    if (ttsAbort) { ttsAbort.abort(); ttsAbort = null; }
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    Utils.saveData(S.data);   // 立即落盘，返回概览页时统计一定是最新的
    hideKnowledge(true);
    $('studyPage').classList.add('hidden');
    var overview = $('overviewPage');
    overview.classList.remove('hidden');
    overview.querySelector('.overview').classList.remove('page-enter');
    void overview.querySelector('.overview').offsetWidth;
    overview.querySelector('.overview').classList.add('page-enter');
    $('doneOverlay').classList.add('hidden');
    renderOverview();
  }


  /* ---------------- 听写复习 ---------------- */

  function collectDueWords() {
    var now = new Date();
    var due = [];
    for (var i = 0; i < S.data.words.length; i++) {
      var w = S.data.words[i];
      if (w.inHardPool || (w.fsrsCard && w.fsrsCard.due && new Date(w.fsrsCard.due) <= now)) {
        due.push(w);
      }
    }
    return Utils.shuffle(due);
  }

  function startDictation() {
    var due = collectDueWords();
    if (!due.length) { Utils.toast('没有需要听写的词'); return; }
    dictState = { list: due, index: 0, attempts: 0, hintUsed: false };
    S.aiChats = {};
    $('overviewPage').classList.add('hidden');
    $('dictationPage').classList.remove('hidden');
    $('dictationPage').classList.remove('page-enter');
    void $('dictationPage').offsetWidth;
    $('dictationPage').classList.add('page-enter');
    S.pregenToken++;
    pregenWords(dictState.list.map(function (w) { return w.id; }), S.pregenToken);
    dictShowWord();
  }

  function dictShowWord() {
    var w = dictState.list[dictState.index];
    dictState.attempts = 0;
    dictState.hintUsed = false;
    $('dictInput').value = '';
    $('dictInput').classList.remove('wrong');
    $('dictFeedback').classList.add('hidden');
    $('dictFeedback').textContent = '';
    $('dictProgress').textContent = (dictState.index + 1) + ' / ' + dictState.list.length;
    $('dictInput').focus();
    speakEn(w.en);
  }

  function dictCheck() {
    if (!dictState) return;
    var w = dictState.list[dictState.index];
    var input = $('dictInput').value.trim().toLowerCase();
    if (!input) return;
    dictState.attempts++;

    if (input === w.en.toLowerCase()) {
      var grade = (dictState.attempts === 1 && !dictState.hintUsed) ? GRADE.GOOD : GRADE.AGAIN;
      applyRating(w, grade);
      dictShowKnowledge(w);
    } else {
      $('dictInput').classList.add('wrong');
      $('dictFeedback').textContent = '拼写错误，请重试';
      $('dictFeedback').classList.remove('hidden');
      $('dictInput').value = '';
      speakEn(w.en);
      setTimeout(function () { $('dictInput').classList.remove('wrong'); }, 400);
    }
  }

  function dictShowAnswer() {
    if (!dictState) return;
    var w = dictState.list[dictState.index];
    dictState.hintUsed = true;
    applyRating(w, GRADE.AGAIN);
    w.inHardPool = true;
    scheduleSave();
    dictShowKnowledge(w);
  }

  function dictShowKnowledge(w) {
    S.list = dictState.list;
    S.index = dictState.index;
    S.knowledgeOpen = true;
    S.fullCard = true;

    var overlay = $('knowledgeOverlay');
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
    overlay.classList.remove('hidden', 'closing');
    $('studyRefresh').classList.remove('hidden');
    $('kcRefresh').classList.remove('hidden');
    $('kcSheet').scrollTop = 0;
    $('kcNextHint').classList.remove('hidden');
    $('kcNextHint').textContent = '底部再下滑 = 下一个词';
    $('aiInput').value = '';
    renderAIChat(w.id);
    ensureKnowledge(w, false);
  }

  function dictNext() {
    dictState.index++;
    if (dictState.index >= dictState.list.length) {
      hideKnowledge(true);
      $('dictationPage').classList.add('hidden');
      var overview = $('overviewPage');
      overview.classList.remove('hidden');
      overview.querySelector('.overview').classList.remove('page-enter');
      void overview.querySelector('.overview').offsetWidth;
      overview.querySelector('.overview').classList.add('page-enter');
      Utils.saveData(S.data);
      renderOverview();
      Utils.toast('听写复习完成');
      dictState = null;
    } else {
      hideKnowledge(true);
      dictShowWord();
    }
  }

  async function dictPlayHint() {
    if (!dictState) return;
    var w = dictState.list[dictState.index];
    dictState.hintUsed = true;

    var cached = Utils.getKnowledge(w.en);
    if (cached && (cached.v === 2 || cached.v === 3) && cached.meanings && cached.meanings.length) {
      var examples = cached.meanings.filter(function (m) { return m.exampleEn; });
      if (examples.length) {
        speakEn(examples[Math.floor(Math.random() * examples.length)].exampleEn);
        return;
      }
    }

    try {
      Utils.toast('正在生成例句...');
      var text = await callGLM([{
        role: 'user',
        content: '请为单词"' + w.en + '"（' + w.zh + '）写一个英文例句，只返回JSON：{"en":"例句","zh":"翻译"}'
      }], 200, true, 0.7);
      var obj = extractJson(text);
      if (obj && obj.en) {
        speakEn(obj.en);
      } else {
        Utils.toast('AI 未能生成例句');
      }
    } catch (e) {
      Utils.toast('生成例句失败：' + e.message, 'error');
    }
  }

  function dictExit() {
    if (ttsAbort) { ttsAbort.abort(); ttsAbort = null; }
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    hideKnowledge(true);
    $('dictationPage').classList.add('hidden');
    var overview = $('overviewPage');
    overview.classList.remove('hidden');
    overview.querySelector('.overview').classList.remove('page-enter');
    void overview.querySelector('.overview').offsetWidth;
    overview.querySelector('.overview').classList.add('page-enter');
    Utils.saveData(S.data);
    renderOverview();
    dictState = null;
  }


  /* ---------------- 设置：导入 / 重置 ---------------- */

  /* ---------------- 设置：数据备份 / 恢复 ---------------- */

  /* 写一遍这个单词（v1.19.0）：对用户输入做纯字符串比对，不触发 FSRS、无算法。
     目标单词取「知识页当前显示的单词」（.kc-en），不依赖学习会话变量，任何入口都能用。 */
  function checkWriteWord() {
    var inp = $('kcWriteInput');
    var fb = $('kcWriteFeedback');
    var targetEl = document.querySelector('#kcContent .kc-en');
    var target = targetEl ? targetEl.textContent.trim() : '';
    var guess = inp.value.trim();
    fb.classList.remove('hidden');
    if (!target) {
      fb.textContent = '暂无目标单词，请先打开单词知识页。';
      fb.className = 'kc-write-feedback wrong';
      return;
    }
    if (!guess) {
      fb.textContent = '请输入单词。';
      fb.className = 'kc-write-feedback wrong';
      return;
    }
    var correct = (guess.toLowerCase() === target.toLowerCase());
    if (correct) {
      fb.textContent = '拼写正确';
      fb.className = 'kc-write-feedback ok';
      setTimeout(function () {
        fb.classList.add('hidden');
        inp.value = '';
        $('kcWriteInputWrap').classList.add('hidden');
      }, 1200);
    } else {
      fb.textContent = '拼写不对，请再试一次。';
      fb.className = 'kc-write-feedback wrong';
      inp.value = '';
      inp.focus();
    }
  }

  function exportBackup() {
    try {
      var backup = {
        app: 'cet6study',
        exportedAt: new Date().toISOString(),
        study: S.data,
        knowledge: Utils.loadKnowledge()
      };
      var name = '六级背单词备份-' + Utils.todayStr() + '.json';
      var data = JSON.stringify(backup);

      /* v1.19.0：App 内优先用原生“保存到…”文件选择（用户选位置写入）；
         网页 / 其它环境回退到浏览器下载。 */
      var Save = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SaveDocument;
      if (Save && typeof Save.save === 'function') {
        var base64;
        try {
          base64 = btoa(unescape(encodeURIComponent(data)));   // 兼容中文 → base64
        } catch (e) {
          base64 = btoa(data);
        }
        Save.save({ fileName: name, mimeType: 'application/json', data: base64 })
          .then(function () {
            Utils.toast('备份已保存到你选择的位置', 'success');
          })
          .catch(function (err) {
            var msg = err && err.message ? err.message : '用户取消或保存失败';
            Utils.toast('导出未完成：' + msg, 'error');
          });
        return;
      }

      var blob = new Blob([data], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
      Utils.toast('备份已下载，请保存到安全位置', 'success');
    } catch (err) {
      Utils.toast('导出失败：' + (err && err.message ? err.message : '未知错误'), 'error');
    }
  }

  function handleRestoreBackup() {
    var fileInput = $('importBackupFile');
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var backup = null;
      try {
        backup = JSON.parse(reader.result);
      } catch (e) {
        Utils.toast('备份文件不是有效的 JSON', 'error');
        fileInput.value = '';
        return;
      }
      var study = (backup && backup.study) || backup;
      var knowledge = backup && backup.knowledge ? backup.knowledge : null;
      var normalized = Utils.normalizeStudyData(study);
      if (!Array.isArray(normalized.words) || !normalized.words.length) {
        Utils.toast('备份里没有词库数据，已取消恢复', 'error');
        fileInput.value = '';
        return;
      }
      if (!window.confirm('确定用这份备份覆盖当前学习数据吗？')) {
        fileInput.value = '';
        return;
      }
      S.data = normalized;
      S.data.revision = Date.now();           // 用户主动恢复：让这份备份成为最新版本，优先于服务器旧数据
      Utils.saveData(S.data);                 // revision 自动 +1，会同步覆盖服务器
      if (knowledge && typeof knowledge === 'object') {
        Utils.saveKnowledge(knowledge);
      }
      renderOverview();
      Utils.toast('备份已恢复', 'success');
      fileInput.value = '';
    };
    reader.onerror = function () {
      Utils.toast('备份文件读取失败', 'error');
      fileInput.value = '';
    };
    reader.readAsText(file, 'utf-8');
  }

  function handleImport() {
    var fileInput = $('importFile');
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var entries = Utils.parseImportTxt(reader.result);
      if (!entries.length) {
        Utils.toast('没有解析到词条，请使用“英文 - 中文”格式', 'error');
        fileInput.value = '';
        return;
      }
      var existing = {};
      S.data.words.forEach(function (w) { existing[w.en.toLowerCase()] = true; });
      var added = 0, skipped = 0;
      entries.forEach(function (entry) {
        var key = entry.en.toLowerCase();
        if (existing[key]) { skipped++; return; }
        existing[key] = true;
        S.data.words.push(Utils.makeWordRecord(entry, S.data.words.length));
        added++;
        _wordById = null;
      });
      Utils.saveData(S.data);
      renderOverview();
      Utils.toast('导入完成：新增 ' + added + ' 词，跳过重复 ' + skipped + ' 词', 'success');
      fileInput.value = '';
    };
    reader.onerror = function () {
      Utils.toast('文件读取失败', 'error');
      fileInput.value = '';
    };
    reader.readAsText(file, 'utf-8');
  }

  function resetProgress() {
    if (!window.confirm('确定重置所有学习进度吗？词库、主题和 API Key 会保留。')) return;
    S.data.words.forEach(function (w) {
      w.lastRating = 0;
      w.inHardPool = false;
      w.fsrsCard = null;   // 回到新词状态，第一次评分时 createEmptyCard
    });
    S.data.learnedIds = [];
    S.data.wrongIds = [];
    S.data.dailyHistory = {};
    S.data.sessionDate = '';
    S.data.consecutiveDays = 0;
    S.data.goalRemindedDate = '';
    Utils.saveData(S.data);
    renderOverview();
    Utils.toast('学习进度已重置', 'success');
  }

  function wipeAll() {
    if (!window.confirm('确定清空全部数据吗？本机的词库、设置、缓存都会删除。')) return;
    Utils.clearAllStorage().then(function () {
      location.reload();
    }).catch(function () {
      location.reload();
    });
  }

  /* ---------------- 启动 ---------------- */
  init();
})();
