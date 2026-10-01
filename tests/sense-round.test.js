#!/usr/bin/env node
/**
 * 义项辨析 + 循环轮次 测试。
 *
 * 义项辨析要解决的真问题：
 *   常规四选一的选项是「n. 地址；vt. 寄往」这种多义项拼接串，
 *   只认出第一个义项（address = 地址）也能匹配判对 —— 假阳性，
 *   熟词僻义根本没被考到。改成按单个义项出题后绕不过去。
 *
 * 循环轮次要保证：
 *   进度由 updated_at 派生（不改数据库）、答完自动离队、按薄弱排序、
 *   只含「已学过」的词而非纯新词。
 *
 * 运行：node tests/sense-round.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const vocab = JSON.parse(fs.readFileSync(path.join(ROOT, "frontend", "vocab.json"), "utf8"));
const index = JSON.parse(fs.readFileSync(path.join(ROOT, "frontend", "vocab-index.json"), "utf8"));
const appSrc = fs.readFileSync(path.join(ROOT, "frontend", "app.js"), "utf8");

function extractFn(src, name) {
  const sig = `function ${name}(`;
  const i = src.indexOf(sig);
  assert.ok(i >= 0, `app.js 中找不到 ${name}`);
  let depth = 0, k = src.indexOf("{", i);
  for (; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, `${name} 花括号不配平`);
  return src.slice(i, k + 1);
}

const S = {
  vocab: vocab.words,
  vmap: Object.fromEntries(vocab.words.map((w) => [w.word, w])),
  progress: {},
  round: { n: 0, startedAt: 0 },
  clusterOf: new Map(),
  synIdOf: new Map(),
  byPos: new Map(),
};
for (const [, words] of Object.entries(index.clusters || {}))
  for (const w of words) if (!S.clusterOf.has(w)) S.clusterOf.set(w, words.slice());
for (let i = 0; i < (index.synGroups || []).length; i++)
  for (const w of index.synGroups[i]) S.synIdOf.set(w, i);
for (const [p, ws] of Object.entries(index.byPos || {})) S.byPos.set(p, ws);

// 注入被测实现。buildSenseQuestion 内部用到 rand，必须一并提供，
// 否则抽取出来的函数在测试环境里直接 ReferenceError。
const rand = (n) => Math.floor(Math.random() * n);
// eslint-disable-next-line no-new-func
const impl = new Function("S", "rand",
  extractFn(appSrc, "splitSenses") + "\n" +
  extractFn(appSrc, "normSense") + "\n" +
  extractFn(appSrc, "sensePos") + "\n" +
  extractFn(appSrc, "multiSenseWords") + "\n" +
  extractFn(appSrc, "posSet") + "\n" +
  extractFn(appSrc, "overlaps") + "\n" +
  extractFn(appSrc, "buildSenseQuestion") + "\n" +
  extractFn(appSrc, "roundQueue") +
  "\nreturn { splitSenses, normSense, multiSenseWords, buildSenseQuestion, roundQueue };")(S, rand);

const { splitSenses, normSense, multiSenseWords, buildSenseQuestion, roundQueue } = impl;

let failed = 0;
const bad = (m) => { failed++; console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);

console.log("义项辨析 + 循环轮次 测试");
console.log("=".repeat(72));

// ---------- 1) 义项拆分 ----------
console.log("\n1. 义项拆分");
{
  const multi = multiSenseWords();
  const c = {};
  for (const w of S.vocab) { const n = splitSenses(w.meaning).length; c[n] = (c[n] || 0) + 1; }
  ok(`义项数分布：${Object.entries(c).map(([k, v]) => `${k}个=${v}`).join(" ")}`);
  ok(`多义词池 ${multi.length} 词（${((100 * multi.length) / S.vocab.length).toFixed(1)}%）`);
  const noEmpty = S.vocab.every((w) => splitSenses(w.meaning).every((s) => s.length > 0));
  noEmpty ? ok("无空义项") : bad("存在空义项");
  const allMulti = multi.every((w) => splitSenses(w.meaning).length >= 2);
  allMulti ? ok("池内每个词确实 ≥2 义项") : bad("池内混入了单义项");
}

// ---------- 2) 义项题的核心约束：答案唯一 ----------
console.log("\n2. 义项题答案唯一性（硬约束）");
{
  let multiCorrect = 0, tooFew = 0, selfIncluded = 0, N = 5000;
  for (let i = 0; i < N; i++) {
    const q = buildSenseQuestion();
    if (!q) { tooFew++; continue; }
    const correct = q.options.filter((o) => o.correct);
    if (correct.length !== 1) multiCorrect++;
    // 任何干扰项的释义若也含这个义项 → 也是对的
    const target = normSense(q.sense);
    for (const o of q.options) {
      if (o.correct) continue;
      const ow = S.vmap[o.word];
      if (!ow) { selfIncluded++; continue; }
      if (splitSenses(ow.meaning).some((x) => normSense(x) === target)) multiCorrect++;
    }
  }
  multiCorrect === 0 ? ok(`${N} 次抽样：始终恰有 1 个正确答案，无第二个可选项`) : bad(`${multiCorrect} 处出现多个正确答案`);
  selfIncluded === 0 ? ok("所有选项都对应真实词条") : bad(`${selfIncluded} 个选项无对应词条`);
  tooFew === 0 ? ok("每次都能构造出题") : bad(`${tooFew} 次构造失败`);
}

// ---------- 3) 义项题的干扰项质量 ----------
console.log("\n3. 义项题干扰项质量");
{
  // 只统计「干扰项」，不能把正确答案算进去 ——
  // 踩过的坑：断言写成 options.some(同前缀)，而正确答案自己必然满足，
  // 结果恒为 100%，掩盖了真实命中率。
  let anySameCluster = 0, allSamePos = 0, N = 4000;
  for (let i = 0; i < N; i++) {
    const q = buildSenseQuestion();
    if (!q) continue;
    const key = q.word.word.slice(0, 4);
    const dis = q.options.filter((o) => !o.correct).map((o) => S.vmap[o.word]).filter(Boolean);
    if (dis.length !== 3) continue;
    if (dis.some((d) => d.word.slice(0, 4) === key)) anySameCluster++;
    const myPos = new Set(String(q.word.pos).split(/[/／]/).map((s) => s.trim().replace(/\.$/, "").trim()));
    if (dis.every((d) => String(d.pos).split(/[/／]/).some((p) => myPos.has(p.trim().replace(/\.$/, "").trim())))) allSamePos++;
  }
  const cPct = (100 * anySameCluster) / N, pPct = (100 * allSamePos) / N;
  cPct > 30 ? ok(`至少 1 个同词根干扰 ${cPct.toFixed(1)}%`) : bad(`同词根干扰仅 ${cPct.toFixed(1)}%`);
  pPct > 60 ? ok(`3 个干扰项全同词性 ${pPct.toFixed(1)}%`) : bad(`同词性仅 ${pPct.toFixed(1)}%`);

  // 参考：多义词只有约 30% 落在词根簇内，所以这个比例不可能接近 100%
  const inCluster = new Set();
  for (const ws of Object.values(index.clusters || {})) for (const w of ws) inCluster.add(w);
  const multiInCluster = multiSenseWords().filter((w) => inCluster.has(w.word)).length;
  const ceiling = (100 * multiInCluster) / multiSenseWords().length;
  console.log(`  （多义词落在簇内 ${multiInCluster}/${multiSenseWords().length} = ${ceiling.toFixed(1)}%，即同词根理论上限）`);
}

// ---------- 4) 循环轮次：派生逻辑 ----------
console.log("\n4. 循环轮次派生");
{
  // 未开轮次 → 队列为空（不能干扰正常学习）
  S.round = { n: 0, startedAt: 0 };
  S.progress = {};
  roundQueue().length === 0 ? ok("未开轮次时队列为空（不干扰新词学习）") : bad("未开轮次时队列非空");

  // 造数据：3 个已学词 + 1 个纯新词
  const base = Date.now();
  S.progress = {
    errA: { level: 3, is_mastered: false, ever_wrong: true, wrong_count: 5, lapses: 2, wrong_added_at: base - 1000, updated_at: base - 50000 },
    errB: { level: 2, is_mastered: false, ever_wrong: true, wrong_count: 1, lapses: 0, wrong_added_at: base - 2000, updated_at: base - 50000 },
    clean: { level: 3, is_mastered: true, ever_wrong: false, wrong_count: 0, lapses: 0, wrong_added_at: 0, updated_at: base - 50000 },
    fresh: { level: 0, is_mastered: false, ever_wrong: false, wrong_count: 0, lapses: 0, updated_at: 0 },
  };
  S.vocab.push({ word: "errA", meaning: "x" }, { word: "errB", meaning: "y" }, { word: "clean", meaning: "z" }, { word: "fresh", meaning: "w" });

  // 开轮次：startedAt = 现在，之前学的都应进队
  S.round = { n: 1, startedAt: base };
  let q = roundQueue().map((w) => w.word);
  q.length === 3 ? ok(`开轮后 3 个已学词进队（${q.join(", ")}）`) : bad(`进队 ${q.length} 个：${q.join(",")}`);
  q.includes("fresh") ? bad("纯新词被错误纳入轮次") : ok("纯新词不进轮次（轮次是复习，不是学新词）");

  // 排序：错得多的在前
  const q2 = roundQueue().map((w) => w.word);
  q2[0] === "errA" ? ok("按错误次数降序，错得最多的排最前") : bad(`排序错：${q2.join(",")}`);

  // 答完一题 → updated_at 推到当下 → 离队
  S.progress.errA.updated_at = base + 1000;
  q = roundQueue().map((w) => w.word);
  !q.includes("errA") && q.length === 2
    ? ok("答完后该词自动离队（由 updated_at 派生，无需额外字段）")
    : bad(`离队失败：${q.join(",")}`);

  // 全部答完 → 队列空 = 本轮完成
  S.progress.errB.updated_at = base + 1000;
  S.progress.clean.updated_at = base + 1000;
  roundQueue().length === 0 ? ok("全部答完后队列为空（本轮完成）") : bad(`仍有 ${roundQueue().length} 个`);

  // 第 2 轮：新一轮应该把上一轮答过的都召回
  S.round = { n: 2, startedAt: base + 2000 };
  q = roundQueue().map((w) => w.word);
  q.length === 3 ? ok("开第 2 轮后已学词重新全部进队（这就是原来缺失的复考路径）") : bad(`第2轮进队 ${q.length} 个`);

  S.vocab.length = vocab.words.length;
}

// ---------- 5) UI 接线 ----------
console.log("\n5. UI 接线");
{
  const html = fs.readFileSync(path.join(ROOT, "frontend", "index.html"), "utf8");
  html.includes('data-sm="sense"') ? ok("index.html 有义项模式按钮") : bad("缺少义项模式按钮");
  html.includes('id="round-panel"') ? ok("index.html 有轮次面板") : bad("缺少轮次面板");
  html.includes('id="btn-round"') ? ok("有开始轮次按钮") : bad("缺少轮次按钮");
  /btn-round[\s\S]{0,40}startRound/.test(appSrc) ? ok("按钮绑定到 startRound") : bad("按钮未绑定");
  /S\.studyMode === "quiz" \|\| S\.studyMode === "sense"/.test(appSrc)
    ? ok("键盘 1-4 在义项模式下可选答案") : bad("键盘处理未覆盖义项模式");
  /renderRoundPanel\(\)/.test(appSrc) ? ok("轮次面板会被渲染") : bad("轮次面板未渲染");
  /S\.senseQ = null/.test(appSrc) ? ok("切换模式时清空义项题缓存") : bad("未清空义项题缓存");
}

console.log("\n" + "=".repeat(72));
console.log(failed === 0 ? "全部通过 ✓" : `失败 ${failed} 项 ✗`);
process.exit(failed === 0 ? 0 : 1);
