<div align="center">

# 单词书 · 联网版

### 4356 个考研词，一张表记住你在哪台设备上错到第几次。

多设备云同步的背单词 Web 应用。原生 HTML/CSS/JS 单页前端 + 腾讯云 CloudBase 云函数后端 + PostgreSQL，
**全栈手写代码约 2000 行，零前端框架、零构建步骤、零自建服务器**，基础设施成本约 ¥0/月。

[![License](https://img.shields.io/badge/license-MIT%20%2B%20%E6%95%B0%E6%8D%AE%E7%AD%8A%E5%90%8D-0078D4)](LICENSE)
[![词库](https://img.shields.io/badge/vocab-4356%20words-0078D4)](frontend/vocab.json)
[![Stack](https://img.shields.io/badge/frontend-vanilla%20JS-0078D4)]()

[功能](#功能) · [架构](#架构) · [同步引擎](#核心设计多设备同步引擎) · [部署](#部署) · [技术文档](docs/技术方案与实现分析.md)

</div>

---

## 为什么做这个

现成的背单词 App 有两个常见问题：

**一是进度锁在一台设备里。** 手机上背的单词，电脑打开就是空的；换设备等于从零开始。

**二是一线通吃。** 早上过一遍新词，晚上想只复习昨天错的——多数工具只能全量重来。

这个项目针对的是**已有词汇基础、想快速过一轮 + 强化错点**的场景（典型是考研冲刺期）：
答对的词立刻退出本轮，只有**错题**会在次日零点重新排队。连对 3 次才算毕业。

## 功能

| | |
|---|---|
| **多设备同步** | 手机 / 电脑登录同一账号，答题进度实时同步；断网时本地缓存，恢复后自动补传 |
| **两种刷题模式** | 四选一（一行一选项，含词性 + 主释义）/ 卡片翻面（完整词性释义），数字键 `1`–`4` 快捷作答 |
| **刷一轮 + 错题复习** | 答对即退出本轮；答错进错题本，次日 0 点（东八区）必回队列，连对 3 次毕业 |
| **错题本体系** | 错题本 / 曾错本双层记录，按最近答错时间倒序；熟词 ☆ 标记不再出现，均支持手动移除 |
| **每日打卡** | 每日新词目标、今日进度条、昨日完成情况、连续达标天数 |
| **统计图表** | 近 7 天答题量、每日正确率、每日新词、累计正确率环形图——纯 CSS/SVG，**无图表库** |
| **账户** | 开放注册，PBKDF2 密码哈希 + HMAC 会话签名，支持恢复码找回 |
| **词库** | 4356 词，支持搜索与按掌握度筛选，可查看每个词的刷题次数（对 / 错） |

## 架构

```
┌─────────────────────────────┐      ┌──────────────────────────────┐
│  前端 SPA（静态托管）          │      │  CloudBase HTTP 云函数        │
│  原生 HTML/CSS/JS，零依赖      │─────▶│  Node.js 20 + Express        │
│  · 渲染 / 路由 / 离线 outbox  │ HTTPS │  · PBKDF2 + HMAC 会话认证     │
│  · localStorage 持久化        │◀───── │  · 同步引擎（幂等 + LWW）      │
│  · CSS/SVG 图表               │  JSON │  · SRS 调度 / 错题本 / 统计   │
└─────────────────────────────┘      └──────────────┬───────────────┘
   index.html / styles.css                PostgREST  │
   app.js / vocab.json (4356 词)                    ▼
                                    ┌──────────────────────────────┐
                                    │  CloudBase PostgreSQL         │
                                    │  users / word_state (19 列)   │
                                    │  review_log / settings        │
                                    └──────────────────────────────┘
```

三个架构决策：

- **词库不入库。** 4356 词作为静态 JSON 由 CDN 下发，数据库只存学习状态（每用户 ≤ 数千行），把数据库压力和流量成本降到最低。
- **前后端同仓同部署。** 一次 `deploy.bat` 同时完成云函数更新与静态托管发布。
- **云函数 = Web Server。** Express 监听 9000 端口，由 `scf_bootstrap` 拉起，网关按路径透传，保留了向自建服务器迁移的代码兼容性。

## 核心设计：多设备同步引擎

这是项目里工程含量最高的子系统。

### 1. 写操作建模：op 流水 + 幂等去重

客户端不直接写状态，而是生成操作流水：

```json
{ "type": "answer", "word": "radiate", "rating": 5,
  "occurred_at": 1787983280892, "op_id": "dev_x7k2:1787983280892:k3fmq1" }
```

`op_id = 设备ID + 时间戳 + 随机串`，`review_log` 以 `(user_id, op_id)` 为主键。后端先查 `reviewExists(op_id)`：
已存在则跳过但**返回当前权威状态**。

> **幂等性由数据库唯一约束兜底，而不是依赖客户端"记得自己发过什么"。**
> 同一批操作重放任意次，结果都一致。

### 2. 状态合并：LWW + 版本号

状态类操作走最后写入胜（LWW），辅以单调递增的 `rev`：

- 后端仅当 `op.updated_at > 当前行 updated_at` 才应用；
- 应用时 `rev = cur.rev + 1`，保留完整审计线索；
- 响应把被触碰的行（`touched`）回传，客户端按 `updated_at` 与本地择新合并。

### 3. 为什么不用 CRDT / 向量时钟

这是**单人使用**的工具，同一单词被两台设备在同一毫秒内写走的概率趋近于零，
LWW + 幂等已经 100% 满足正确性。

> 把分布式协调的复杂度花在真实需求上，而不是花在想象出的需求上——这是本项目最重要的工程取舍。
> 完整论证见 [技术文档](docs/技术方案与实现分析.md)。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML / CSS / JS SPA（无框架、无构建、无 npm） |
| 后端 | CloudBase HTTP 云函数（Node.js 20 + Express），经 PostgREST 访问数据库 |
| 数据库 | CloudBase PostgreSQL（4 张表，`word_state` 19 列） |
| 认证 | PBKDF2（10 万轮）+ HMAC-SHA256 自签会话 |
| 词库 | `frontend/vocab.json` 静态下发（4356 词 / 907 KB） |

## 项目结构

```
├── api/                  # 后端云函数（认证 / SM-2 调度 / 同步 / 统计）
│   ├── index.js          # 9 个 REST 端点
│   └── scf_bootstrap     # 云函数启动引导
├── frontend/             # 前端 SPA（部署到静态网站托管）
│   ├── index.html
│   ├── styles.css
│   ├── app.js            # 渲染 / 路由 / 离线 outbox / SRS 镜像，API_BASE 需替换
│   └── vocab.json        # 4356 词
├── database/schema.sql   # PostgreSQL 建表脚本（可重复执行）
├── cloudbaserc.json      # 云函数配置（需填环境 ID 与密钥）
├── deploy.bat            # Windows 一键部署
└── docs/                 # 完整技术方案与实现分析
```

## 部署

约 30 分钟。前提：一个腾讯云账号，开通 [CloudBase 云开发](https://tcb.cloud.tencent.com/) 并**新建环境**
（建议上海区，新环境默认自带 PostgreSQL）。

1. **建表** —— 控制台 → 数据库 → SQL 编辑器，粘贴 `database/schema.sql` 并执行。
2. **改配置**（3 处占位符）：
   - `cloudbaserc.json`：`envId` 改成你的环境 ID；`JWT_SECRET` 改成随机长字符串；`RECOVERY_KEY` 改成你的恢复码
   - `deploy.bat`：顶部 `ENV_ID` 改成你的环境 ID
   - `frontend/app.js`：`API_BASE` 改成 `https://<你的环境ID>.ap-shanghai.app.tcloudbase.com`
3. **登录 CLI** —— 运行 `npx @cloudbase/cli@latest login`（浏览器授权一次）。
4. **部署** —— 双击 `deploy.bat`，或手动执行：
   ```bash
   tcb fn deploy api --force --httpFn              # 后端
   tcb hosting deploy frontend -e <环境ID> --verify # 前端
   ```
5. **访问** —— 控制台「静态网站托管 → 默认域名」即为网址，打开注册账号即可使用。

> 首次 `fn deploy --httpFn` 会创建 HTTP 云函数并自动开通 HTTP 访问服务；**函数类型创建后不可更改**。
> 自定义域名需已完成 ICP 备案。

### 配置项

| 配置 | 位置 | 说明 |
|---|---|---|
| `envId` / `ENV_ID` | `cloudbaserc.json` / `deploy.bat` | 你的 CloudBase 环境 ID |
| `API_BASE` | `frontend/app.js` | 云函数 HTTP 网关域名 |
| `JWT_SECRET` | `cloudbaserc.json` → `envVariables` | 会话签名密钥，务必用随机长字符串 |
| `RECOVERY_KEY` | `cloudbaserc.json` → `envVariables` | 忘记密码的恢复码，请自行妥善保管 |

> ⚠️ **不要把真实密钥提交到公开仓库。** 本地开发可用
> `git update-index --skip-worktree cloudbaserc.json`，或维护私有分支。

## 项目规模

| 指标 | 数值 |
|---|---|
| 手写代码 | 约 2000 行（前端 1547 + 后端 440，不含词库与锁文件） |
| 词库 | 4356 词 / 907 KB |
| 后端 API | 9 个 REST 端点 |
| 数据模型 | 4 张表，`word_state` 19 列 |
| 基础设施成本 | CloudBase 体验版 ≈ ¥0/月 |

## 演进历史

| 阶段 | 形态 | 为什么换 |
|---|---|---|
| v0 | 本地单机版（Python Tkinter） | 无同步、无移动端 |
| v1 | Cloudflare Workers 全栈 | 国内不可达（`workers.dev` 被阻断，POST 请求体被中间层吞掉） |
| **v2（当前）** | **腾讯云 CloudBase 全栈** | 稳定可用 |

产品定位也在使用中完成了一次校准：从"给初学者的 SM-2 工具"调整为
"**面向有词汇基础用户的快速刷一轮 + 错题强化工具**"。这个演变直接驱动了复习调度器的重写与一次存量数据迁移。

## 词库数据说明

`frontend/vocab.json`（4356 词）整理自开源项目
[2027-kaoyan-english-redbook-json](https://github.com/3056810551/2027-kaoyan-english-redbook-json)（MIT），
原始数据来自网络流传的《2027 考研英语红宝书》PDF，**版权归原作者 / 出版社所有**。

**仅供学习交流使用，请勿用于商业用途。**

## License

代码部分以 [MIT](LICENSE) 协议开源；词库数据版权归原出版社，随项目分发仅作学习用途。

---

> 📄 面向汇报与求职的完整技术文档（架构决策、调度器演进、踩坑实录、性能优化与后续规划）见
> **[docs/技术方案与实现分析.md](docs/技术方案与实现分析.md)**。
