@echo off
chcp 65001 >nul
setlocal
REM ==================================================
REM  单词书联网版 · 一键部署（腾讯云 CloudBase）
REM  首次使用请先：
REM    1. 安装 Node.js 18+
REM    2. 修改本文件顶部的 ENV_ID 和 cloudbaserc.json 里的占位符
REM    3. 命令行运行  npx @cloudbase/cli@latest login  登录腾讯云账号
REM  之后改完代码，双击本文件即可重新部署
REM ==================================================

set "ENV_ID=YOUR_ENV_ID"

REM ---- 检查占位符是否已替换 ----
findstr /c:"YOUR_ENV_ID" "%~dp0cloudbaserc.json" >nul 2>nul
if not errorlevel 1 (
  echo [错误] 请先把 cloudbaserc.json 和本文件里的 YOUR_ENV_ID 替换为你的 CloudBase 环境 ID。
  pause
  exit /b 1
)

REM ---- 找 Node.js ----
where node >nul 2>nul
if %errorlevel%==0 goto node_ok
echo [错误] 未找到 Node.js，请先安装 Node.js 18+ 后重试。
pause
exit /b 1
:node_ok

REM ---- 找/装 CloudBase CLI ----
set "TCB_CLI=%LOCALAPPDATA%\tcb-cli\node_modules\.bin\tcb.cmd"
if exist "%TCB_CLI%" goto cli_ok
echo [0/2] 首次运行：安装 CloudBase CLI（约 1 分钟）...
if not exist "%LOCALAPPDATA%\tcb-cli" mkdir "%LOCALAPPDATA%\tcb-cli"
call npm install --prefix "%LOCALAPPDATA%\tcb-cli" @cloudbase/cli --no-audit --no-fund --loglevel=error
if not exist "%TCB_CLI%" (
  echo [错误] CLI 安装失败，请检查网络后重试。
  pause
  exit /b 1
)
:cli_ok

REM ---- 未登录则触发浏览器授权 ----
echo [1/2] 部署后端云函数 api ...
cd /d "%~dp0"
call "%TCB_CLI%" fn deploy api --force --httpFn
if errorlevel 1 goto fail

echo [2/2] 发布前端到静态网站托管 ...
call "%TCB_CLI%" hosting deploy frontend -e %ENV_ID% --verify
if errorlevel 1 goto fail

echo.
echo 完成！前端地址见 CloudBase 控制台「静态网站托管 → 默认域名」，
echo 并确认 frontend/app.js 里的 API_BASE 已替换为你的 HTTP 网关域名。
pause
exit /b 0

:fail
echo.
echo [错误] 部署失败，向上翻查看报错。首次运行若提示登录，请先执行：
echo        npx @cloudbase/cli@latest login
pause
exit /b 1
