(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // API 服务地址（CloudBase HTTP 网关域名）
  const API_BASE = "https://YOUR_ENV_ID.ap-shanghai.app.tcloudbase.com"; // TODO: 替换为你的 CloudBase 环境 HTTP 网关域名（见 README 部署步骤 4）

  const S = {
    token: localStorage.getItem("wb_token") || null,
    username: localStorage.getItem("wb_user") || null,
    vocab: [], vmap: {}, progress: {}, settings: { dailyGoal: 100 },
    outbox: JSON.parse(localStorage.getItem("wb_outbox") || "[]"),
    deviceId: (function () {
      const d = localStorage.getItem("wb_device");
      if (d) return d;
      const n = "dev_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem("wb_device", n);
      return n;
    })(),
    current: null,
    mode: "new",              // 'review' 复习中 | 'new' 新题练习
    studyMode: localStorage.getItem("wb_study_mode") || "quiz",  // 'quiz' 四选一 | 'card' 卡片
    pending: [],              // 待复习队列（word 对象）
    answered: false,
    options: [],              // 当前题四选项 [{text, correct}]
    history: [],              // 答题历史（上一题回退）
    // ---- 会话内调度（防止错题立即反复出现）----
    qCount: 0,                // 本会话已答题目计数
    sessionDone: {},          // word -> true 本会话已答对（新题模式不再出）
    defer: [],                // [{word, at}] 答错稍后重现队列
    deferCount: {},           // word -> 本会话答错次数（用于封顶）
    reWrong: {},              // word -> 复习队列内重现次数（封顶 2 次）
    autoTimer: null,          // 答对自动进入下一题的定时器
  };
  const LV = ["未学", "模糊", "认识", "掌握"];

  // ---------- API ----------
  // 注册/登录/同步统一走 GET 查询参数，规避部分国内网络对 POST body 的拦截
  async function api(path, opts) {
    opts = opts || {};
    const headers = {};
    if (S.token) headers["Authorization"] = "Bearer " + S.token;
    let url = API_BASE + path;
    if (opts.body !== undefined) {
      url += "?" + new URLSearchParams(opts.body).toString();
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000); // 12s 超时，防止网络卡死
    try {
      const res = await fetch(url, { method: "GET", headers, signal: ctrl.signal });
      if (res.status === 401) {
        // 公开接口（login/register/reset-password）的 401 是业务错误（用户不存在/密码错误/恢复码错），由调用方展示具体原因，不要触发 logout
        if (path === "/api/login" || path === "/api/register" || path === "/api/reset-password") {
          return await res.json().catch(() => ({}));
        }
        // 受保护接口的 401 才是 token 失效
        logout();
        throw new Error("登录已失效，请重新登录");
      }
      return await res.json().catch(() => ({})); // 响应体异常也返回空对象而非抛错
    } finally { clearTimeout(timer); }
  }

  // ---------- SRS（前端镜像，与后端一致） ----------
  function applySRS(s, rating) {
    let level = s.level || 0, iv = s.interval_days || 0, ease = s.ease || 2.5, reps = s.reps || 0, laps = s.lapses || 0;
    if (rating < 3) { reps = 0; iv = 1; level = Math.max(0, level - 1); laps += 1; }
    else {
      // 快速刷一轮模式：答对 = 会了，本轮不再复习（due_at 推到一年后）；错题本词由外层逻辑次日复习直到毕业
      iv = Math.max(iv, 365);
      reps += 1;
      level = 3;
    }
    return { level, interval_days: iv, ease, reps, lapses: laps, due_at: Date.now() + iv * 86400000 };
  }

  // ---------- 认证 ----------
  let authMode = "login";
  function initAuth() {
    $$(".tab").forEach((t) => (t.onclick = () => {
      authMode = t.dataset.auth;
      $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
      $("#auth-submit").textContent = authMode === "login" ? "登录" : "注册";
    }));
    $("#auth-form").onsubmit = async (e) => {
      e.preventDefault();
      const u = $("#auth-user").value.trim(), p = $("#auth-pass").value;
      $("#auth-msg").textContent = "";
      if (!u || !p) { $("#auth-msg").textContent = "请输入用户名和密码"; return; }
      try {
        const r = authMode === "login"
          ? await api("/api/login", { method: "POST", body: { username: u, password: p } })
          : await api("/api/register", { method: "POST", body: { username: u, password: p } });
        if (r.error) { $("#auth-msg").textContent = r.error; return; }
        S.token = r.token; S.username = r.username;
        localStorage.setItem("wb_token", r.token); localStorage.setItem("wb_user", r.username);
        await boot();
      } catch (err) { $("#auth-msg").textContent = String(err.message || err); }
    };
  }
  function logout() {
    S.token = null; S.username = null;
    S.progress = {}; S.outbox = []; S.history = []; S.pending = []; S.current = null;
    localStorage.removeItem("wb_token"); localStorage.removeItem("wb_user"); localStorage.removeItem("wb_outbox");
    $("#app").classList.add("hidden"); $("#auth").classList.remove("hidden");
  }
  // 忘记密码：切换重置表单 / 提交重置
  function initReset() {
    const bf = $("#btn-forgot"), br = $("#btn-back-login");
    if (bf) bf.onclick = () => {
      $("#auth-form").classList.add("hidden"); bf.classList.add("hidden");
      $("#reset-form").classList.remove("hidden");
      $("#auth-msg").textContent = ""; $("#rs-msg").textContent = "";
    };
    if (br) br.onclick = () => {
      $("#reset-form").classList.add("hidden");
      $("#auth-form").classList.remove("hidden"); if (bf) bf.classList.remove("hidden");
      $("#rs-msg").textContent = "";
    };
    const rf = $("#reset-form");
    if (rf) rf.onsubmit = async (e) => {
      e.preventDefault();
      const u = $("#rs-user").value.trim(), k = $("#rs-key").value,
            np = $("#rs-new").value, np2 = $("#rs-new2").value;
      const msg = $("#rs-msg"); msg.textContent = "";
      if (!u || !k || !np) { msg.textContent = "请填写用户名、恢复码和新密码"; return; }
      if (np.length < 6) { msg.textContent = "新密码至少 6 位"; return; }
      if (np !== np2) { msg.textContent = "两次输入的新密码不一致"; return; }
      try {
        const r = await api("/api/reset-password", { method: "POST", body: { username: u, recovery_key: k, new_password: np } });
        if (r && r.ok) {
          msg.textContent = "✅ 密码已重置，请用新密码登录";
          $("#rs-user").value = $("#rs-key").value = $("#rs-new").value = $("#rs-new2").value = "";
          if (br) br.click();
        } else msg.textContent = (r && r.error) || "重置失败，请重试";
      } catch (err) { msg.textContent = String((err && err.message) || err); }
    };
  }

  // ---------- 启动 ----------
  async function boot() {
    $("#auth").classList.add("hidden"); $("#app").classList.remove("hidden");
    $$(".ms-item").forEach((b) => b.classList.toggle("active", b.dataset.sm === S.studyMode));
    try {
      await loadVocab();
    } catch (e) {
      // 词库加载失败：给出明确提示与重试，不再无声卡在"加载中"
      showFatal("词库加载失败，请检查网络后重试", e);
      return;
    }
    await loadState(); // 内部已 catch，失败也能用本地数据继续
    try { bindUI(); } catch (e) { showFatal("界面初始化失败，请刷新重试", e); return; }
    switchView("study"); startStudy(); updateSync("已同步"); startSyncLoop();
  }
  function showFatal(msg, err) {
    const empty = $("#study-empty");
    empty.classList.remove("hidden");
    empty.innerHTML = '<b>' + escapeHtml(msg) + '</b><br><span class="hint">' + escapeHtml((err && err.message) || "") + '</span><br><button class="btn-primary" id="btn-fatal-retry" style="margin-top:14px;">重试</button>';
    const b = $("#btn-fatal-retry"); if (b) b.onclick = () => location.reload();
  }
  async function loadVocab() {
    let lastErr = null;
    for (let i = 0; i < 3; i++) { // 自动重试 3 次
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        const res = await fetch("vocab.json", { cache: "no-cache", signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (!data || !Array.isArray(data.words) || data.words.length === 0) throw new Error("词库数据格式错误");
        S.vocab = data.words; S.vmap = {};
        S.vocab.forEach((w) => (S.vmap[w.word] = w));
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    throw lastErr || new Error("词库加载失败");
  }
  async function loadState() {
    try {
      const r = await api("/api/state");
      if (r.wordStates) for (const [w, st] of Object.entries(r.wordStates)) {
        const l = S.progress[w];
        if (!l || (st.updated_at || 0) >= (l.updated_at || 0)) S.progress[w] = st;
      }
      if (r.settings && r.settings.dailyGoal) S.settings.dailyGoal = +r.settings.dailyGoal;
    } catch (e) {}
  }

  // ---------- 同步 outbox ----------
  function saveOutbox() { localStorage.setItem("wb_outbox", JSON.stringify(S.outbox)); }
  let _flushing = false, _retryTimer = null;
  async function flush() {
    if (_flushing) return;                 // 防并发：上一次还没结束不重复发
    if (!S.token || !navigator.onLine || S.outbox.length === 0) return;
    _flushing = true;
    updateSync("同步中…");
    const batch = S.outbox.slice(0, 10); // 分块，避免 URL 过长
    try {
      const r = await api("/api/sync", { body: { ops: JSON.stringify(batch) } });
      if (r && r.ok) {
        S.outbox = S.outbox.filter((op) => !batch.includes(op)); saveOutbox();
        if (r.wordStates) for (const [w, st] of Object.entries(r.wordStates)) S.progress[w] = st;
        updateSync("已同步");
      } else updateSync("同步失败 · 稍后自动重试");
    } catch (e) {
      updateSync(navigator.onLine ? ("同步失败 · 已缓存 " + S.outbox.length + " 条") : ("离线缓存 " + S.outbox.length + " 条"));
    } finally {
      _flushing = false;
      if (S.outbox.length > 0) {           // 还有存货：10 秒后快速重试（不必等 30 秒轮询）
        clearTimeout(_retryTimer);
        _retryTimer = setTimeout(flush, 10000);
      }
    }
  }
  function startSyncLoop() {
    window.addEventListener("online", flush);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) flush(); });
    setInterval(flush, 30000);
  }
  function pushOp(op) { S.outbox.push(op); saveOutbox(); flush(); }
  function updateSync(t) {
    const el = $("#sync-state"); if (el) el.textContent = t;
    const top = $("#sync-top-text"); if (top) top.textContent = t;
    const dot = $("#sync-dot");
    if (dot) dot.className = "sync-dot " + (t.indexOf("已同步") === 0 ? "" : t.indexOf("同步中") === 0 ? "warn" : "bad");
  }

  // ---------- 学习（四选一刷题 + 卡片模式 + 错题复习系统） ----------
  function nextMidnightCST() {
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0) - 8 * 3600 * 1000;
  }
  function rand(n) { return Math.floor(Math.random() * n); }
  function stateOf(word) {
    const st = S.progress[word];
    return st ? st : {
      level: 0, interval_days: 0, ease: 2.5, reps: 0, lapses: 0, due_at: 0,
      is_wrong_book: false, ever_wrong: false, wrong_streak: 0, wrong_added_at: 0,
      wrong_count: 0, correct_count: 0, rev: 0, updated_at: 0, is_mastered: false,
    };
  }
  function dueWords() {
    const now = Date.now(), arr = [];
    S.vocab.forEach((w) => { const st = S.progress[w.word]; if (st && st.due_at <= now) arr.push(w); });
    arr.sort((a, b) => (S.progress[a.word].due_at - S.progress[b.word].due_at));
    return arr;
  }
  function wrongBookWords() {
    return S.vocab.filter((w) => { const st = S.progress[w.word]; return st && st.is_wrong_book; });
  }
  // 每次开始新的练习（复习或新题）时重置会话内调度状态
  function resetSession() {
    S.qCount = 0; S.sessionDone = {}; S.defer = []; S.deferCount = {}; S.reWrong = {}; S.history = [];
  }
  // 每天首次打开：先复习全部到期题；完成前不进新题
  function startStudy() {
    resetSession();
    const due = dueWords();
    $("#due-badge").textContent = "待复习 " + due.length;
    if (due.length > 0) {
      S.mode = "review"; S.pending = due.slice();
      $("#mode-label").textContent = "复习中 · 剩余 " + due.length + " 题";
    } else {
      S.mode = "new"; S.pending = [];
      $("#mode-label").textContent = "新题练习";
    }
    renderQuestion();
  }
  // 答错后"稍后重现"：复习队列插回后段（最多 2 次）；新题模式延迟 8 题后重现（最多 3 次）
  function scheduleRetry(word) {
    const dc = (S.deferCount[word] || 0) + 1;
    S.deferCount[word] = dc;
    if (S.mode === "review") {
      const rw = S.reWrong[word] || 0;
      if (rw < 2) {
        S.reWrong[word] = rw + 1;
        const pos = Math.min(S.pending.length, 6);
        S.pending.splice(pos, 0, S.vmap[word]);
      }
    } else if (dc <= 3) {
      S.defer.push({ word, at: S.qCount });
    }
  }
  // 新题选题：先出"稍后重现"队列（已隔 8 题），否则错题本 70% / 新词 30%
  function pickNewWord() {
    while (S.defer.length) {
      const d = S.defer[0];
      if (S.qCount - d.at >= 8) { S.defer.shift(); return S.vmap[d.word]; }
      break;
    }
    const done = S.sessionDone;
    const inDefer = (w) => S.defer.some((d) => d.word === w.word);
    const capped = (w) => (S.deferCount[w.word] || 0) >= 3;
    const wrong = wrongBookWords().filter((w) => !done[w.word] && !inDefer(w) && !capped(w));
    const fresh = S.vocab.filter((w) => {
      if (done[w.word]) return false;
      const st = S.progress[w.word];
      if (!st) return true;                                  // 纯新词
      return st.level === 0 && !st.is_mastered && !st.is_wrong_book; // 回到未学状态（含取消熟词）
    });
    if (wrong.length && fresh.length) return Math.random() < 0.7 ? wrong[rand(wrong.length)] : fresh[rand(fresh.length)];
    if (wrong.length) return wrong[rand(wrong.length)];
    if (fresh.length) return fresh[rand(fresh.length)];
    if (S.defer.length) { const d = S.defer.shift(); return S.vmap[d.word]; }
    return null;
  }
  function buildOptions(word) {
    const correct = word.meaning || "";
    const pool = S.vocab.filter((w) => w.word !== word.word && w.meaning && w.meaning !== correct);
    const dist = [], used = new Set([correct]);
    let guard = 0;
    while (dist.length < 3 && guard++ < 500) {
      const c = pool[rand(pool.length)];
      if (c && !used.has(c.meaning)) { dist.push(c.meaning); used.add(c.meaning); }
    }
    // 干扰项不足时兜底补足（只要文本与已用项不同）
    if (dist.length < 3) {
      for (const w of S.vocab) {
        if (dist.length >= 3) break;
        const m = w.meaning || "";
        if (w.word !== word.word && !used.has(m)) { dist.push(m); used.add(m); }
      }
    }
    // 正确项放在随机位置 pos 并标记为正确，其余 3 位放干扰项
    const pos = rand(4);
    S.options = [];
    let di = 0;
    for (let i = 0; i < 4; i++) {
      if (i === pos) S.options.push({ text: correct, correct: true });
      else S.options.push({ text: dist[di++] || "", correct: false });
    }
  }
  // 选项文本结构化渲染：词性标签（小蓝标）+ 主释义 + 次要释义（小字灰）
  function renderOptText(el, text) {
    el.textContent = "";
    if (!text) return;
    const m = text.match(/^([a-z]+(?:\/[a-z]+)*\.)\s*([\s\S]*)$/);
    let pos = "", rest = text;
    if (m) { pos = m[1]; rest = m[2]; }
    const segs = rest.split("；");
    if (pos) {
      const t = document.createElement("span");
      t.className = "opt-pos";
      t.textContent = pos + " ";
      el.appendChild(t);
    }
    el.appendChild(document.createTextNode(segs[0] || ""));
    if (segs[1]) {
      const sub = document.createElement("span");
      sub.className = "opt-sub";
      sub.textContent = segs[1];
      el.appendChild(sub);
    }
  }
  function hideStudyCard() {
    $("#card").classList.add("hidden");
    $("#quiz-ui").classList.add("hidden");
    $("#card-ui").classList.add("hidden");
    $("#feedback").classList.add("hidden");
    $("#nav-actions").classList.add("hidden");
  }
  function renderQuestion(forceWord, keepOptions) {
    clearTimeout(S.autoTimer); S.autoTimer = null;
    S.answered = false;
    const ptop = $("#btn-prev-top"); if (ptop) ptop.disabled = S.history.length === 0;
    let word = forceWord;
    if (typeof word === "string") word = S.vmap[word] || { word: word }; // 防御：字符串时取回词对象
    if (!word) {
      if (S.mode === "review") {
        if (S.pending.length === 0) { showReviewDone(); return; }
        word = S.pending.shift();
      } else {
        word = pickNewWord();
        if (!word) {
          hideStudyCard();
          $("#mode-label").textContent = "全部学完";
          const empty = $("#study-empty"); empty.classList.remove("hidden");
          empty.innerHTML = "🎉 词库已全部学习完毕！之后每天只需完成复习。";
          return;
        }
      }
    }
    S.current = word;
    $("#card").classList.remove("hidden");
    $("#study-empty").classList.add("hidden");
    $("#card-word").textContent = word.word || word.full || word.meaning || "（数据缺失）";
    $("#card-pos").textContent = word.pos || "";
    $("#feedback").classList.add("hidden", "ok", "bad");
    $("#nav-actions").classList.add("hidden");
    if (S.studyMode === "quiz") {
      if (!keepOptions) buildOptions(word);
      $("#quiz-ui").classList.remove("hidden");
      $("#card-ui").classList.add("hidden");
      $$(".opt").forEach((b, i) => {
        b.classList.remove("correct", "wrong", "disabled");
        renderOptText(b.querySelector(".opt-text"), S.options[i] ? S.options[i].text : "");
      });
    } else {
      $("#quiz-ui").classList.add("hidden");
      $("#card-ui").classList.remove("hidden");
      $("#card-meaning").textContent = word.full || word.meaning;
      $("#card-meaning").classList.add("hidden");
      $("#btn-reveal").classList.remove("hidden");
      $("#rate-row").classList.add("hidden");
    }
  }
  // 回到上一个词（重新作答）
  function prevQuestion() {
    if (S.history.length === 0) return;
    clearTimeout(S.autoTimer); S.autoTimer = null;
    const prev = S.history.pop();
    // 优先取回词对象；若 vmap 没命中，构造最小对象（保证绝不空白）
    const wobj = S.vmap[prev.word] || { word: prev.word, meaning: "" };
    S.current = wobj;
    const ptop = $("#btn-prev-top"); if (ptop) ptop.disabled = S.history.length === 0;
    if (prev.options && prev.options.length) {
      S.options = prev.options;             // 保留原选项（同一题原样重出）
      renderQuestion(S.current, true);
    } else {
      renderQuestion(S.current);
    }
  }
  function showReviewDone() {
    hideStudyCard();
    $("#mode-label").textContent = "今日复习完成";
    const empty = $("#study-empty"); empty.classList.remove("hidden");
    empty.innerHTML = '🎉 今日待复习已全部完成！<br><br><button class="btn-primary" id="btn-start-new">开始新题练习</button>';
    $("#btn-start-new").onclick = () => { S.mode = "new"; resetSession(); S.pending = []; renderQuestion(); };
  }
  // 统一提交答案：SRS + 错题本 + 计数 + 队列调度（quiz 传 5/0，卡片传 0/3/4/5）
  function commitResult(word, rating) {
    const correct = rating >= 3;
    const base = stateOf(word);
    const ns = applySRS(base, rating);
    let is_wrong_book = !!base.is_wrong_book, ever_wrong = !!base.ever_wrong, wrong_streak = base.wrong_streak || 0;
    let wrong_count = base.wrong_count || 0, correct_count = base.correct_count || 0;
    let wrong_added_at = base.wrong_added_at || 0;
    if (!correct) {
      is_wrong_book = true; ever_wrong = true; wrong_streak = 0; wrong_count += 1;
      wrong_added_at = Date.now(); // 每次答错都刷新（= 最近一次答错时间，错题本按此倒序）
      ns.due_at = nextMidnightCST();
      scheduleRetry(word);               // 稍后重现（不是立即再出）
    } else {
      correct_count += 1;
      if (is_wrong_book) {
        wrong_streak += 1;
        if (wrong_streak >= 3) is_wrong_book = false;   // 毕业移出错题本
        else ns.due_at = nextMidnightCST();
      }
      if (S.mode === "new") S.sessionDone[word] = true; // 新题模式答对 → 本会话不再出
    }
    // 核心规则：仍在错题本中的词不能算"掌握"（level 封顶 2），毕业移出错题本后才能升到 3
    if (correct && is_wrong_book && ns.level >= 3) ns.level = 2;
    S.progress[word] = {
      level: ns.level, due_at: ns.due_at, interval_days: ns.interval_days, ease: ns.ease,
      reps: ns.reps, lapses: ns.lapses, is_wrong_book, ever_wrong, wrong_streak, wrong_added_at,
      wrong_count, correct_count, rev: (base.rev || 0) + 1, updated_at: Date.now(),
    };
    pushOp({ type: "answer", word, rating, occurred_at: Date.now(), op_id: S.deviceId + ":" + Date.now() + ":" + Math.random().toString(36).slice(2, 8) });
    S.qCount += 1;
    if (S.studyMode === "quiz") S.history.push({ word, options: S.options.map((o) => ({ text: o.text, correct: o.correct })) });
    else S.history.push({ word, options: [] });
    if (S.history.length > 20) S.history.shift();
    renderDailyProgress(); // 若设置页可见则实时刷新今日进度
  }
  // 四选一作答
  function answer(i) {
    if (S.answered) return;
    const opt = S.options[i];
    if (!opt) return;
    S.answered = true;
    commitResult(S.current.word, opt.correct ? 5 : 0);
    // 高亮选项
    $$(".opt").forEach((b, j) => {
      b.classList.add("disabled");
      if (S.options[j].correct) b.classList.add("correct");
      if (j === i && !opt.correct) b.classList.add("wrong");
    });
    // 反馈
    const fb = $("#feedback");
    fb.classList.remove("hidden");
    if (opt.correct) {
      fb.classList.remove("bad"); fb.classList.add("ok");
      const st = stateOf(S.current.word);
      fb.textContent = st.is_wrong_book ? ("✓ 答对了！错题本连对 " + (st.wrong_streak || 0) + "/3") : "✓ 回答正确！";
    } else {
      fb.classList.remove("ok"); fb.classList.add("bad");
      const right = S.options.find((o) => o.correct);
      fb.textContent = "✗ 答错了，正确答案：" + (right ? right.text : "") + "（稍后会再考你）";
    }
    $("#nav-actions").classList.add("hidden");
    if (S.mode === "review") $("#mode-label").textContent = "复习中 · 剩余 " + S.pending.length + " 题";
    const ptop = $("#btn-prev-top"); if (ptop) ptop.disabled = S.history.length === 0;
    renderStats();
    if (opt.correct) {
      // 答对：留 150ms 看高亮闪烁，然后自动进入下一题
      S.autoTimer = setTimeout(nextStep, 150);
    } else {
      $("#nav-actions").classList.remove("hidden");
    }
  }
  // 卡片模式：显示答案
  function revealCard() {
    if (S.answered || S.studyMode !== "card") return;
    $("#card-meaning").classList.remove("hidden");
    $("#btn-reveal").classList.add("hidden");
    $("#rate-row").classList.remove("hidden");
  }
  // 卡片模式：四档评分（0 不认识 / 3 模糊 / 4 认识 / 5 很熟）
  function rateCard(rating) {
    if (S.answered || !S.current) return;
    S.answered = true;
    commitResult(S.current.word, rating);
    const fb = $("#feedback");
    fb.classList.remove("hidden");
    const names = ["不认识", "", "", "模糊", "认识", "很熟"];
    if (rating >= 3) {
      fb.classList.remove("bad"); fb.classList.add("ok");
      const st = stateOf(S.current.word);
      fb.textContent = st.is_wrong_book ? ("✓ " + names[rating] + "，错题本连对 " + (st.wrong_streak || 0) + "/3") : ("✓ " + names[rating]);
    } else {
      fb.classList.remove("ok"); fb.classList.add("bad");
      fb.textContent = "✗ 不认识，已加入错题本（稍后会再考你）";
    }
    $("#nav-actions").classList.add("hidden");
    if (S.mode === "review") $("#mode-label").textContent = "复习中 · 剩余 " + S.pending.length + " 题";
    const ptop = $("#btn-prev-top"); if (ptop) ptop.disabled = S.history.length === 0;
    renderStats();
    if (rating >= 3) {
      // 认识/模糊/很熟：留 150ms 看高亮闪烁，然后自动进入下一题
      S.autoTimer = setTimeout(nextStep, 150);
    } else {
      $("#nav-actions").classList.remove("hidden");
    }
  }
  function switchStudyMode(m) {
    S.studyMode = m;
    localStorage.setItem("wb_study_mode", m);
    $$(".ms-item").forEach((b) => b.classList.toggle("active", b.dataset.sm === m));
    if (S.current) {
      // 保持当前词不换题，仅切换呈现模式（已答的会重置为未答重新展示）
      renderQuestion(S.current);
    } else {
      renderQuestion();
    }
  }
  function nextStep() {
    if (S.mode === "review" && S.pending.length === 0) showReviewDone(); else renderQuestion();
  }
  // 标记熟词：不再重复考察（level=3 + due_at 远期 + 移出错题本 + 本会话不再出）
  function markMastered() {
    if (!S.current) return;
    const word = S.current.word;
    const base = stateOf(word);
    const FAR_FUTURE = Date.UTC(2100, 0, 1);
    const now = Date.now();
    S.progress[word] = {
      ...base, level: 3, due_at: FAR_FUTURE, is_mastered: true,
      is_wrong_book: false, wrong_streak: 0, rev: (base.rev || 0) + 1, updated_at: now,
    };
    pushOp({
      type: "state", word,
      state: {
        level: 3, due_at: FAR_FUTURE, interval_days: base.interval_days || 0, ease: base.ease || 2.5,
        reps: base.reps || 0, lapses: base.lapses || 0, is_wrong_book: false, ever_wrong: base.ever_wrong,
        wrong_streak: 0, wrong_added_at: base.wrong_added_at || 0, wrong_count: base.wrong_count || 0,
        correct_count: base.correct_count || 0, is_mastered: true,
      },
      updated_at: now, op_id: "master:" + word + ":" + now,
    });
    // 从本会话调度中彻底移除
    S.sessionDone[word] = true;
    S.defer = S.defer.filter((d) => d.word !== word);
    S.deferCount[word] = 99;
    // 反馈
    const fb = $("#feedback");
    fb.classList.remove("hidden", "bad"); fb.classList.add("ok");
    fb.textContent = "☆ 已标记为熟词，之后不再考察";
    renderStats();
    if (S.answered) nextStep(); else renderQuestion();
  }
  function bindStudy() {
    $$(".ms-item").forEach((b) => (b.onclick = () => switchStudyMode(b.dataset.sm)));
    $$(".opt").forEach((b) => (b.onclick = () => answer(+b.dataset.i)));
    const rev = $("#btn-reveal"); if (rev) rev.onclick = revealCard;
    $$(".rate").forEach((b) => (b.onclick = () => rateCard(+b.dataset.rate)));
    const pt = $("#btn-prev-top"); if (pt) pt.onclick = prevQuestion;
    const nx = $("#btn-next"); if (nx) nx.onclick = nextStep;
    const ms = $("#btn-master"); if (ms) ms.onclick = markMastered;
    // 键盘：1-4 选选项/评分；Enter/空格 显示答案或下一题
    document.addEventListener("keydown", (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return; // 输入框内不拦截
      if (!S.token || !S.vocab.length || !S.current) return;
      if (e.key >= "1" && e.key <= "4") {
        e.preventDefault(); // 阻止浏览器"快速查找"等默认行为
        const idx = +e.key - 1;
        if (S.studyMode === "quiz") {
          answer(idx);
        } else {
          // 卡片模式：按 1-4 直接显示答案并评分（认识/模糊/很熟/不认识）
          if (!S.answered) revealCard();
          rateCard([0, 3, 4, 5][idx]);
        }
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (S.studyMode === "card" && !S.answered) { revealCard(); return; }
        if (S.answered) {
          // 手动跳过自动进入下一题的等待
          clearTimeout(S.autoTimer); S.autoTimer = null;
          nextStep();
        }
      }
    });
  }

  // ---------- 词库 ----------
  function renderLibrary() {
    const q = $("#lib-search").value.trim().toLowerCase();
    const f = $("#lib-filter").value;
    const list = $("#lib-list"); list.innerHTML = "";
    const matched = [];
    S.vocab.forEach((w) => {
      const st = S.progress[w.word], lv = st ? st.level : 0;
      if (f === "w" && !(st && st.is_wrong_book)) return;   // 错题本
      if (f === "e" && !(st && st.ever_wrong)) return;      // 曾错题
      if (f === "m" && !(st && st.is_mastered)) return;     // 熟词
      if (f !== "all" && f !== "w" && f !== "e" && f !== "m" && String(lv) !== f) return;
      if (f === "3" && st && st.is_wrong_book) return;      // 掌握筛选排除错题本中的词
      if (q && !(w.word.toLowerCase().includes(q) || (w.meaning || "").toLowerCase().includes(q))) return;
      matched.push(w);
    });
    // 最近学习的排前面；未学过的（无记录）保持词表顺序排在最后
    matched.sort((a, b) => {
      const ua = (S.progress[a.word] && S.progress[a.word].updated_at) || 0;
      const ub = (S.progress[b.word] && S.progress[b.word].updated_at) || 0;
      return ub - ua;
    });
    let n = 0;
    for (const w of matched) {
      if (n >= 500) break;
      const st = S.progress[w.word], lv = st ? st.level : 0;
      const tag = st && st.is_mastered ? '<span class="lib-tag tag-master">熟词</span>' : (st && st.is_wrong_book ? '<span class="lib-tag">错题本</span>' : (st && st.ever_wrong ? '<span class="lib-tag tag-ever">曾错</span>' : ""));
      const item = document.createElement("div");
      item.className = "lib-item lv" + lv;
      // 答题次数统计（与错题本同款小标签）：刷过总数 + 对/错
      const totalN = st ? ((st.correct_count || 0) + (st.wrong_count || 0)) : 0;
      const counts = st && totalN > 0
        ? '<div class="lib-counts"><span class="cnt">刷 ' + totalN + ' 次</span>' +
          '<span class="cnt cnt-c">对 ' + (st.correct_count || 0) + '</span>' +
          ((st.wrong_count || 0) ? '<span class="cnt cnt-w">错 ' + st.wrong_count + '</span>' : "") +
          '</div>'
        : "";
      item.innerHTML = '<div><div class="lib-word">' + escapeHtml(w.word) + ' ' + tag + '</div><div class="lib-mean">' + (w.pos && !/^[a-z]+(?:\/[a-z]+)*\./.test(w.meaning || "") ? ("[" + escapeHtml(w.pos) + "] ") : "") + escapeHtml(w.meaning || "") + '</div>' + counts + '</div><div class="lib-lv">' + (st && st.is_wrong_book ? "错题" : LV[lv]) + '</div>';
      list.appendChild(item); n++;
    }
    if (n === 0) list.innerHTML = '<p class="hint">没有匹配的单词</p>';
  }
  function bindLibrary() { $("#lib-search").oninput = renderLibrary; $("#lib-filter").onchange = renderLibrary; }

  // ---------- 错题本 / 曾错本 / 熟词 ----------
  let wrongTab = "wrong";
  const WRONG_TITLE = { wrong: "错题本", ever: "曾错本", master: "熟词" };
  function renderWrong() {
    const tab = wrongTab;
    const isW = tab === "wrong", isE = tab === "ever", isM = tab === "master";
    const title = WRONG_TITLE[tab];
    const arr = S.vocab.filter((w) => {
      const st = S.progress[w.word];
      return st && (isW ? st.is_wrong_book : isE ? st.ever_wrong : st.is_mastered);
    });
    let totalW = 0, totalC = 0;
    arr.forEach((w) => { const st = S.progress[w.word]; totalW += st.wrong_count || 0; totalC += st.correct_count || 0; });
    $("#wrong-summary").innerHTML = "共 <b>" + arr.length + "</b> 个" + title + " · 累计答错 <b>" + totalW + "</b> 次 · 答对 <b>" + totalC + "</b> 次";
    const list = $("#wrong-list"); list.innerHTML = "";
    if (!arr.length) {
      const emptyMsg = isW ? "错题本是空的，继续保持！" : (isE ? "还没有曾错记录，去学几个新词吧" : "还没有熟词，学习中点「☆ 熟词」标记");
      list.innerHTML = '<p class="hint">' + emptyMsg + "</p>";
      return;
    }
    // 时间倒序：错题本/曾错本按最近一次答错时间，熟词按标记（最近活动）时间
    const timeOf = (st) => (isM ? (st.updated_at || 0) : (st.wrong_added_at || st.updated_at || 0));
    arr.sort((a, b) => timeOf(S.progress[b.word]) - timeOf(S.progress[a.word]));
    const delLabel = isW ? "移出错题本" : (isE ? "清除记录" : "取消熟词");
    arr.forEach((w) => {
      const st = S.progress[w.word];
      const item = document.createElement("div");
      item.className = "lib-item lv" + (st.level || 0);
      const counts =
        '<div class="lib-counts">' +
        '<span class="cnt cnt-w">❌ 错 ' + (st.wrong_count || 0) + ' 次</span>' +
        '<span class="cnt cnt-c">✅ 对 ' + (st.correct_count || 0) + ' 次</span>' +
        (isW ? '<span class="cnt cnt-s">🔁 连对 ' + (st.wrong_streak || 0) + '/3</span>' : "") +
        '</div>';
      item.innerHTML =
        '<div><div class="lib-word">' + escapeHtml(w.word) + '</div>' +
        '<div class="lib-mean">' + (w.pos && !/^[a-z]+(?:\/[a-z]+)*\./.test(w.meaning || "") ? ("[" + escapeHtml(w.pos) + "] ") : "") + escapeHtml(w.meaning || "") + '</div>' + counts +
        '</div>' +
        '<div class="lib-right"><div class="lib-lv">' + title + '</div>' +
        '<button class="lib-del" data-del="' + escapeHtml(w.word) + '">' + delLabel + '</button></div>';
      list.appendChild(item);
    });
    $$("#wrong-list .lib-del").forEach((b) => (b.onclick = () => removeEntry(b.dataset.del, tab)));
  }
  // 手动删除：错题本=移出且不再按错题复习；曾错本=清历史标记；熟词=取消标记恢复学习
  function removeEntry(word, tab) {
    const base = stateOf(word);
    const FAR_FUTURE = Date.UTC(2100, 0, 1);
    let ns, msg;
    if (tab === "wrong") {
      if (!confirm('从错题本移除 "' + word + '"？\n移除后不再按错题复习（曾错记录保留）。')) return;
      ns = { ...base, is_wrong_book: false, due_at: FAR_FUTURE, rev: (base.rev || 0) + 1, updated_at: Date.now() };
      msg = "已移出错题本";
    } else if (tab === "ever") {
      if (!confirm('清除 "' + word + '" 的曾错记录？')) return;
      ns = { ...base, ever_wrong: false, rev: (base.rev || 0) + 1, updated_at: Date.now() };
      msg = "已清除曾错记录";
    } else {
      if (!confirm('取消 "' + word + '" 的熟词标记？\n该词将重新进入学习。')) return;
      ns = { ...base, is_mastered: false, level: 0, due_at: Date.now(), rev: (base.rev || 0) + 1, updated_at: Date.now() };
      msg = "已取消熟词，重新学习";
    }
    S.progress[word] = ns;
    const now = ns.updated_at;
    pushOp({
      type: "state", word,
      state: {
        level: ns.level, due_at: ns.due_at, interval_days: ns.interval_days, ease: ns.ease,
        reps: ns.reps, lapses: ns.lapses, is_wrong_book: ns.is_wrong_book, ever_wrong: ns.ever_wrong,
        wrong_streak: ns.wrong_streak, wrong_added_at: ns.wrong_added_at,
        wrong_count: ns.wrong_count, correct_count: ns.correct_count, is_mastered: ns.is_mastered,
      },
      updated_at: now, op_id: "unmark:" + word + ":" + now,
    });
    renderWrong(); renderStats();
    $("#wrong-summary").innerHTML += ' <span style="color:#087f5b">· ' + msg + '</span>';
  }
  function bindWrong() {
    $$(".wt-item").forEach((b) => (b.onclick = () => {
      wrongTab = b.dataset.wt;
      $$(".wt-item").forEach((x) => x.classList.toggle("active", x === b));
      renderWrong();
    }));
  }

  // ---------- 统计 ----------
  function renderStats() {
    const total = S.vocab.length;
    let studied = 0, mastered = 0, learning = 0, dueToday = 0, neww = 0, wrongBook = 0, everWrong = 0;
    const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
    S.vocab.forEach((w) => {
      const st = S.progress[w.word];
      if (st) {
        studied++; if (st.level === 3 && !st.is_wrong_book) mastered++; else if (st.level > 0) learning++;
        if (st.due_at <= endToday.getTime()) dueToday++;
        if (st.is_wrong_book) wrongBook++;
        if (st.ever_wrong) everWrong++;
      } else neww++;
    });
    $("#stat-grid").innerHTML =
      statCard(studied, "已学习") + statCard(mastered, "已掌握") + statCard(wrongBook, "错题本") +
      statCard(dueToday, "今日待复习") + statCard(everWrong, "曾错题") + statCard(total, "词库总量");
  }
  function statCard(num, label) { return '<div class="stat-card"><div class="stat-num">' + num + '</div><div class="stat-label">' + label + '</div></div>'; }

  // ---------- 统计图表（最近 7 天 + 累计，纯 CSS/SVG） ----------
  function weekdayCST(startMs) {
    const d = new Date(startMs + 8 * 3600 * 1000);
    return "周" + "日一二三四五六".charAt(d.getUTCDay());
  }
  async function renderStatsCharts() {
    if (!$("#chart-answers")) return;
    // 总进度（本地统计：有学习记录的词 / 词库总量）
    const vtotal = S.vocab.length;
    let studied = 0, mastered = 0, wrongB = 0;
    S.vocab.forEach((w) => {
      const ps = S.progress[w.word];
      if (ps) { studied++; if (ps.level === 3 && !ps.is_wrong_book) mastered++; if (ps.is_wrong_book) wrongB++; }
    });
    const tpPct = vtotal ? Math.round((studied / vtotal) * 100) : 0;
    $("#tp-fill").style.width = tpPct + "%";
    $("#tp-text").textContent = "已刷 " + studied + " / " + vtotal + " 词";
    $("#tp-detail").textContent = "掌握 " + mastered + " · 错题本 " + wrongB;
    $("#tp-sub").textContent = tpPct + "%";
    let data;
    try { data = await api("/api/stats"); } catch (e) { $("#chart-week-sub").textContent = "图表加载失败"; return; }
    const days = data.days || [];
    const today = cstDayNum(Date.now());
    const dayLabel = (d) => { const n = cstDayNum(d.start); return n === today ? "今天" : weekdayCST(d.start); };

    // ① 答题量：堆叠柱（绿=答对，红=答错）
    const maxA = Math.max(1, ...days.map((d) => d.answers));
    $("#chart-answers").innerHTML = days.map((d) => {
      const h = d.answers ? Math.max(4, Math.round((d.answers / maxA) * 100)) : 0;
      const wrong = d.answers - d.correct;
      return '<div class="bar-col"><span class="bar-num">' + (d.answers || "") + '</span>' +
        '<div class="bar-stack" style="height:' + h + '%">' +
        (wrong ? '<i class="bar-wrong" style="flex:' + wrong + '"></i>' : "") +
        (d.correct ? '<i class="bar-correct" style="flex:' + d.correct + '"></i>' : "") +
        '</div><span class="bar-day' + (dayLabel(d) === "今天" ? " today" : "") + '">' + dayLabel(d) + '</span></div>';
    }).join("");
    const wAnswers = days.reduce((s, d) => s + d.answers, 0);
    const wCorrect = days.reduce((s, d) => s + d.correct, 0);
    $("#chart-week-sub").textContent = wAnswers ? ("共 " + wAnswers + " 题 · 正确率 " + Math.round((100 * wCorrect) / wAnswers) + "%") : "最近 7 天还没有答题";

    // ② 每日正确率：横向条（日期倒序，今天在最上），只显示百分比
    $("#chart-acc").innerHTML = days.slice().reverse().map((d) => {
      const acc = d.answers ? Math.round((100 * d.correct) / d.answers) : null;
      const cls = acc == null ? "" : acc >= 80 ? "acc-good" : acc >= 60 ? "acc-mid" : "acc-bad";
      return '<div class="acc-row"><span class="acc-day' + (dayLabel(d) === "今天" ? " today" : "") + '">' + dayLabel(d) + '</span>' +
        '<div class="acc-track"><i class="' + cls + '" style="width:' + (acc || 0) + '%"></i></div>' +
        '<span class="acc-val">' + (acc == null ? "—" : acc + "%") + '</span></div>';
    }).join("");
    $("#chart-acc-sub").textContent = "绿 ≥80% · 黄 60–79% · 红 <60%";

    // ③ 每日新词：蓝色柱
    const maxN = Math.max(1, ...days.map((d) => d.newWords));
    $("#chart-new").innerHTML = days.map((d) => {
      const h = d.newWords ? Math.max(5, Math.round((d.newWords / maxN) * 100)) : 0;
      return '<div class="bar-col"><span class="bar-num">' + (d.newWords || "") + '</span>' +
        '<div class="bar-stack" style="height:' + h + '%"><i class="bar-newbar" style="flex:1"></i></div>' +
        '<span class="bar-day' + (dayLabel(d) === "今天" ? " today" : "") + '">' + dayLabel(d) + '</span></div>';
    }).join("");
    const wNew = days.reduce((s, d) => s + d.newWords, 0);
    $("#chart-new-sub").textContent = "本周新学 " + wNew + " 词";

    // ④ 累计正确率：环形图
    const t = data.total || { answers: 0, correct: 0, wrong: 0, accuracy: 0 };
    const C = 2 * Math.PI * 46;
    const filled = (C * t.accuracy) / 100;
    $("#chart-donut").innerHTML =
      '<svg width="116" height="116" viewBox="0 0 116 116">' +
      '<circle cx="58" cy="58" r="46" fill="none" stroke="#efece3" stroke-width="13"/>' +
      '<circle cx="58" cy="58" r="46" fill="none" stroke="var(--primary)" stroke-width="13" stroke-linecap="round" stroke-dasharray="' + filled + ' ' + (C - filled) + '" transform="rotate(-90 58 58)"/>' +
      '</svg><div class="donut-center"><span class="donut-pct">' + t.accuracy + '%</span><span class="donut-cap">总正确率</span></div>';
    $("#chart-total").innerHTML =
      '<div class="dl"><span class="dot" style="background:var(--lv3)"></span>答对<b>' + t.correct + '</b></div>' +
      '<div class="dl"><span class="dot" style="background:#ff8787"></span>答错<b>' + t.wrong + '</b></div>' +
      '<div class="dl"><span class="dot" style="background:var(--primary)"></span>总答题<b>' + t.answers + '</b></div>';
  }

  // ---------- 今日进度 / 昨日完成（按当日答题数统计，跨设备准确，来自 /api/stats） ----------
  function cstDayNum(ms) { return Math.floor((ms + 8 * 3600 * 1000) / 86400000); }
  let _dpSeq = 0;
  async function renderDailyProgress() {
    const view = $("#view-settings");
    if (!view || view.classList.contains("hidden")) return;
    const goal = Math.max(1, S.settings.dailyGoal || 100);
    const seq = ++_dpSeq;
    let days = null, total = null;
    try {
      const s = await api("/api/stats");
      days = s.days || []; total = s.total || null;
    } catch (e) { /* 拉取失败时保持现状，下次再试 */ return; }
    if (seq !== _dpSeq) return; // 已有更新的渲染请求
    const t = days.length ? days[days.length - 1].answers : 0;   // 今日答题数
    const y = days.length > 1 ? days[days.length - 2].answers : 0; // 昨日答题数
    $("#dp-fill").style.width = Math.min(100, Math.round((t / goal) * 100)) + "%";
    $("#dp-today").textContent = "今日已答 " + t + " / " + goal + " 题";
    $("#dp-yesterday").textContent =
      y >= goal ? "昨日 " + y + " 题 · 已达标" : (y > 0 ? "昨日 " + y + " 题 · 未达标" : "昨日未答题");
    let msg;
    if (t === 0) msg = "今天还没开始，答下第一题就赢了一半";
    else if (t < goal) msg = t * 2 < goal ? "开局不错，保持这个节奏" : "只差 " + (goal - t) + " 题达标，冲一冲";
    else if (t === goal) msg = "今日目标达成！今天的你很棒";
    else msg = "超额 " + (t - goal) + " 题，今天火力全开";
    // 连续达标天数：今天已达标则从今天起算，否则从昨天起算（days[6]=今天）
    let streak = 0;
    for (let d = (t >= goal ? 6 : 5); d >= 0 && days[d] && days[d].answers >= goal; d--) streak++;
    if (streak >= 2) msg += " · 已连续达标 " + streak + " 天";
    if (total && total.answers) msg += " · 累计正确率 " + total.accuracy + "%";
    $("#dp-msg").textContent = msg;
  }

  // ---------- 设置 ----------
  function bindSettings() {
    const dg = $("#set-daily"); dg.value = S.settings.dailyGoal || 100;
    dg.onchange = () => {
      S.settings.dailyGoal = +dg.value || 20;
      pushOp({ type: "setting", key: "dailyGoal", value: String(S.settings.dailyGoal), updated_at: Date.now(), op_id: "set:dailyGoal:" + Date.now() });
      renderDailyProgress();
    };
    $("#btn-sync-now").onclick = async () => {
      await flush();
      alert(S.outbox.length === 0 ? "同步完成" : "仍有 " + S.outbox.length + " 条待同步");
    };
    $("#btn-export").onclick = () => {
      const data = { progress: S.progress, settings: S.settings };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "wordbook-backup.json"; a.click();
    };
    // 修改密码
    $("#btn-change-pw").onclick = async () => {
      const oldP = $("#cp-old").value, newP = $("#cp-new").value, newP2 = $("#cp-new2").value;
      const msg = $("#cp-msg"); msg.textContent = "";
      if (!oldP || !newP) { msg.textContent = "请填写当前密码和新密码"; return; }
      if (newP.length < 6) { msg.textContent = "新密码至少 6 位"; return; }
      if (newP !== newP2) { msg.textContent = "两次输入的新密码不一致"; return; }
      try {
        const r = await api("/api/change-password", { body: { old_password: oldP, new_password: newP } });
        if (r && r.ok) {
          msg.textContent = "✅ 密码已修改，下次登录请使用新密码";
          $("#cp-old").value = ""; $("#cp-new").value = ""; $("#cp-new2").value = "";
        } else msg.textContent = (r && r.error) || "修改失败，请重试";
      } catch (e) { msg.textContent = String((e && e.message) || e); }
    };
    // 退出账号
    $("#btn-logout").onclick = () => {
      if (confirm("确定退出账号？\n学习进度已保存在云端，重新登录即可恢复。")) logout();
    };
    $("#btn-import").onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const d = JSON.parse(rd.result);
          if (d.progress) for (const [w, st] of Object.entries(d.progress)) {
            const l = S.progress[w];
            if (!l || (st.updated_at || 0) >= (l.updated_at || 0)) S.progress[w] = st;
          }
          pushStateOps(); startStudy(); renderStats(); alert("导入完成，已加入同步队列");
        } catch (err) { alert("文件格式错误"); }
      };
      rd.readAsText(f);
      e.target.value = "";
    };
  }
  function pushStateOps() {
    for (const [w, st] of Object.entries(S.progress)) {
      pushOp({
        type: "state", word: w,
        state: {
          level: st.level, due_at: st.due_at, interval_days: st.interval_days, ease: st.ease, reps: st.reps, lapses: st.lapses,
          is_wrong_book: st.is_wrong_book, ever_wrong: st.ever_wrong, wrong_streak: st.wrong_streak,
          wrong_added_at: st.wrong_added_at, wrong_count: st.wrong_count, correct_count: st.correct_count,
          is_mastered: st.is_mastered,
        },
        updated_at: st.updated_at || Date.now(), op_id: "state:" + w + ":" + (st.updated_at || Date.now()),
      });
    }
  }
  // ---------- 视图切换 ----------
  function switchView(v) {
    $$(".view").forEach((s) => s.classList.add("hidden"));
    $("#view-" + v).classList.remove("hidden");
    $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    $$(".bn-item").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    if (v === "library") renderLibrary();
    if (v === "wrong") renderWrong();
    if (v === "stats") { renderStats(); renderStatsCharts(); }
    if (v === "settings") {
      const wu = $("#welcome-user"); if (wu) wu.textContent = S.username || "";
      renderDailyProgress();
    }
  }
  function bindUI() {
    bindStudy(); bindLibrary(); bindWrong(); bindSettings();
    $$("[data-view]").forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
    $("#logout").onclick = logout;
    $("#btn-reset").onclick = resetProgress;
  }
  async function resetProgress() {
    if (!confirm("确定要重置全部学习进度吗？\n所有已学 / 错题 / 复习记录将被清空，单词全部重新变为未学。此操作不可恢复！")) return;
    if (!confirm("再次确认：真的要全部重置吗？")) return;
    try {
      const r = await api("/api/reset");
      if (r && r.ok) {
        S.progress = {}; S.outbox = []; saveOutbox();
        resetSession(); startStudy();
        alert("已重置，所有单词重新变为未学");
      } else alert("重置失败：" + ((r && r.error) || "未知错误"));
    } catch (e) { alert("重置失败：" + ((e && e.message) || e)); }
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // ---------- 初始化 ----------
  initAuth();
  initReset();
  if (S.token) boot().catch(() => {});
})();
