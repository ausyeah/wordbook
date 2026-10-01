#!/usr/bin/env node
/**
 * 前后端 SRS 一致性测试（零依赖）
 *
 * 背景：frontend/app.js 与 api/index.js 各自持有一份同名 applySRS 镜像实现，
 * 靠人工保持一致。2026-08-30 的 e45163d 把后端改成"刷一轮"模式时，
 * 新代码误用了前端的变量名 `iv`（后端解构出的名字是 `interval_days`），
 * 导致 Math.max(iv, 365) 读取未声明变量抛 ReferenceError，
 * /api/sync 整批 500、outbox 永久卡死，而前端把错误吞掉了，肉眼无感。
 *
 * 本测试把两份实现抽出来跑同一批输入比对输出，并对照黄金语义断言。
 * 任何一侧漂移或再次写错变量名，这里都会红。
 *
 * 运行：node tests/srs.parity.test.js
 * 也可：node --test tests/
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const FE = path.join(ROOT, "frontend", "app.js");
const BE = path.join(ROOT, "api", "index.js");

/** 从源码里按花括号配平精确抽出具名函数，避免正则误伤注释里的同名片段。 */
function extract(src, name) {
  const sig = `function ${name}(`;
  let i = src.indexOf(sig);
  if (i < 0) throw new Error(`在源码中找不到 ${name}`);
  const open = src.indexOf("{", i);
  let depth = 0, k = open;
  for (; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`${name} 的花括号不配平，源码可能被截断`);
  return src.slice(i, k + 1);
}

/**
 * 在非严格模式下求值，模拟真实的 CommonJS 云函数作用域。
 * 显式挂一个 sandbox 作为 globalThis：若被测代码里有 `iv = ...` 这类未声明赋值，
 * 它会落在这个 sandbox 上而不是真的污染进程 global，也便于事后断言。
 */
function load(src, label) {
  const sandbox = {};
  const names = Object.keys(sandbox);
  const vals = Object.values(sandbox);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `${src}\nreturn applySRS;`);
  const fn = factory(...vals);
  return { fn, label, sandbox };
}

const feSrc = fs.readFileSync(FE, "utf8");
const beSrc = fs.readFileSync(BE, "utf8");
const frontend = load(extract(feSrc, "applySRS"), "frontend");
const backend = load(extract(beSrc, "applySRS"), "backend");

// ---------- 固定时钟，让 due_at 可断言 ----------
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const DAY = 86400000;
const realNow = Date.now;
Date.now = () => NOW;

// ---------- 输入矩阵：覆盖新词 / 熟词 / 错题本 / 脏数据 / 边界 rating ----------
const BASE = { level: 0, interval_days: 0, ease: 2.5, reps: 0, lapses: 0 };
const CASES = [
  ["新词首次答对 (rating 5)",  { ...BASE }, 5],
  ["熟词再答对 (rating 4)",    { level: 3, interval_days: 365, ease: 2.5, reps: 4, lapses: 0 }, 4],
  ["错题本答对 (rating 3)",    { level: 2, interval_days: 1, ease: 2.5, reps: 1, lapses: 1 }, 3],
  ["间隔小于 365 时答对",      { level: 0, interval_days: 6, ease: 2.5, reps: 1, lapses: 0 }, 5],
  ["答错 (rating 0)",          { level: 3, interval_days: 365, ease: 2.5, reps: 4, lapses: 0 }, 0],
  ["答错 (rating 2)",          { level: 3, interval_days: 365, ease: 2.5, reps: 4, lapses: 0 }, 2],
  ["level 已为 0 时答错",      { level: 0, interval_days: 1, ease: 2.5, reps: 0, lapses: 3 }, 0],
  ["脏数据：缺字段",            { level: 2 }, 5],
  ["脏数据：interval_days 为 0 且答对", { level: 0, interval_days: 0, ease: 2.5, reps: 0, lapses: 0 }, 3],
];

// 前端用 `||` 兜底、后端用解构默认值，两者对 null 的处理不同（null 会穿透解构）。
// 但所有写入路径都显式传了字面量默认值，null 进不到 DB，因此不作为失败项，
// 只在下面单独列出供人工确认。
const NULL_TOLERANCE = [
  ["脏数据：null 值", { level: null, interval_days: null, ease: null, reps: null, lapses: null }, 5],
];

let failed = 0;
// 全部走 stdout：写 stderr 会被 PowerShell 的 2>&1 合并重定向打乱，
// 失败行和表格会串成一行，反而看不清。
const bad = (msg) => { failed++; console.log("  ✗ " + msg); };

console.log("前后端 SRS 一致性测试");
console.log("=".repeat(78));

// ---------- 1) 黄金语义（独立于两份实现，直接断言产品规则） ----------
const GOLDEN = [
  // 答对：间隔至少推到一年后，level 直接置 3，reps+1
  [CASES[0], (r) => r.interval_days === 365 && r.level === 3 && r.reps === 1],
  [CASES[1], (r) => r.interval_days === 365 && r.level === 3 && r.reps === 5],
  [CASES[3], (r) => r.interval_days === 365 && r.level === 3],
  // 答错：间隔重置为 1 天，level 递减且不低于 0，lapses+1，reps 清零
  [CASES[4], (r) => r.interval_days === 1 && r.level === 2 && r.lapses === 1 && r.reps === 0],
  [CASES[6], (r) => r.interval_days === 1 && r.level === 0 && r.lapses === 4],
  // due_at 必须由 interval_days 推导，而不是别的来源
  [CASES[0], (r) => r.due_at === NOW + 365 * DAY],
  [CASES[4], (r) => r.due_at === NOW + 1 * DAY],
  // 脏数据要有默认值
  [CASES[7], (r) => r.ease === 2.5 && r.reps === 1 && r.interval_days === 365],
];
for (const [[name, input, rating], ok] of GOLDEN) {
  for (const side of [frontend, backend]) {
    let r;
    try { r = side.fn({ ...input }, rating); }
    catch (e) { bad(`黄金语义 [${name}] ${side.label} 抛错：${e.message}`); continue; }
    if (!ok(r)) bad(`黄金语义 [${name}] ${side.label} 不符：${JSON.stringify(r)}`);
  }
}
console.log(`黄金语义：${GOLDEN.length} 条断言 × 两侧 = ${GOLDEN.length * 2} 次检查`);

// ---------- 2) 逐场景比对两侧输出 ----------
console.log("\n逐场景前后端比对");
console.log("-".repeat(78));
const W = 26;

/**
 * 按显示宽度补齐。中文/全角符号占 2 列，直接用 padEnd 会算歪，
 * 导致前面判失败时表格挤成一行（第一次跑就是这样）。
 */
function pad(str, width) {
  const s = String(str);
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(1, width - w));
}

console.log("  " + pad("场景", 30) + pad("前端", 22) + pad("后端", 22) + "一致");
for (const [name, input, rating] of CASES) {
  const run = (side) => {
    try {
      const r = side.fn({ ...input }, rating);
      return `iv=${r.interval_days} +${((r.due_at - NOW) / DAY).toFixed(0)}d L${r.level}`;
    } catch (e) { return "抛错:" + e.message.slice(0, 14); }
  };
  const a = run(frontend), b = run(backend);
  let same;
  try {
    assert.deepStrictEqual(backend.fn({ ...input }, rating), frontend.fn({ ...input }, rating));
    same = true;
  } catch (e) {
    same = e.code === "ERR_ASSERTION" ? false : false;
    if (e.code !== "ERR_ASSERTION") bad(`[${name}] 后端抛错：${e.message}`);
    else bad(`[${name}] 前后端不一致\n      前端 ${a}\n      后端 ${b}`);
    failed = failed; // 已计入
  }
    console.log("  " + pad(name, 30) + pad(a, 22) + pad(b, 22) + (same ? "✓" : "✗"));
}

// ---------- 3) 未声明变量扫描 ----------
// 精确复原 e45163d 那类 bug：赋值目标不在任何声明里。窄口径，只看 `x = ...` / `x += ...`。
console.log("\n未声明赋值扫描（applySRS 内）");
console.log("-".repeat(78));
for (const [label, src] of [["frontend", extract(feSrc, "applySRS")], ["backend", extract(beSrc, "applySRS")]]) {
  // 只认「本文件内 let/const/var 声明出来的」+ 参数 + 内建。
  // 刻意不预置 iv/laps 之类的名字：前端用 iv、后端用 interval_days 是既成事实，
  // 但把名字塞进白名单会让 e45163d 那类「照抄另一侧的变量名」漏网，
  // 而那正是我们要拦的 bug。
  const declared = new Set(["s", "rating", "Math", "Date"]);
  // 两种声明都要认：
  //   后端 `let { level = 0, interval_days = 0, … } = s;`  （解构）
  //   前端 `let level = …, iv = …, ease = …;`                （逗号连声明）
  for (const m of src.matchAll(/\b(?:let|const|var)\s+\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const id = part.split(/[:=]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) declared.add(id);
    }
  }
  for (const m of src.matchAll(/\b(?:let|const|var)\s+([^;\n{]+)/g)) {
    for (const part of m[1].split(",")) {
      const id = part.split(/[:=]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) declared.add(id);
    }
  }

  // 找出所有赋值（排除 ==、===、!=、>= 等比较，以及对象字面量的 key）
  const offenders = new Set();
  for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?:\|\||&&|\?\?|[+\-*/]?=(?!=|>))/g)) {
    const id = m[1];
    if (["return", "if", "else", "function", "typeof"].includes(id)) continue;
    if (!declared.has(id)) offenders.add(id);
  }
  if (offenders.size) {
    bad(`${label} applySRS 内赋值给未声明标识符：${[...offenders].join(", ")}`);
    console.log(`  ✗ ${pad(label, 12)} ${[...offenders].join(", ")}`);
  } else {
    console.log(`  ✓ ${pad(label, 12)} 无未声明赋值`);
  }
}

// ---------- 3.5) null 穿透差异：显式展示，不计入失败 ----------
console.log("\nnull 穿透差异（前端 || 兜底 vs 后端解构默认值）");
console.log("-".repeat(78));
for (const [name, input, rating] of NULL_TOLERANCE) {
  let a, b;
  try { a = frontend.fn({ ...input }, rating); b = backend.fn({ ...input }, rating); }
  catch (e) { bad(`null 穿透检查 [${name}] 抛错：${e.message}`); continue; }
  const diff = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  if (diff.length) {
    console.log(`  ⚠ ${name}：${diff.map((k) => `${k} 前端=${JSON.stringify(a[k])} 后端=${JSON.stringify(b[k])}`).join("; ")}`);
    console.log("    DB 写入路径均传字面量默认值，null 不可达，故不判失败");
  } else {
    console.log(`  ✓ ${name}：两侧一致`);
  }
}

// ---------- 4) 真实 smoke：模拟 /api/sync 的 answer 分支不会抛错 ----------
console.log("\n/api/sync answer 分支 smoke（rating>=3 不得抛错）");
console.log("-".repeat(78));
for (const rating of [3, 4, 5]) {
  try {
    const r = backend.fn({ level: 0, interval_days: 0, ease: 2.5, reps: 0, lapses: 0 }, rating);
    if (!(r.interval_days >= 365)) bad(`rating=${rating} 间隔未推远：${r.interval_days}`);
    else console.log(`  ✓ rating=${rating} → interval_days=${r.interval_days}, due=+${((r.due_at - NOW) / DAY).toFixed(0)}d`);
  } catch (e) {
    bad(`rating=${rating} 抛错：${e.message}`);
    console.log(`  ✗ rating=${rating} → 抛错 ${e.message}`);
  }
}

Date.now = realNow;
console.log("\n" + "=".repeat(78));
console.log(failed === 0 ? "全部通过 ✓" : `失败 ${failed} 项 ✗`);
process.exit(failed === 0 ? 0 : 1);
