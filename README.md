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
| `convert` | 未实现（stub） | HTML 项目 → deck.pptx |
| `render` | 未实现（stub） | 每页 one-shot 截图 |
| `validate` | 未实现（stub） | 结构校验 deck.pptx |
| `validate-html` | 未实现（stub） | HTML 约束校验 |
| `doctor` | 已实现（stage-1） | 环境自检：Node 版本 / Playwright chromium / Sharp 原生绑定 |

```bash
node bin/ppt-engine.js doctor --json
```

输出 `{ok, checks:[{name, ok, detail, fix}]}`。

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

## Layout

```
src/      引擎源码（后续 todo 填充）
bin/      CLI 入口
test/     测试
corpus/   黄金语料库 fixture
skill/    Skill 壳
tokens/   设计令牌
docs/     文档
```