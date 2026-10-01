#!/usr/bin/env node
/**
 * 把仓库版 frontend/ 同步到部署工作副本 wordbook-web/frontend/，
 * 并自动注入部署专属的配置值。
 *
 * 存在的原因：公开仓库的 app.js 里 API_BASE 是占位符（YOUR_ENV_ID），
 * 而部署副本需要真实网关域名。手工复制会漏掉这步 —— 2026-10-01 就因此
 * 把 YOUR_ENV_ID 部署上线，登录直接 "Failed to fetch"。
 *
 * 用法：
 *   node scripts/sync-deploy.js            # 同步并校验
 *   node scripts/sync-deploy.js --check    # 只校验部署副本是否就绪
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// ---- 部署配置：真实值只存在这里，不进仓库 ----
const DEPLOY = {
  apiBase:
    "https://wordbook-d4g7p7uv6317b6ba8-1476839156.ap-shanghai.app.tcloudbase.com",
  envId: "wordbook-d4g7p7uv6317b6ba8",
};

const SRC = path.join(ROOT, "frontend");
const DST = process.env.WORDBOOK_DEPLOY_DIR ||
  "D:\\单词书\\单词书\\单词书\\wordbook-web\\frontend";

const FILES = ["app.js", "index.html", "styles.css", "vocab.json", "vocab-index.json"];

function injectApiBase(code) {
  // 替换整行，保留行尾注释风格
  return code.replace(
    /const API_BASE = "[^"]*";[^\n]*/,
    `const API_BASE = "${DEPLOY.apiBase}"; // 由 scripts/sync-deploy.js 注入，勿手工改`
  );
}

function validate(code, label) {
  const m = code.match(/const API_BASE = "([^"]*)"/);
  if (!m) return [`${label}: 找不到 API_BASE`];
  const url = m[1];
  const errs = [];
  if (!url) errs.push(`${label}: API_BASE 为空`);
  else if (url.includes("YOUR_ENV_ID")) {
    errs.push(`${label}: API_BASE 仍是占位符 YOUR_ENV_ID —— 部署后登录会 Failed to fetch`);
  } else if (!url.startsWith("https://")) {
    errs.push(`${label}: API_BASE 不是 https`);
  } else if (!url.includes(DEPLOY.envId)) {
    errs.push(`${label}: API_BASE 不含环境 ID ${DEPLOY.envId}，疑似指向别的环境`);
  }
  if (url && !url.endsWith("/api/health")) { /* 正常，health 只是探活路径 */ }
  // 反向校验：不能指向静态托管域名（那是前端自己，会形成回环）
  if (url && url.includes("tcloudbaseapp.com")) {
    errs.push(`${label}: API_BASE 指向了静态托管域名而非 API 网关`);
  }
  return errs;
}

const checkOnly = process.argv.includes("--check");

if (!fs.existsSync(DST)) {
  console.error(`部署目录不存在：${DST}`);
  console.error("请设置环境变量 WORDBOOK_DEPLOY_DIR 指向你的部署工作副本。");
  process.exit(1);
}

if (checkOnly) {
  const target = path.join(DST, "app.js");
  if (!fs.existsSync(target)) {
    console.error(`未找到 ${target}`);
    process.exit(1);
  }
  const errs = validate(fs.readFileSync(target, "utf8"), "部署副本");
  if (errs.length) {
    console.error("部署副本未就绪：");
    for (const e of errs) console.error("  ✗ " + e);
    process.exit(1);
  }
  console.log("✓ 部署副本配置正确");
  process.exit(0);
}

// ---- 同步 ----
const problems = [];
for (const f of FILES) {
  const src = path.join(SRC, f);
  if (!fs.existsSync(src)) { console.log(`  跳过 ${f}（仓库中没有）`); continue; }
  let code = fs.readFileSync(src, "utf8");
  if (f === "app.js") {
    code = injectApiBase(code);
    problems.push(...validate(code, "注入后的 app.js"));
  }
  fs.writeFileSync(path.join(DST, f), code, "utf8");
  console.log(`  ✓ ${f.padEnd(18)} ${(Buffer.byteLength(code) / 1024).toFixed(1)} KB`);
}

// ---- 同步后自检：读回磁盘确认 ----
const readBack = fs.readFileSync(path.join(DST, "app.js"), "utf8");
problems.push(...validate(readBack, "磁盘回读"));

if (problems.length) {
  console.error("\n同步完成但校验未通过：");
  for (const p of problems) console.error("  ✗ " + p);
  console.error("\n不要部署。");
  process.exit(1);
}

console.log(`\n✓ ${FILES.length} 个文件已同步到 ${DST}`);
console.log(`✓ API_BASE 已注入为 ${DEPLOY.apiBase}`);
console.log("\n下一步：node scripts/sync-deploy.js --check  再确认一次，然后才部署");
