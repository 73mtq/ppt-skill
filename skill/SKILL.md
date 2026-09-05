---
name: ppt-engine
description: 一句话生成 PPT 的本地一键工作流：AI 先逐页手写精美 HTML，本地引擎把它变成真正的 PowerPoint 原件（每个文字都是可双击编辑的原生文本框、图表是原生图表），改源文件可一键重新导出。触发词：生成PPT / 做PPT / 一键PPT / 制作演示文稿 / 做一份汇报 / make a deck / create presentation / build slides。输入一句话主题或一份文档，输出可编辑的 deck.pptx，全程无需人工干预、不启动任何服务器。
---

# ppt-engine：一句话生成 PPT（HTML → 原生可编辑 PPTX）

> 本 skill 是 **AI 侧工作流**：AI 负责设计（大纲、tokens、逐页 HTML），引擎（`bin/ppt-engine.js`）负责把 HTML 精确转换为**原生 PowerPoint 元素**——不是截图，不是图片，每个文字都是可双击编辑的文本框。
>
> 配套文档（写页前必读）：
> - [references/design-system.md](references/design-system.md) — 配色 / 字体 / 字号 / 版式（唯一设计依据）
> - [references/html-constraints.md](references/html-constraints.md) — HTML 语法约束（与引擎校验规则 1:1）
> - [references/visual-qa.md](references/visual-qa.md) — 截图评审 rubric（hard / soft / don't-touch）

## 0. 前置检查（一次）

```bash
node <repo>/bin/ppt-engine.js doctor --strict
```

`<repo>` = 本仓库根目录（`D:\ppt-skill`）。doctor 检查 Node 版本、Playwright Chromium、Windows 字体、Sharp 绑定；任一 mandatory 项失败则按 `fix` 字段修复（如 `npx playwright install chromium`，CN 网络先设 `PLAYWRIGHT_DOWNLOAD_HOST` 镜像）。**doctor 全绿前不要开始做 deck。**

---

## ① 输入（Intake）

- **一句话主题**：直接进入 ② 大纲。
- **PDF 文档**：一律先走 `node <repo>/bin/ppt-engine.js pdf-extract --in <pdf> --out <项目>/pdf-extract/`，用产出的 `text/NN.txt` 提炼大纲要点、`pages/NN.png` 作视觉参照，然后进入 ② 大纲。**红线：原始 PDF 永不直接喂给模型 Read/上传**——若模型报 "does not support pdf input" 之类错误，即表明绕过了此步，回退走 pdf-extract。
- **DOCX / MD / URL 文档**：**一次性提取**内容要点（用 Read 等一次性工具提取，**不启动任何服务器、不跑长驻进程**），提炼出"这页要讲什么"后进入 ② 大纲。
- 产出：主题一句话 + 受众/场合（决定 ③ 选哪套配色）。

## ② 大纲（Outline）

确定页数与每页意图，写 **`out/<deck>/deck.json`**（`<deck>` = 简短英文名，如 `deckA`）：

```json
{
  "title": "2026 Q3 业务复盘",
  "pageSize": { "w": 960, "h": 540 },
  "tokensPath": "tokens.json",
  "pages": [
    { "file": "01.html", "slug": "cover", "role": "cover", "intent": "封面：主标题 + 副标题 + 日期/汇报人" },
    { "file": "02.html", "slug": "overview", "role": "data", "intent": "业绩概览：柱状图 + 3 个关键数字" },
    { "file": "03.html", "slug": "issues", "role": "content", "intent": "问题分析：双栏，左问题右对策" }
  ]
}
```

规则：
- 每页必须有 `role`（cover / toc / section / content / data / closing，见 design-system.md §6 版式模式）与 `intent`（**关键信息**：这页必须传达什么，QA 时按它核对）。
- `file` 与 `pages[]` 顺序一一对应（`01.html`、`02.html`…）；`slug` 会出现在输出文件名 `NN-slug.html`。
- 页数建议 8–12 页；`pageSize` 恒为 `{ "w": 960, "h": 540 }`（CSS px，引擎按 1px=0.75pt 映射）。
- `tokensPath` 写 `tokens.json`（项目内，见 ③）；也可写 `tokens/default.json`（仓库根回退）。

## ③ 设计令牌（Tokens）

1. 按 [references/design-system.md](references/design-system.md) §1 从 4 套配色中**选 1 套**，写明理由（受众/场合）：
   - 商务蓝灰（默认）：汇报、复盘、方案、对外演示
   - 科技深色：技术分享、产品发布、开发者大会
   - 暖色极简：品牌、文化、教育、生活类
   - 活力强调色：营销、活动、培训、年轻向
2. 字体取 §2（Windows 自带，英文名）、字号取 §3 阶梯、间距用 8px 网格（§4）。
3. 写 **`out/<deck>/tokens.json`**（结构见 design-system.md §0）：

```json
{
  "pageSize": { "w": 960, "h": 540 },
  "palette": { "bg": "#F5F7FA", "surface": "#FFFFFF", "primary": "#1F4E79", "accent": "#C9A227", "text": "#1A1A1A", "muted": "#6B7280", "primaryLight": "#3A6EA5", "primaryDark": "#14365C", "accentLight": "#DDBB4F", "accentDark": "#A07F1B", "surfaceAlt": "#EDF1F6", "border": "#D8DEE6" },
  "fonts": { "heading": "Microsoft YaHei", "body": "DengXian", "latin": "Segoe UI", "mono": "Consolas" },
  "typeScale": { "h1": 56, "h2": 36, "h3": 26, "body": 17, "small": 13 },
  "spacing": 8
}
```

4. **冻结**：写入后不得修改。后续所有页面只准使用这组 token，禁止发明新颜色/字体/字号。

## ④ 逐页手写 HTML（Pages）

**逐页顺序手写** `out/<deck>/pages/NN.html`（NN 从 01 开始，与 deck.json `pages[]` 顺序一致）。**禁止脚本批量生成**——每页都是独立设计。

每生成一页前：
1. **重读 tokens.json**（冻结值，颜色/字体/字号/间距全部取自它）；
2. 重读 [references/html-constraints.md](references/html-constraints.md) 的骨架模板与规则表；
3. 按 design-system.md §6 对应 role 的版式模式排版。

每页硬性要求（违反 = 转换报错）：
- `<html lang="zh-CN">`；`body { width:960px; height:540px; margin:0; }`
- 元素只用白名单：`body div h1-h6 p ul ol li img a span`；**禁 `<table>`**（双栏用两个 div 并排）
- 文字只在 `p / h1-h6 / li / a / span` 内；每个元素带 `data-ppt-id`；`<body>` 带 `data-ppt-role`
- 图表用 `data-ppt-chart`（仅 `bar` / `line`，JSON schema 见 html-constraints.md §3）
- 渐变容器标 `data-ppt-raster` 且**上面不得有文字**；无动画 / 无 fixed/sticky / 无 backdrop-filter / 无 CSS columns / 无渐变文字
- 颜色/字体/字号/间距全部来自 tokens.json；accent 面积 ≤ 10%
- **人物肖像**：一律用权威来源（出版社/官方媒体/百科），编写页时按 [references/visual-qa.md](references/visual-qa.md) 的 H7 校验身份。

## ⑤ 转换（Convert）

```bash
node <repo>/bin/ppt-engine.js convert --project out/<deck>
```

- 引擎逐页 render（浏览器精确测量）→ 校验 → 转换为原生 PPTX 元素 → 写 `deck.pptx` + `conversion-report.json`，并对产物做结构校验（`validatePptx`）。
- **输出目录规则**：恒为 `<project>/../out/<deck名>/` —— 即项目在 `out/<deck>` 时，产物在 **`out/out/<deck>/`**（deck.pptx、conversion-report.json、shots/、自包含的 pages/assets/tokens 拷贝）。
- 退出码 0 = 全页零错误且结构校验通过；非 0 = 有错误。
- 有错误时看 `conversion-report.json`（或加 `--json` 直接打印）：每页 `errors[]` 是结构化错误 `{page, data-ppt-id, rule, measured, available, suggested_fix}`，按 `rule` 查 html-constraints.md 规则表修复对应 HTML，重跑本命令。
- 报告 schema：`{title, pageSize, pages:[{file, slug, role, intent, elements, errors, warnings}], ok, "errors:total", "warnings:total"}`。**`errors:total` 必须为 0 才进入下一步。**

## ⑥ 截图评审（Render + Visual QA）

```bash
node <repo>/bin/ppt-engine.js render --project out/<deck> --shots
```

- 每页 one-shot 截图到 `out/out/<deck>/shots/NN.png`（1920×1080，2×）。
- 按 [references/visual-qa.md](references/visual-qa.md) 逐页评审：hard 规则（越界/溢出/重叠/对比度/破图/缺关键元素）必须全修，soft 规则（垂直节奏/对齐漂移/CJK 字距/accent 过量）明显才修，don't-touch（tokens/内容语义）绝不碰。
- findings 写入 `out/<deck>/findings.json`（schema 见 visual-qa.md §5）。
- 有命中 → 修 `pages/NN.html` → 重跑 ⑤ convert → 重跑本命令截图复核。
- **循环有界**：默认 1 轮，上限 3 轮；某轮修复引入**新增 hard 命中**即回滚本轮修改；超限 → 按 visual-qa.md §7 升级给用户。

## ⑦ 交付（Deliver）

- 交付 **`out/out/<deck>/deck.pptx`**（全原生可编辑：文本框/形状/图片/图表）。
- 同时生成 **`out/out/<deck>/<标题>.pptx`**——按 deck.json 的 `title` 命名的用户友好副本（Windows 文件名安全，CJK 保留），与 deck.pptx 内容一致。
- **源文件保留**：`out/<deck>/`（deck.json + tokens.json + pages/ + assets/ + findings.json）——这是双通道修改的 AI 通道（见下）。
- 向用户汇报：页数、QA 轮次、findings 终态（hard=0、soft 数）、deck.pptx 路径。

---

## Re-edit：双通道修改

交付后修改有两条通道，互不冲突：

- **通道 A（AI 通道）**：改 `out/<deck>/pages/*.html`（或 tokens.json）→ 重跑 `convert --project out/<deck>` → 输出刷新到 `out/out/<deck>/`。改 tokens.json 后所有页面都要按新 token 复查（颜色/字体变了）。
- **通道 B（人工通道）**：deck.pptx 内所有元素都是**原生 PowerPoint 元素**，直接在 PowerPoint / WPS 里双击修改文字、拖拽形状、改图表——不需要引擎。
- **优化已有 deck（PDF 输入）**：先对 PDF 跑 pdf-extract（页图+文本作参照），再改 `out/<deck>/pages/*.html`（或按 ①-⑦ 新建项目）→ convert。

## 红线（Must NOT）

- **不启动任何前台服务器 / 预览服务**（Windows 会话卡死红线）：所有操作都是 one-shot 命令（convert / render / doctor），无 watch、无 dev server、无长驻进程。
- **逐页顺序手写** pages/NN.html，**禁止脚本批量生成**页面。
- **tokens.json 冻结后不得中途修改**；不得发明 token 之外的字体/颜色/字号。
- **禁 `<table>`**（用双栏 div 替代）；禁白名单外元素与 CSS 特性（见 html-constraints.md）。
- **不做整页截图式 PPT**：所有文字必须是原生文本框，装饰层栅格化不得含文字（`raster-with-text` 是错误）。
- 不推荐白名单外字体（非 Windows 自带）与白名单外 CSS 特性。
- **原始 PDF 永不直接喂模型 Read/上传**；PDF 输入唯一下行链路是 pdf-extract（文本+页图），模型只消费这些产物。