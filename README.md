# 单词书 · 联网版

一个**多设备云同步**的背单词网页应用：原生 HTML/CSS/JS 单页前端 + 腾讯云 CloudBase 云函数后端 + PostgreSQL，全部跑在 CloudBase 低成本套餐上，无需自建服务器。

> 📄 **完整技术方案与实现分析**见 [docs/技术方案与实现分析.md](docs/技术方案与实现分析.md)（架构、同步引擎、调度器演进、踩坑实录、优化与演进规划）。

内置 **4356 个考研英语词汇**（2027 红宝书词表），支持卡片/四选一两种刷题模式、SM-2 间隔重复、错题本、熟词标记、每日目标与学习统计图表。

## 功能

- **多设备同步**：手机 / 电脑登录同一账号，答题进度实时同步；断网时本地缓存，恢复后自动补传（`op_id` 幂等去重 + 状态 LWW 合并）
- **刷题模式**：四选一（一行一个选项，含词性 + 主释义）与卡片翻面（完整词性释义），数字键 1-4 快捷作答
- **刷一轮 + 错题复习制**：答对即掌握（本轮不再出现），答错进入错题本次日复习、连对 3 次毕业——适合有词汇基础、快速过一轮巩固错点的学习者
- **错题本体系**：答错自动进错题本，连对 3 次毕业；曾错本、熟词（☆ 标记不再出现）均支持手动移除；错题本/曾错本按最近答错时间倒序
- **每日打卡**：每日新词目标、今日进度条、昨日完成情况、连续达标天数与鼓励语
- **统计图表**：最近 7 天答题量、每日正确率、每日新词、累计正确率环形图（纯 CSS/SVG，无图表库）
- **账户**：开放注册，PBKDF2 密码哈希 + HMAC 会话签名，支持恢复码找回密码
- **词库**：搜索 + 按掌握度筛选，每个词可查看刷题次数（对/错）

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML / CSS / JS SPA（无框架、无构建） |
| 后端 | CloudBase HTTP 云函数（Node.js 20 + Express），通过 PostgREST 访问数据库 |
| 数据库 | CloudBase PostgreSQL |
| 词库 | `frontend/vocab.json` 静态下发（4356 词） |

```
├── api/                  # 后端云函数源码（认证 / SM-2 / 同步 / 统计 API）
├── frontend/             # 前端 SPA（部署到 CloudBase 静态网站托管）
│   ├── index.html
│   ├── styles.css
│   ├── app.js            # API_BASE 需替换为你的网关域名
│   └── vocab.json        # 词库
├── database/schema.sql   # PostgreSQL 建表脚本
├── cloudbaserc.json      # 云函数部署配置（需填入你的环境 ID 与密钥占位符）
└── deploy.bat            # Windows 一键部署脚本
```

## 部署步骤（约 30 分钟）

前提：一个腾讯云账号，开通 [CloudBase 云开发](https://tcb.cloud.tencent.com/) 并**新建环境**（建议上海区；环境需包含 PostgreSQL，新环境默认自带）。

1. **建表**：控制台 → 数据库 → SQL 编辑器，粘贴 `database/schema.sql` 并执行。
2. **改配置**（共 3 处占位符）：
   - `cloudbaserc.json`：`envId` 改为你的环境 ID；`JWT_SECRET` 改为随机长字符串；`RECOVERY_KEY` 改为你的找回密码恢复码
   - `deploy.bat`：顶部 `ENV_ID` 改为你的环境 ID
   - `frontend/app.js`：`API_BASE` 改为 `https://<你的环境ID>.ap-shanghai.app.tcloudbase.com`（环境 ID 需带腾讯云 AppID 后缀，格式如 `xxx-100012345678`，控制台环境面板可见）
3. **登录 CLI**：命令行运行 `npx @cloudbase/cli@latest login`（浏览器授权一次）。
4. **部署**：双击 `deploy.bat`（或手动执行：
   `tcb fn deploy api --force --httpFn` 部署后端；
   `tcb hosting deploy frontend -e <环境ID> --verify` 发布前端）。
5. **访问**：控制台「静态网站托管 → 默认域名」即为网页地址；打开注册账号即可使用。

> 首次部署 `fn deploy --httpFn` 会创建 HTTP 云函数并自动开通 HTTP 访问服务；函数类型创建后不可更改。若需自定义域名，需已完成 ICP 备案。

## 配置项说明

| 配置 | 位置 | 说明 |
|---|---|---|
| `envId` / `ENV_ID` | `cloudbaserc.json` / `deploy.bat` | 你的 CloudBase 环境 ID |
| `API_BASE` | `frontend/app.js` | 云函数 HTTP 网关域名 |
| `JWT_SECRET` | `cloudbaserc.json` → envVariables | 会话签名密钥，务必使用随机长字符串 |
| `RECOVERY_KEY` | `cloudbaserc.json` → envVariables | 忘记密码的恢复码，请自行妥善保管 |

> ⚠️ 不要把真实密钥提交到公开仓库：本地开发时可用 `git update-index --skip-worktree cloudbaserc.json` 或维护私有分支。

## 词库数据说明

`frontend/vocab.json`（4356 词）整理自开源项目 [2027-kaoyan-english-redbook-json](https://github.com/3056810551/2027-kaoyan-english-redbook-json)（MIT），原始数据来自网络流传的《2027 考研英语红宝书》PDF，版权归原作者/出版社所有。**仅供学习交流使用，请勿用于商业用途。**

## License

代码部分以 [MIT](LICENSE) 协议开源；词库数据版权归原出版社，随项目分发仅作学习用途。
