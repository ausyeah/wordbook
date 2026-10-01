// 单词书联网版 · CloudBase HTTP 云函数后端（PostgreSQL via PostgREST）
// 由 Cloudflare Worker / 腾讯云事件函数版移植：认证/JWT/PBKDF2/SM-2/同步逻辑不变
// 数据库：CloudBase PostgreSQL，通过 PostgREST REST API (/v1/rdb/rest) 访问
const express = require("express");
const crypto = require("crypto");
const cloudbase = require("@cloudbase/node-sdk");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// CORS（完全不设 Access-Control-Allow-Origin，让 CloudBase 网关自动处理；
// 避免被网关重复追加造成 "url1,url1" 这类非法 CORS 头）
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- CloudBase（云函数环境自动取当前环境） ----------
const tcb = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
let _rdb = null;
async function rdb() {
  if (!_rdb) _rdb = tcb.rdb({ instance: "default", database: "public" });
  return _rdb;
}

// ---------- 通用工具 ----------
const SECRET = process.env.JWT_SECRET || "please-set-JWT_SECRET-in-cloudbaserc";
// 忘记密码的恢复码（不存数据库；忘记密码时用 恢复码+新密码 重置）。
// ⚠️ 妥善保管：请把下面这个值记在你自己的密码管理器/备忘录里。
const RECOVERY_KEY = process.env.RECOVERY_KEY || "please-set-RECOVERY-KEY-in-cloudbaserc";
function b64url(buf) { return Buffer.from(buf).toString("base64url"); }
async function hmac(secret, data) { return crypto.createHmac("sha256", secret).update(data).digest(); }
async function signToken(secret, payload) {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return body + "." + b64url(await hmac(secret, body));
}
async function verifyToken(secret, token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = b64url(await hmac(secret, body));
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}
function pbkdf2(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 100000, 32, "sha256", (err, key) =>
      err ? reject(err) : resolve(key.toString("hex")));
  });
}
async function hashPassword(password, saltHex) { return pbkdf2(password, Buffer.from(saltHex, "hex")); }
function applySRS(s, rating) {
  let { level = 0, interval_days = 0, ease = 2.5, reps = 0, lapses = 0 } = s;
  if (rating < 3) { reps = 0; interval_days = 1; level = Math.max(0, level - 1); lapses += 1; }
  else {
      // 快速刷一轮模式：答对 = 会了，本轮不再复习（due_at 推到一年后）；错题本词由外层逻辑次日复习直到毕业（与前端镜像一致）
      interval_days = Math.max(interval_days, 365);
      reps += 1;
      level = 3;
    }
  return { level, interval_days, ease, reps, lapses, due_at: Date.now() + interval_days * 86400000 };
}

// 东八区次日 0 点（用于"答错的题第二天进入复习队列"）
function nextMidnightCST() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0) - 8 * 3600 * 1000;
}

// ---------- PostgREST 封装 ----------
// 通过 SDK rdb.fetch 发请求，返回 JSON。SDK 自动加 Authorization + X-Db-Instance + Profiles。
const BASE_PATH = ""; // 相对 rdb.url
async function pg(method, path, body) {
  const r = await rdb();
  const url = r.url.replace(/\/$/, "") + path;
  const init = { method, headers: { "Content-Type": "application/json", Prefer: "return=representation" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await r.fetch(url, init);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) { const e = new Error(typeof data === "object" ? (data.message || JSON.stringify(data)) : String(data)); e.status = res.status; e.data = data; throw e; }
  return data;
}

// ---------- 数据库操作（PostgREST 风格）----------
async function findUserByUsername(username) {
  // GET /users?username=eq.<x>&limit=1
  const arr = await pg("GET", `/users?username=eq.${encodeURIComponent(username)}&limit=1`);
  return Array.isArray(arr) && arr[0] ? arr[0] : null;
}
async function countUsers() {
  // PostgREST 计数：GET /users?select=count（需要 exact count 头）
  const r = await rdb();
  const url = r.url.replace(/\/$/, "") + "/users?select=id";
  const res = await r.fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json", Prefer: "count=exact" },
  });
  const cr = res.headers.get("content-range");
  if (cr) { const m = cr.match(/\/(\d+)/); if (m) return parseInt(m[1], 10); }
  return Array.isArray(await res.json()) ? (await res.json()).length : 0;
}
async function insertUser(username, pass_hash) {
  // POST /users Prefer: return=representation 返回插入行
  const arr = await pg("POST", "/users", [{ username, pass_hash, created_at: Date.now() }]);
  return Array.isArray(arr) && arr[0];
}
async function findState(user_id, word) {
  const arr = await pg("GET", `/word_state?user_id=eq.${user_id}&word=eq.${encodeURIComponent(word)}&limit=1`);
  return arr[0] || null;
}
async function upsertState(user_id, word, fields) {
  // PostgREST upsert（PK 冲突时更新）：POST + Prefer resolution=merge-duplicates
  const r = await rdb();
  const url = r.url.replace(/\/$/, "") + "/word_state";
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{ user_id, word, ...fields }]),
  };
  const res = await r.fetch(url, init);
  if (!res.ok) throw new Error("upsertState failed: " + res.status);
  return true;
}
async function reviewExists(user_id, op_id) {
  const arr = await pg("GET", `/review_log?user_id=eq.${user_id}&op_id=eq.${encodeURIComponent(op_id)}&select=op_id&limit=1`);
  return arr.length > 0;
}
async function getAllStates(user_id) {
  // 分页 limit/offset（PostgREST 默认 limit 上限 1000）
  const out = [];
  let off = 0;
  for (;;) {
    const arr = await pg("GET", `/word_state?user_id=eq.${user_id}&deleted_at=neq.1&limit=100&offset=${off}&order=word`);
    out.push(...arr);
    if (arr.length < 100) break;
    off += 100;
  }
  return out;
}
async function getSettings(user_id) {
  const arr = await pg("GET", `/settings?user_id=eq.${user_id}`);
  return arr;
}
async function upsertSetting(user_id, key, value, ts) {
  // LWW：先查最新 updated_at；较新才写
  const cur = await pg("GET", `/settings?user_id=eq.${user_id}&key=eq.${encodeURIComponent(key)}&limit=1`);
  if (cur[0] && (cur[0].updated_at || 0) >= ts) return false;
  if (cur[0]) {
    await pg("PATCH", `/settings?user_id=eq.${user_id}&key=eq.${encodeURIComponent(key)}`, { value, updated_at: ts });
  } else {
    await pg("POST", "/settings", [{ user_id, key, value, updated_at: ts }]);
  }
  return true;
}
function rowToState(r) {
  return {
    level: r.level, due_at: r.due_at, interval_days: r.interval_days, ease: r.ease, reps: r.reps, lapses: r.lapses,
    rev: r.rev, updated_at: r.updated_at, created_at: r.created_at || 0,
    is_wrong_book: !!r.is_wrong_book, ever_wrong: !!r.ever_wrong,
    wrong_streak: r.wrong_streak || 0, wrong_added_at: r.wrong_added_at || 0,
    wrong_count: r.wrong_count || 0, correct_count: r.correct_count || 0,
    is_mastered: !!r.is_mastered,
  };
}
async function getUid(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = await verifyToken(SECRET, token);
  return payload ? payload.uid : null;
}

async function getRecentReviews(uid, sinceMs, cap) {
  const out = [];
  let off = 0;
  for (;;) {
    const arr = await pg("GET", `/review_log?user_id=eq.${uid}&occurred_at=gte.${sinceMs}&select=word,rating,occurred_at&limit=500&offset=${off}`);
    out.push(...arr);
    if (arr.length < 500 || out.length >= cap) break;
    off += 500;
  }
  return out;
}

// ---------- 路由 ----------
app.get("/api/health", (req, res) => res.json({ ok: true }));

// 最近 7 天按天统计（东八区）：答题/答对/答错/新词 + 累计总览
app.all("/api/stats", async (req, res) => {
  try {
    const uid = await getUid(req);
    if (!uid) return res.status(401).json({ error: "未登录" });
    const DAY = 86400000, TZ = 8 * 3600 * 1000;
    const todayNum = Math.floor((Date.now() + TZ) / DAY);
    const startMs = (todayNum - 6) * DAY - TZ; // 7 天前的东八区 0 点
    const reviews = await getRecentReviews(uid, startMs, 20000);
    const dayBucket = {};
    for (const r of reviews) {
      const d = todayNum - Math.floor((r.occurred_at + TZ) / DAY);
      if (d < 0 || d > 6) continue;
      const b = dayBucket[d] || (dayBucket[d] = { answers: 0, correct: 0, wrong: 0 });
      b.answers += 1;
      if (r.rating >= 3) b.correct += 1; else b.wrong += 1;
    }
    const newsRows = await pg("GET", `/word_state?user_id=eq.${uid}&created_at=gte.${startMs}&select=word,created_at&limit=2000`);
    const newBucket = {};
    for (const r of newsRows) {
      const d = todayNum - Math.floor(((r.created_at || 0) + TZ) / DAY);
      if (d < 0 || d > 6) continue;
      newBucket[d] = (newBucket[d] || 0) + 1;
    }
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const b = dayBucket[i] || { answers: 0, correct: 0, wrong: 0 };
      days.push({
        start: (todayNum - i) * DAY - TZ,
        answers: b.answers, correct: b.correct, wrong: b.wrong,
        newWords: newBucket[i] || 0,
      });
    }
    // 累计总览（来自 word_state 计数）
    const states = await getAllStates(uid);
    let totalCorrect = 0, totalWrong = 0;
    for (const r of states) { totalCorrect += r.correct_count || 0; totalWrong += r.wrong_count || 0; }
    const totalAnswers = totalCorrect + totalWrong;
    return res.json({
      days,
      total: {
        answers: totalAnswers, correct: totalCorrect, wrong: totalWrong,
        accuracy: totalAnswers ? Math.round((100 * totalCorrect) / totalAnswers) : 0,
      },
    });
  } catch (e) { return res.status(e.status || 500).json({ error: String((e && e.message) || e) }); }
});

app.all("/api/register", async (req, res) => {
  try {
    let username, password;
    if (req.method === "GET") { username = req.query.username; password = req.query.password; }
    else { username = req.body && req.body.username; password = req.body && req.body.password; }
    if (!username || !password) return res.status(400).json({ error: "缺少用户名或密码" });
    // 不再限制单用户：用户名唯一由数据库 UNIQUE 约束保证（重复时返回 409）
    const salt = crypto.randomBytes(16).toString("hex");
    const pass_hash = salt + ":" + (await hashPassword(password, salt));
    let row;
    try {
      row = await insertUser(username, pass_hash);
    } catch (e) {
      if (e && e.status === 409) return res.status(409).json({ error: "该用户名已被注册，请换一个或直接登录" });
      throw e;
    }
    const token = await signToken(SECRET, { uid: String(row.id), exp: Date.now() + 30 * 86400000 });
    return res.json({ token, username });
  } catch (e) { return res.status(e.status || 500).json({ error: String((e && e.message) || e) }); }
});

app.all("/api/login", async (req, res) => {
  try {
    let username, password;
    if (req.method === "GET") { username = req.query.username; password = req.query.password; }
    else { username = req.body && req.body.username; password = req.body && req.body.password; }
    const row = await findUserByUsername(username);
    if (!row) return res.status(401).json({ error: "用户不存在" });
    const [salt, hash] = row.pass_hash.split(":");
    if ((await hashPassword(password, salt)) !== hash) return res.status(401).json({ error: "密码错误" });
    const token = await signToken(SECRET, { uid: String(row.id), exp: Date.now() + 30 * 86400000 });
    return res.json({ token, username });
  } catch (e) { return res.status(e.status || 500).json({ error: String((e && e.message) || e) }); }
});

app.all("/api/state", async (req, res) => {
  try {
    const uid = await getUid(req);
    if (!uid) return res.status(401).json({ error: "未登录" });
    const states = await getAllStates(uid);
    const sm = await getSettings(uid);
    const map = {};
    for (const r of states) map[r.word] = rowToState(r);
    const smap = {};
    for (const r of sm) smap[r.key] = r.value;
    return res.json({ wordStates: map, settings: smap });
  } catch (e) { return res.status(e.status || 500).json({ error: String((e && e.message) || e) }); }
});

app.all("/api/sync", async (req, res) => {
  try {
    const uid = await getUid(req);
    if (!uid) return res.status(401).json({ error: "未登录" });
    let ops = [];
    if (req.method === "GET") { try { ops = JSON.parse(req.query.ops || "[]"); } catch { ops = []; } }
    else { ops = req.body && Array.isArray(req.body.ops) ? req.body.ops : []; }
    const touched = {};
    const applied = [];

    for (const op of ops) {
      if (op.type === "answer") {
        const { word, rating, occurred_at, op_id } = op;
        if (!word || rating == null || !op_id) continue;
        if (await reviewExists(uid, op_id)) {
          const cur = await findState(uid, word);
          if (cur) touched[word] = rowToState(cur);
          applied.push(op_id);
          continue;
        }
        try { await pg("POST", "/review_log", [{ user_id: uid, word, rating, occurred_at: occurred_at || Date.now(), op_id }]); } catch {}
        const cur = await findState(uid, word);
        const base = cur ? { level: cur.level, interval_days: cur.interval_days, ease: cur.ease, reps: cur.reps, lapses: cur.lapses } : { level: 0, interval_days: 0, ease: 2.5, reps: 0, lapses: 0 };
        const ns = applySRS(base, rating);

        // ---- 错题本系统（rating: 0=答错, 3+=答对）----
        let is_wrong_book = cur ? !!cur.is_wrong_book : false;
        let ever_wrong = cur ? !!cur.ever_wrong : false;
        let wrong_streak = cur ? (cur.wrong_streak || 0) : 0;
        let wrong_added_at = cur ? (cur.wrong_added_at || 0) : 0;
        let wrong_count = cur ? (cur.wrong_count || 0) : 0;
        let correct_count = cur ? (cur.correct_count || 0) : 0;

        if (rating < 3) {
          // 答错：进错题本 + 曾错题标记，连续答对计数清零，第二天 0 点必进复习队列
          is_wrong_book = true; ever_wrong = true; wrong_streak = 0;
          wrong_added_at = Date.now(); // 每次答错都刷新（= 最近一次答错时间，错题本按此倒序）
          wrong_count += 1;
          ns.due_at = nextMidnightCST();
        } else {
          correct_count += 1;
          if (is_wrong_book) {
            // 错题本内答对：连对 +1；满 3 次毕业移出错题本（保留曾错题标记）
            wrong_streak += 1;
            if (wrong_streak >= 3) {
              is_wrong_book = false;
              // due_at 使用 SRS 正常间隔
            } else {
              ns.due_at = nextMidnightCST(); // 未毕业：明天继续复习
            }
          }
        }
        // 核心规则：仍在错题本中的词不能算"掌握"（level 封顶 2），毕业移出错题本后才能升到 3
        if (rating >= 3 && is_wrong_book && ns.level >= 3) ns.level = 2;

        const now = Date.now();
        const rev = (cur ? (cur.rev || 0) : 0) + 1;
        const st = {
          level: ns.level, due_at: ns.due_at, interval_days: ns.interval_days, ease: ns.ease,
          reps: ns.reps, lapses: ns.lapses, rev, updated_at: now, deleted_at: 0,
          is_wrong_book, ever_wrong, wrong_streak, wrong_added_at, wrong_count, correct_count,
        };
        // created_at = 首次学习时间：仅首次落库（或旧数据缺失）时写入，upsert 已存在值时不覆盖
        if (!cur || !cur.created_at) st.created_at = now;
        await upsertState(uid, word, st);
        touched[word] = rowToState(st);
        applied.push(op_id);
      } else if (op.type === "state") {
        const { word, state, updated_at, op_id } = op;
        if (!word || !state) continue;
        const ts = updated_at || Date.now();
        const cur = await findState(uid, word);
        if (!cur || (cur.updated_at || 0) <= ts) {
          const fields = {
            level: state.level || 0, due_at: state.due_at || 0, interval_days: state.interval_days || 0,
            ease: state.ease || 2.5, reps: state.reps || 0, lapses: state.lapses || 0,
            rev: (cur ? (cur.rev || 0) : 0) + 1, updated_at: ts, deleted_at: 0,
            is_wrong_book: !!state.is_wrong_book, ever_wrong: !!state.ever_wrong,
            wrong_streak: state.wrong_streak || 0, wrong_added_at: state.wrong_added_at || 0,
            wrong_count: state.wrong_count || 0, correct_count: state.correct_count || 0,
            is_mastered: !!state.is_mastered,
          };
          // 首次出现（或旧数据缺失）时补首次学习时间
          if (!cur || !cur.created_at) fields.created_at = state.created_at || ts;
          await upsertState(uid, word, fields);
        }
        applied.push(op_id || ("state:" + word));
      } else if (op.type === "setting") {
        const { key, value, updated_at } = op;
        if (!key) continue;
        await upsertSetting(uid, key, value, updated_at || Date.now());
        applied.push(op_id || ("set:" + key));
      }
    }
    return res.json({ ok: true, applied, wordStates: touched });
  } catch (e) { return res.status(e.status || 500).json({ error: String((e && e.message) || e) }); }
});

app.all("/api/reset", async (req, res) => {
  try {
    const uid = await getUid(req);
    if (!uid) return res.status(401).json({ error: "未登录" });
    await pg("DELETE", `/word_state?user_id=eq.${uid}`);
    await pg("DELETE", `/review_log?user_id=eq.${uid}`);
    return res.json({ ok: true });
  } catch (e) { return res.status(e.status || 500).json({ error: String((e && e.message) || e) }); }
});

// 修改密码（需验证旧密码）
app.all("/api/change-password", async (req, res) => {
  try {
    const uid = await getUid(req);
    if (!uid) return res.status(401).json({ error: "未登录" });
    let old_password, new_password;
    if (req.method === "GET") { old_password = req.query.old_password; new_password = req.query.new_password; }
    else { old_password = req.body && req.body.old_password; new_password = req.body && req.body.new_password; }
    if (!old_password || !new_password) return res.status(400).json({ error: "缺少当前密码或新密码" });
    if (String(new_password).length < 6) return res.status(400).json({ error: "新密码至少 6 位" });
    const arr = await pg("GET", `/users?id=eq.${uid}&limit=1`);
    const user = Array.isArray(arr) && arr[0] ? arr[0] : null;
    if (!user) return res.status(404).json({ error: "用户不存在" });
    const [salt, hash] = user.pass_hash.split(":");
    if ((await hashPassword(old_password, salt)) !== hash) return res.status(401).json({ error: "当前密码错误" });
    const nsalt = crypto.randomBytes(16).toString("hex");
    const nhash = nsalt + ":" + (await hashPassword(new_password, nsalt));
    await pg("PATCH", `/users?id=eq.${uid}`, { pass_hash: nhash });
    return res.json({ ok: true });
  } catch (e) { return res.status(e.status || 500).json({ error: String((e && e.message) || e) }); }
});

// 忘记密码重置（恢复码 + 用户名 + 新密码，无需登录）
app.all("/api/reset-password", async (req, res) => {
  try {
    let username, recovery_key, new_password;
    if (req.method === "GET") { username = req.query.username; recovery_key = req.query.recovery_key; new_password = req.query.new_password; }
    else { username = req.body && req.body.username; recovery_key = req.body && req.body.recovery_key; new_password = req.body && req.body.new_password; }
    if (!username || !recovery_key || !new_password) return res.status(400).json({ error: "缺少参数" });
    if (recovery_key !== RECOVERY_KEY) return res.status(403).json({ error: "恢复码错误" });
    if (String(new_password).length < 6) return res.status(400).json({ error: "新密码至少 6 位" });
    const arr = await pg("GET", `/users?username=eq.${encodeURIComponent(username)}&limit=1`);
    const user = Array.isArray(arr) && arr[0] ? arr[0] : null;
    if (!user) return res.status(404).json({ error: "用户不存在" });
    const nsalt = crypto.randomBytes(16).toString("hex");
    const nhash = nsalt + ":" + (await hashPassword(new_password, nsalt));
    await pg("PATCH", `/users?id=eq.${user.id}`, { pass_hash: nhash });
    return res.json({ ok: true });
  } catch (e) { return res.status(e.status || 500).json({ error: String((e && e.message) || e) }); }
});

app.get("/", (req, res) => res.json({ name: "wordbook-api", ok: true }));

app.listen(9000, () => console.log("wordbook-api (PostgreSQL) listening on 9000"));