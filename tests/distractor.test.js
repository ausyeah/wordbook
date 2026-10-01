#!/usr/bin/env node
/**
 * 干扰项选取测试：验证同词根分层抽取的正确性。
 *
 * 三条硬约束，缺一不可：
 *   1. 绝不能出现两个正确答案（同义组必须被排除）
 *   2. 四个选项互不相同、释义文本不重复
 *   3. 同词根干扰项比例应显著高于改动前的 0.20%
 *
 * 运行：node tests/distractor.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const vocab = JSON.parse(fs.readFileSync(path.join(ROOT, "frontend", "vocab.json"), "utf8"));
const index = JSON.parse(fs.readFileSync(path.join(ROOT, "frontend", "vocab-index.json"), "utf8"));

// ---------- 搭建与 app.js 同构的环境 ----------
const S = {
  vocab: vocab.words,
  vmap: Object.fromEntries(vocab.words.map((w) => [w.word, w])),
  clusterOf: new Map(),
  synIdOf: new Map(),
  byPos: new Map(),
  indexReady: true,
};
// 索引是 { 前缀: [该簇的词] }，需反查成 { 词: [同簇所有词] }。
// 踩过的坑：若写成 S.clusterOf.set(w, [w])，每个词的同簇只有自己，
// L1/L2 永远取不到词，同根率会停在 0.20% 而测试不报错（只是"提升不明显"）。
for (const [, words] of Object.entries(index.clusters || {}))
  for (const w of words) {
    if (!S.clusterOf.has(w)) S.clusterOf.set(w, words.slice());
  }
for (let i = 0; i < (index.synGroups || []).length; i++)
  for (const w of index.synGroups[i]) S.synIdOf.set(w, i);
for (const [pos, words] of Object.entries(index.byPos || {})) S.byPos.set(pos, words);

const rand = (n) => Math.floor(Math.random() * n);

// ---------- 与 app.js 中的实现保持一致 ----------
// 直接从 app.js 抽取 posSet / overlaps / pickDistractors，避免测试与实现漂移。
// （踩过的坑：测试里手抄了一份实现，两边各自演化，结果测试通过但线上同根率仍是 0.20%。）
const appSrc = fs.readFileSync(path.join(ROOT, "frontend", "app.js"), "utf8");
function extractFn(src, name) {
  const sig = `function ${name}(`;
  const i = src.indexOf(sig);
  assert.ok(i >= 0, `app.js 中找不到 ${name}`);
  let depth = 0, k = src.indexOf("{", i);
  const open = k;
  for (; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, `${name} 花括号不配平`);
  return src.slice(i, k + 1);
}
// eslint-disable-next-line no-new-func
const impl = new Function(
  "S",
  extractFn(appSrc, "posSet") + "\n" +
  extractFn(appSrc, "overlaps") + "\n" +
  extractFn(appSrc, "pickDistractors") +
  "\nreturn { posSet, overlaps, pickDistractors };"
)(S);
const { posSet, pickDistractors } = impl;

console.log("干扰项选取测试");
console.log("=".repeat(72));

let failed = 0;
const bad = (m) => { failed++; console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);

// ---------- 1) 索引自身的一致性 ----------
console.log("\n索引一致性");
{
  let dangling = 0, dupCluster = 0;
  for (const [, words] of Object.entries(index.clusters || {})) {
    const seen = new Set();
    for (const w of words) {
      if (!S.vmap[w]) dangling++;
      if (seen.has(w)) dupCluster++;
      seen.add(w);
    }
  }
  dangling === 0 ? ok(`簇内无悬空词条（${Object.keys(index.clusters).length} 簇）`) : bad(`${dangling} 个簇内词条不在词库中`);
  dupCluster === 0 ? ok("簇内无重复词条") : bad(`${dupCluster} 处簇内重复`);

  let synDangling = 0;
  for (const g of index.synGroups || []) for (const w of g) if (!S.vmap[w]) synDangling++;
  synDangling === 0 ? ok(`同义组内无悬空词条（${index.synGroups.length} 组）`) : bad(`${synDangling} 个同义组词条不在词库中`);
}

// ---------- 2) 全量抽样：绝不能有两个正确答案 ----------
console.log("\n全量抽样（每个词各出 1 次题，检查硬约束）");
{
  let twoCorrect = 0, dupText = 0, tooFew = 0, selfPicked = 0, total = 0;
  for (const word of S.vocab) {
    if (!word.meaning) continue;
    total++;
    const correct = word.meaning;
    const dist = pickDistractors(word, 3);
    if (dist.length < 3) { tooFew++; continue; }
    if (dist.some((d) => d.word === word.word)) selfPicked++;
    // 同义组检查：任何干扰项都不该与正确答案释义等价
    const sid = S.synIdOf.get(word.word);
    if (sid !== undefined) for (const d of dist) if (S.synIdOf.get(d.word) === sid) twoCorrect++;
    // 释义文本重复检查
    const texts = new Set([correct, ...dist.map((d) => d.meaning)]);
    if (texts.size !== 4) dupText++;
  }
  twoCorrect === 0 ? ok(`无「两个正确答案」情形（检查 ${total} 词）`) : bad(`${twoCorrect} 处：干扰项与正确答案同义组`);
  dupText === 0 ? ok("释义文本无重复") : bad(`${dupText} 处释义文本重复`);
  tooFew === 0 ? ok("每个词都能凑齐 3 个干扰项") : bad(`${tooFew} 个词凑不齐干扰项`);
  selfPicked === 0 ? ok("干扰项不含正确答案自身") : bad(`${selfPicked} 处把目标词选成了干扰项`);
}

// ---------- 3) 同词根比例：核心指标 ----------
// 正确基准是「簇覆盖率」而非固定阈值：只有落在簇里的词才可能抽到同根干扰项，
// 簇外词（占多数）永远抽不到。所以 37.5% 就是理论上限，用 >50% 判定会永远失败。
console.log("\n同词根干扰项比例（改动前实测 0.20%）");
{
  const inCluster = new Set();
  for (const ws of Object.values(index.clusters || {})) for (const w of ws) inCluster.add(w);
  const ceiling = (100 * inCluster.size) / S.vocab.length;

  let sameCluster = 0, N = 4000;
  for (let i = 0; i < N; i++) {
    const word = S.vocab[rand(S.vocab.length)];
    if (!word.meaning) continue;
    const key = word.word.slice(0, 4);
    const dist = pickDistractors(word, 3);
    if (dist.some((d) => d.word.slice(0, 4) === key)) sameCluster++;
  }
  const pct = (100 * sameCluster) / N;
  const ratio = pct / ceiling;
  console.log(`  簇覆盖率（理论上限）= ${ceiling.toFixed(1)}%`);
  ratio >= 0.95
    ? ok(`实测 ${pct.toFixed(1)}%，达理论上限的 ${(100 * ratio).toFixed(0)}%（改动前 0.20%）`)
    : bad(`实测 ${pct.toFixed(1)}%，仅为理论上限的 ${(100 * ratio).toFixed(0)}%`);
}

// ---------- 4) 同词性比例 ----------
// 判定用「拆分后的集合重叠」，与实现一致。不能用原始字符串比：
// 词库存的是「vt. / vi. / n.」这类复合串，字符串相等会严重低估。
console.log("\n同词性干扰项比例（pos 拆分后 16 个桶）");
{
  let samePos = 0, N = 4000;
  for (let i = 0; i < N; i++) {
    const word = S.vocab[rand(S.vocab.length)];
    if (!word.meaning) continue;
    const dist = pickDistractors(word, 3);
    if (dist.length && dist.every((d) => impl.overlaps(posSet(d.pos), posSet(word.pos)))) samePos++;
  }
  const pct = (100 * samePos) / N;
  // 不能要求 100%：L2 层（同簇、不限词性）按设计就会引入异词性干扰项 ——
  // comp* 簇里 compare(vt)/comparative(adj)/comparison(n) 互为干扰正是辨析训练的价值。
  // 实测簇内有 59.1% 的词同词性兄弟不足 3 个，必须靠 L2 补齐。
  // 改动前全库随机时同词性约 25%（随机命中），故 80% 已是显著提升。
  pct >= 80 ? ok(`三个干扰项与答案同词性 ${pct.toFixed(1)}%（改动前随机命中约 25%）`)
            : bad(`同词性仅 ${pct.toFixed(1)}%，未达预期`);
}

// ---------- 5) 边界：索引未加载时应优雅降级 ----------
console.log("\n索引缺失时的降级");
{
  const backup = { c: S.clusterOf, s: S.synIdOf, p: S.byPos };
  S.clusterOf = new Map(); S.synIdOf = new Map(); S.byPos = new Map();
  let broken = 0;
  for (const word of S.vocab.slice(0, 500)) {
    if (!word.meaning) continue;
    const dist = pickDistractors(word, 3);
    if (dist.length < 3) broken++;
    if (dist.some((d) => d.word === word.word)) broken++;
  }
  broken === 0 ? ok("索引为空时仍能正常出题（退化为全库随机）") : bad(`降级路径有 ${broken} 处异常`);
  S.clusterOf = backup.c; S.synIdOf = backup.s; S.byPos = backup.p;
}

// ---------- 6) 具体示例：肉眼可验 ----------
console.log("\n示例（comp* 词族）");
{
  for (const w of ["compete", "competent", "competition", "compel"]) {
    const o = S.vmap[w];
    if (!o) continue;
    const dist = pickDistractors(o, 3);
    console.log(`  Q: ${w}  (${o.pos})  → ${o.meaning}`);
    for (const d of dist) {
      const same = d.word.slice(0, 4) === w.slice(0, 4) ? "同根" : "    ";
      const samep = d.pos === o.pos ? "同词性" : "      ";
      console.log(`     - ${d.word.padEnd(16)} ${d.meaning.slice(0, 34).padEnd(36)} [${same} ${samep}]`);
    }
  }
}

console.log("\n" + "=".repeat(72));
console.log(failed === 0 ? "全部通过 ✓" : `失败 ${failed} 项 ✗`);
process.exit(failed === 0 ? 0 : 1);
