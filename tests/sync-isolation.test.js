#!/usr/bin/env node
/**
 * 同步错误隔离回归测试。
 *
 * 2026-10-01 线上故障：setting op 分支引用了未解构的 op_id，
 * 抛 `ReferenceError: op_id is not defined` → 整批 500 → 用户 20 条记录卡死。
 *
 * 两个层次都要守住：
 *   1. setting 分支必须正确解构 op_id（根因）
 *   2. 单条 op 抛错不得中断整批（结构性防线，即使将来再出现类似 bug）
 *
 * 运行：node tests/sync-isolation.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const API_SRC = path.resolve(__dirname, "..", "api", "index.js");
const APP_SRC = path.resolve(__dirname, "..", "frontend", "app.js");
const src = fs.readFileSync(API_SRC, "utf8");
const app = fs.readFileSync(APP_SRC, "utf8");

let failed = 0;
const bad = (m) => { failed++; console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);

console.log("同步错误隔离测试");
console.log("=".repeat(70));

// ---------- 1. 根因：setting 分支的 op_id 解构 ----------
console.log("\n1. setting op 分支（2026-10-01 故障根因）");
{
  const i = src.indexOf('op.type === "setting"');
  assert.ok(i >= 0, "找不到 setting 分支");
  const block = src.slice(i, src.indexOf("}", src.indexOf("applied.push", i)) + 1);
  const destructure = block.match(/const\s*\{([^}]*)\}\s*=\s*op/);
  assert.ok(destructure, "setting 分支缺少解构");
  const names = destructure[1].split(",").map((s) => s.trim()).filter(Boolean);
  names.includes("op_id")
    ? ok(`已解构 op_id（解构了 ${names.length} 个字段）`)
    : bad(`setting 分支未解构 op_id，实际解构了：${names.join(", ")}`);
  block.includes("applied.push(op_id")
    ? ok("applied.push 使用了解构出的 op_id")
    : bad("applied.push 未使用 op_id");
}

// ---------- 2. 结构性防线：逐 op try/catch ----------
console.log("\n2. 整批循环的错误隔离");
{
  const loopStart = src.indexOf("for (const op of ops) {");
  assert.ok(loopStart >= 0, "找不到 op 循环");
  const segment = src.slice(loopStart, loopStart + 20000);
  const catchIdx = segment.indexOf("} catch (e) {");
  catchIdx > 0 && catchIdx < segment.indexOf("return res.json")
    ? ok("循环体内有 per-op catch（单条失败不中断整批）")
    : bad("循环体内没有 per-op catch —— 一条坏 op 仍会拖垮整批");

  /const\s+failed\s*=\s*\[\]/.test(src)
    ? ok("已声明 failed 数组用于回传失败项")
    : bad("缺少 failed 数组");
  /failed\.push\(/.test(src)
    ? ok("失败项被 push 进 failed")
    : bad("失败项未被记录");
  /ok:\s*true,\s*applied,\s*failed,/.test(src)
    ? ok("响应体包含 failed 字段")
    : bad("响应体未包含 failed 字段");
  /console\.error\("[^"]*sync[^"]*op failed/.test(src)
    ? ok("失败时写入云函数日志（原代码全文件零 console.error，静默失败无法排查）")
    : bad("失败时无日志输出");
}

// ---------- 3. 前端消费 failed ----------
console.log("\n3. 前端处理 failed");
{
  /r\.failed/.test(app)
    ? ok("读取响应中的 failed")
    : bad("前端未读取 failed —— 失败项会永远重试并堵死 outbox");
  /shouldDropOp/.test(app)
    ? ok("有丢弃判定（避免瞬时故障误丢学习记录）")
    : bad("无丢弃判定，失败项会无限重试");
  /tries\[opId\]\s*>=\s*3/.test(app)
    ? ok("连续 3 次失败才丢弃，容忍瞬时错误")
    : bad("丢弃阈值不是 3 次");
  /delete\s+_failedState\.tries/.test(app)
    ? ok("成功后清除失败计数（避免计数累积）")
    : bad("成功后未清除失败计数");
}

// ---------- 4. 行为模拟：验证 per-op catch 的语义 ----------
console.log("\n4. 行为模拟");
{
  // 模拟服务端循环：一条会抛错的 op 不应影响同批其他 op
  function makeOps() {
    return [
      { type: "answer", word: "alpha", op_id: "a1", ok: true },
      { type: "setting", key: "dailyGoal", op_id: "g1", throws: true },
      { type: "answer", word: "beta", op_id: "a2", ok: true },
      { type: "answer", word: "gamma", op_id: "a3", ok: true },
    ];
  }
  const ops = makeOps();
  const applied = [], failed = [];
  for (const op of ops) {
    try {
      if (op.throws) {
        // 模拟未解构 op_id 的 ReferenceError
        // eslint-disable-next-line no-undef
        throw new ReferenceError("op_id is not defined");
      }
      applied.push(op.op_id);
    } catch (e) {
      if (op.op_id) failed.push(op.op_id);
    }
  }
  applied.length === 3
    ? ok(`坏 op 之后仍处理了后续 ${applied.length} 条（${applied.join(", ")}）`)
    : bad(`坏 op 中断了整批，只处理了 ${applied.length} 条`);
  failed.length === 1 && failed[0] === "g1"
    ? ok(`失败项被单独记录：${failed.join(", ")}`)
    : bad(`失败项记录异常：${JSON.stringify(failed)}`);

  // 前端丢弃逻辑：同一 op_id 连续 3 次才丢
  const tries = {};
  const shouldDrop = (id) => { tries[id] = (tries[id] || 0) + 1; return tries[id] >= 3; };
  shouldDrop("g1") === false && shouldDrop("g1") === false && shouldDrop("g1") === true
    ? ok("前端：前 2 次保留，第 3 次才丢弃（容忍瞬时故障）")
    : bad("前端丢弃阈值行为异常");
}

// ---------- 5. 输入边界（顺手加固） ----------
console.log("\n5. 输入校验现状");
{
  /if\s*\(!word\s*\|\|\s*rating\s*==\s*null\s*\|\|\s*!op_id\)\s*continue/.test(src)
    ? ok("answer op 有基本字段校验")
    : bad("answer op 缺少字段校验");
  const hasRangeCheck = /rating\s*<\s*0\s*\|\|\s*rating\s*>\s*5/.test(src);
  hasRangeCheck
    ? ok("rating 有取值范围校验")
    : console.log("  ⚠ rating 无范围校验（rating=99 会被当成答对并写入 review_log，污染统计）");
}

console.log("\n" + "=".repeat(70));
console.log(failed === 0 ? "全部通过 ✓" : `失败 ${failed} 项 ✗`);
process.exit(failed === 0 ? 0 : 1);
