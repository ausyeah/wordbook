#!/usr/bin/env node
/**
 * 生成 frontend/vocab-index.json —— 同词根干扰项所需的离线索引。
 *
 * 背景：四选一目前从全库随机抽 3 个干扰项，实测同词根词出现的比例仅 0.20%。
 * 而考研最容易混的正是形近词（comp* 40 词、cons* 29 词、inte* 30 词），
 * 现在的题目几乎从不把它们放在一起，辨析能力从未被考察。
 *
 * 产出三张表：
 *   clusters  4 字母前缀簇 —— 优先作为干扰项来源（比 5 字母覆盖高 2 倍）
 *   synGroups 释义归一后完全相同的词组 —— 必须从干扰项池排除，
 *            否则会出现两个正确答案（obvious/evident 均为"明显的"）
 *   byPos     词性桶 —— 兜底层，保证干扰项与正确答案词性一致
 *
 * 只读 vocab.json，不修改它（那是上游 MIT 数据源，应保持原样）。
 *
 * 运行：node scripts/build-vocab-index.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "frontend", "vocab.json");
const OUT = path.join(ROOT, "frontend", "vocab-index.json");

const MIN_CLUSTER = 3;   // 簇内至少 3 词（含目标自身）才值得作为干扰项池
const MIN_WORD_LEN = 5;  // 短于此的词不查簇，避免 4 字母功能词误聚

const vocab = JSON.parse(fs.readFileSync(SRC, "utf8"));
const words = vocab.words;
console.log(`读取 ${words.length} 词（来源：${vocab.meta.source}）`);

// ---------- 1. 同义组：释义归一后相同 ----------
// 归一化：去空白、全角转半角、去尾部标点、压小写。
// 只处理"归一后完全相同"，不做语义近似——后者需要语义模型，而本项目约束是零外部依赖。
const norm = (s) =>
  String(s == null ? "" : s)
    .replace(/[（）()\s、，,；;。.．·:：]/g, "")
    .toLowerCase();

const byMeaning = new Map();
for (const w of words) {
  const k = norm(w.meaning);
  if (!k) continue;
  if (!byMeaning.has(k)) byMeaning.set(k, []);
  byMeaning.get(k).push(w.word);
}

const synGroups = [];
const synIdOf = new Map();
for (const group of byMeaning.values()) {
  if (group.length < 2) continue;
  const id = synGroups.length;      // 0 表示该词无同义词（-1）
  synGroups.push(group);
  for (const word of group) synIdOf.set(word, id);
}
console.log(`同义组：${synGroups.length} 组，涉及 ${synIdOf.size} 词`);

// ---------- 2. 词根簇：4 字母前缀 ----------
// 实测取舍：
//   3 字母 → 覆盖 75.6%，但 over*/under* 这类会把语义无关的词聚在一起
//   4 字母 → 覆盖 37.5%，comp*/cons*/inte* 等真实词族完整
//   5 字母 → 覆盖仅 16.3%，comp* 会被拆得太碎，compel/compete/competent 反而不同簇
// 取 4 字母；过度聚类（companion/company 混进 comp*）由"同 pos 优先"在运行时消解。
const clusters = {};
for (const w of words) {
  if (w.word.length < MIN_WORD_LEN) continue;
  const key = w.word.slice(0, 4);
  (clusters[key] || (clusters[key] = [])).push(w.word);
}
const keptClusters = Object.fromEntries(
  Object.entries(clusters).filter(([, v]) => v.length >= MIN_CLUSTER)
);
const covered = Object.values(keptClusters).reduce((n, v) => n + v.length, 0);
console.log(
  `词根簇：${Object.keys(keptClusters).length} 个（≥${MIN_CLUSTER} 词），覆盖 ${covered} 词 ` +
  `(${((covered / words.length) * 100).toFixed(1)}%)`
);

// ---------- 3. 词性桶 ----------
// pos 字段 4356/4356 全填充，但存的是「vt. / vi. / n.」这类复合串：
// 直接当桶名会得到 142 个桶、其中 114 个只有 1 个词（实测），L3 几乎必然降级。
// 拆成单一词性后降到 16 个桶、仅 6 个不足 10 词。
// 同时保留 firstPos（主词性，即第一个），供"词性完全一致"的严格场景使用。
const posParts = (p) =>
  String(p == null ? "" : p)
    .split(/[/／]/)
    .map((s) => s.trim().replace(/\.$/, "").trim())
    .filter((s) => /^[a-zA-Z]+$/.test(s));

const byPos = {};
const byFirstPos = {};
for (const w of words) {
  const parts = posParts(w.pos);
  // 复合词性的词进每一个分桶：vt./vi. 的词既算 vt 也算 vi
  for (const p of parts.length ? parts : ["x"]) (byPos[p] || (byPos[p] = [])).push(w.word);
  const first = parts.length ? parts[0] : "x";
  (byFirstPos[first] || (byFirstPos[first] = [])).push(w.word);
}
const thin = Object.entries(byPos).filter(([, v]) => v.length < 10);
console.log(
  `词性桶：${Object.keys(byPos).length} 个（拆分后），其中 ${thin.length} 个不足 10 词` +
  `${thin.length ? "：" + thin.map(([k, v]) => `${k}(${v.length})`).join(" ") : ""}`
);

// ---------- 4. 自检：同义组内是否有簇冲突 ----------
// 若某个同义组横跨多个簇，说明干扰项冲突可能被"同簇优先"绕过，需要人工看一眼。
const spread = synGroups.filter((g) => {
  const keys = new Set(g.filter((w) => w.length >= MIN_WORD_LEN).map((w) => w.slice(0, 4)));
  return keys.size > 1;
});
if (spread.length) {
  console.log(`\n⚠ ${spread.length} 个同义组横跨多个词根簇（需人工确认是否真同义）:`);
  for (const g of spread.slice(0, 8)) {
    console.log(`   ${g.join(" / ")}`);
    for (const w of g) {
      const o = words.find((x) => x.word === w);
      console.log(`      ${w.padEnd(16)} ${o.meaning}`);
    }
  }
}

// ---------- 5. 输出 ----------
const index = { version: 1, clusters: keptClusters, synGroups, byPos, byFirstPos };
fs.writeFileSync(OUT, JSON.stringify(index), "utf8");
const outBytes = fs.statSync(OUT).size;
const srcBytes = fs.statSync(SRC).size;
console.log(`\n已写入 ${path.relative(ROOT, OUT)}`);
console.log(
  `大小：${(outBytes / 1024).toFixed(1)} KB` +
  `（vocab.json 为 ${(srcBytes / 1024).toFixed(1)} KB，增加 ${((100 * outBytes) / srcBytes).toFixed(1)}%）`
);
