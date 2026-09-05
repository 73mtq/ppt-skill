# AGENTS.md - ppt-skill 项目

## Windows / opencode bash 工具限制（重要，本项目已发生 2 次卡死）

opencode 的 bash 工具会等待命令**完全退出**。任何"保持运行"的命令都会永久卡死会话（子进程继承管道句柄导致 EOF 永远不来）。

### 禁止直接执行（会卡死会话）：

- 长驻服务：`npm run dev`、`npm run start`、`npm run preview`、`vite`、任何 dev server / watcher
- 常驻会话：`playwright-cli open <url>`、`playwright codegen`（浏览器会话保持打开）

### 正确做法：

**启动 dev server（如需本地预览）——必须用 WMI 创建进程（唯一彻底脱离的方式）：**
```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='cmd /c "cd /d D:\ppt-skill && npm run dev > dev.log 2>&1"'}
```
WMI 启动的进程父级是系统服务（WmiPrvSE.exe），与当前 shell 零句柄继承，bash 工具立即返回。

**为什么不能用 `cmd /c start` 或 `Start-Process`**：Windows 可继承句柄会沿 CreateProcess 链传递，bash 工具的管道写端仍会到达 node 进程；服务不退出工具就永远等不到 EOF（实测即使 shell 已退出仍卡死）。

**验证页面/服务**：用一次性命令——`curl -s http://localhost:PORT/ | head` 或 `npx playwright screenshot <url> shot.png`（完成即退出）。

**本项目注意**：corpus/pages/ 下有大量生成的 HTML 文件，批量操作时避免整目录递归处理（曾引发 11 分钟挂起），按需逐个处理。
