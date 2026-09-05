# ppt-engine

一句话生成 PPT 的本地转换引擎：AI（skill 侧）先设计好每页的精美 HTML，本引擎把它变成**真正的 PowerPoint 原件**——每个文字都是可双击编辑的文本框、图表是原生图表、形状是原生形状，而不是一张图片。

## Requirements

- Node.js >= 20（`engines.node` 已声明）
- Playwright Chromium 浏览器（**手动安装，引擎绝不自动下载**）

### 安装 Playwright Chromium

```bash
npm i
npx playwright install chromium
```

> **中国大陆网络提示**：若下载缓慢或失败，先设置镜像再执行安装：
>
> ```powershell
> $env:PLAYWRIGHT_DOWNLOAD_HOST = "https://npmmirror.com/mirrors/playwright"
> npx playwright install chromium
> ```
>
> 也可在 `doctor` 的 `fix` 提示中看到同样指引。

## CLI

```bash
node bin/ppt-engine.js <command> [options]
```

| 命令 | 状态 | 说明 |
| --- | --- | --- |
| `convert` | 已实现 | HTML 项目 → deck.pptx（内置结构校验，exit 0 仅当零错误） |
| `render` | 已实现 | 每页 one-shot 截图（deviceScaleFactor 2，QA 用） |
| `validate` | 已实现 | 结构校验已生成的 deck.pptx（重建 IR → 文本/边界/字体/bodyPr 核对） |
| `validate-html` | 已实现 | HTML 约束 + token 白名单校验 |
| `doctor` | 已实现 | 环境自检：Node / Chromium / Sharp / Windows 字体 / 可选 soffice+pdftoppm（`--json` / `--strict`） |
| `pdf-extract` | 已实现 | PDF → 每页 PNG + 分页文本 + extract-report.json（Poppler 可选，PDF 输入必需） |

```bash
node bin/ppt-engine.js doctor --json --strict        # 环境自检
node bin/ppt-engine.js pdf-extract --in <file.pdf> --out <dir> [--poppler-dir <bin>]   # PDF 输入：每页 PNG + 分页文本
node bin/ppt-engine.js convert --project out/<deck>   # 项目 → out/out/<deck>/deck.pptx + <标题>.pptx
node bin/ppt-engine.js render --project out/<deck> --shots
node bin/ppt-engine.js validate out/out/<deck>/deck.pptx
```

> **输出目录规则**：`convert` 的产物恒为 `<project>/../out/<deck名>/`（含 deck.pptx + conversion-report.json + shots/ + 自包含的 pages/tokens 拷贝）。输出项目自包含，可直接 `validate`。

输出 `{ok, checks:[{name, ok, detail, fix}]}`（`--json` 时）。

## Test

```bash
npm test
# or, equivalently:
node --test "test/**/*.test.js"
```

使用 Node 内建 `node:test` + `node:assert`，无第三方测试框架。

> **Windows / Node ≥ 21 已知问题**：`node --test test/`（目录参数）会因上游回归
> [nodejs/node#64555](https://github.com/nodejs/node/issues/64555) 报
> `MODULE_NOT_FOUND`（目录被当作字面 glob 匹配到目录本身）。该 bug 在 Node 20 与
> Linux/macOS 上不存在，修复 PR（#64659 / #64824）尚未合入任何发布版。
> 规避方式：使用 glob 形式 `node --test "test/**/*.test.js"`，或直接 `node --test`
> （自动发现，默认模式含 `**/test/**/*.{cjs,mjs,js}`）。

## 一键生成 PPT（skill 工作流）

见 `skill/SKILL.md`：一句话主题或文档 → 大纲（deck.json）→ 冻结 tokens → 逐页手写 HTML → `convert` → `render --shots` → 截图 QA 循环 → 交付原生可编辑 deck.pptx。设计令牌 / HTML 约束 / QA 标准见 `skill/references/`。

## Layout

```
src/      引擎源码（render 测量 / convert 转换 / validate 校验 / raster 栅格化 / doctor）
bin/      CLI 入口（convert/render/validate/validate-html/doctor）
test/     测试（含 corpus-gate 黄金语料门禁，~102 用例）
corpus/   黄金语料库 fixture（12 页，只读）
skill/    Skill 壳（SKILL.md 一键工作流 + design-system/html-constraints/visual-qa）
tokens/   设计令牌（tokens/default.json 默认商务蓝灰）
out/      输出产物（gitignored）
业务复盘汇报/ Transformer入门分享/ 余华介绍/   E2E 演示源项目（双通道 AI 通道，gitignored 不入库）
docs/     文档
```