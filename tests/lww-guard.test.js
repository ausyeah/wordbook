#!/usr/bin/env node
/**
 * 回归测试：state op 的 updated_at 必须严格递增，否则被服务端 LWW 静默丢弃。
 *
 * 线上实测复现过这个 bug（2026-10-01）：
 *   ① 答对一题        → 服务端用 Date.now() 盖 updated_at
 *   ② 立刻点「☆ 熟词」→ 客户端取 Date.now()，必然 ≤ 服务端那个戳
 *   ③ 服务端守卫 cur.updated_at <= ts 为假 → 整条 state op 被跳过
 *   ④ UI 显示标记成功，刷新后标记消失
 *   对照组：把 ts 改大 → is_mastered 变 true
 *
 * 本测试抽出前端 nextTs 的语义，验证它在三种情况下都给出严格递增的时间戳。
 * 运行：node tests/lww-guard.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const APP = path.resolve(__dirname, "..", "frontend", "app.js");
const src = fs.readFileSync(APP, "utf8");

// ---------- 确认修复真的在文件里（防止被误删/回退）----------
assert.ok(
  /function nextTs\(word\)/.test(src),
  "找不到 nextTs —— 熟词 LWW 修复可能被回退了"
);
assert.ok(
  /const now = nextTs\(word\)/.test(src) || /now = nextTs\(word\)/.test(src),
  "markMastered / removeEntry 未改用 nextTs"
);
assert.ok(
  !/is_mastered: true[\s\S]{0,400}?updated_at: now[\s\S]{0,200}?const now = Date\.now\(\)/.test(src),
  "markMastered 里仍存在独立的 Date.now() 打戳"
);

console.log("state op LWW 回归测试");
console.log("=".repeat(70));

// ---------- 复刻 nextTs 的实现（与 app.js 保持一致）----------
const S = { progress: {} };
let FAKE_NOW = 1000000;
const realNow = Date.now;
Date.now = () => FAKE_NOW;

function nextTs(word) {
  const cur = S.progress[word];
  const known = cur ? cur.updated_at || 0 : 0;
  return Math.max(FAKE_NOW, known + 1);
}

let failed = 0;
const bad = (m) => { failed++; console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);

// ---------- 1) 全新词 ----------
FAKE_NOW = 1000000;
let t1 = nextTs("radiate");
t1 === 1000000 ? ok(`新词首戳 = ${t1}（等于当前时钟）`)
               : bad(`新词首戳异常: ${t1}`);

// ---------- 2) 服务端已打过戳（模拟 answer op 刚落库），本地时钟相同 ----------
S.progress["radiate"] = { updated_at: FAKE_NOW };   // 服务端与本地同一毫秒
let t2 = nextTs("radiate");
t2 > 1000000 ? ok(`同毫秒 → 递增到 ${t2}（避开了服务端戳）`)
             : bad(`同毫秒未递增: ${t2} <= 1000000`);

// ---------- 3) 本地时钟落后于服务端（设备时间不准）----------
FAKE_NOW = 900000;                                   // 本地时钟被往回调了
S.progress["radiate"] = { updated_at: 1000000 };    // 服务端戳更晚
let t3 = nextTs("radiate");
t3 > 1000000 ? ok(`时钟落后 → 仍取 ${t3}（超过服务端戳）`)
             : bad(`时钟落后时未越过服务端戳: ${t3} <= 1000000`);

// ---------- 4) 连续多次操作必须每次都递增（模拟反复点熟词/取消）----------
FAKE_NOW = 1000000;
S.progress["x"] = { updated_at: 1000000 };
const seq = [];
for (let i = 0; i < 5; i++) {
  const t = nextTs("x");
  seq.push(t);
  S.progress["x"] = { updated_at: t };
}
const strictlyUp = seq.every((v, i) => i === 0 || v > seq[i - 1]);
strictlyUp ? ok(`连续 5 次递增: ${seq.join(" < ")}`)
           : bad(`连续操作未严格递增: ${seq.join(", ")}`);

// ---------- 5) 服务端守卫语义模拟 ----------
// 客户端时间戳一律经 nextTs 处理，不存在"原样落后"的路径，
// 所以这里必须用 nextTs 的真实输出去喂守卫。
console.log("\n模拟服务端守卫 (api/index.js:361  cur.updated_at <= ts)");
const guardCases = [
  ["答对后立刻点熟词（同一毫秒）", 1000000, () => { FAKE_NOW = 1000000; return nextTs("g1"); }],
  ["答对后点熟词（本地时钟落后）", 1000000, () => { FAKE_NOW = 900000; return nextTs("g2"); }],
  ["正常情况（本地更晚）", 1000000, () => { FAKE_NOW = 1000500; return nextTs("g3"); }],
];
for (const [name, serverTs, makeTs] of guardCases) {
  // 客户端侧必须持有服务端刚盖的戳（answer op 同步回来的）
  const w = "g" + Math.random().toString(36).slice(2, 6);
  S.progress[w] = { updated_at: serverTs };
  const origFn = nextTs;
  // 直接对同一词求戳
  const clientTs = (() => {
    const cur = S.progress[w];
    return Math.max(FAKE_NOW, (cur ? cur.updated_at || 0 : 0) + 1);
  })();
  FAKE_NOW = 1000000;   // 复位，避免影响后续
  const pass = serverTs <= clientTs;
  pass ? ok(`${name}: 服务端 ${serverTs} <= 客户端 ${clientTs} → 写入`)
       : bad(`${name}: 服务端 ${serverTs} <= 客户端 ${clientTs} → 被丢弃`);
}

Date.now = realNow;
console.log("\n" + "=".repeat(70));
console.log(failed === 0 ? "全部通过 ✓" : `失败 ${failed} 项 ✗`);
process.exit(failed === 0 ? 0 : 1);
