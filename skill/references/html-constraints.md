# HTML 编写约束（HTML Constraints for AI Authors）

> 本文件是 AI 撰写每页 `pages/NN.html` 时的**唯一语法依据**，与转换引擎的校验规则 1:1 对应。每条规则带机器可读的 `rule` id——校验器报错时按 id 查本文件找修复方法。
>
> 错误格式（引擎输出）：`{page, data-ppt-id, rule, measured, available, suggested_fix}`。**校验失败 = 转换失败**，绝不静默降级。

---

## 0. 规则总表（Rule Index）

| rule id | 含义 | 严重度 |
|---|---|---|
| `lang-missing` | 页面缺 `lang="zh-CN"` | 错误 |
| `page-size-mismatch` | body 尺寸不是 960×540 | 错误 |
| `element-not-allowed` | 使用了白名单外元素 | 错误 |
| `bare-text` | 文字出现在白名单容器之外 | 错误 |
| `gradient-on-text` | 文字上使用渐变（background-clip:text 等） | 错误 |
| `cjk-letter-spacing` | CJK 文字 letter-spacing 超过字号 2% | 错误 |
| `raster-with-text` | 含可见文字的元素被整体栅格化 | 错误 |
| `chart-schema` | `data-ppt-chart` JSON 不符合 schema | 错误 |

> 另有引擎级硬禁（无独立 id，直接报错）：`backdrop-filter`、CSS `columns`、`position:fixed/sticky`、`animation`/`transition`、`<table>`、`@font-face`、白名单外字体。这些特性**一律禁止**，本文件只作为"禁止项"提及，不提供任何用法。

---

## 1. HTML 骨架模板（Skeleton Template）

每页一个独立 HTML 文件，结构固定如下。**所有元素必须带 `data-ppt-id`**（缺失时引擎自动补 `ppt-N` 并告警，但请主动写）。

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>01-封面</title>
  <style>
    /* 内联 <style> 允许；禁止 @font-face、禁止动画 */
    * { box-sizing: border-box; }
    body {
      width: 960px; height: 540px; margin: 0;
      background: #F5F7FA;            /* 取自 tokens palette.bg */
      font-family: "DengXian", "Microsoft YaHei", "Segoe UI", sans-serif;
      color: #1A1A1A;                 /* palette.text */
      padding: 40px 48px 32px 48px;   /* 8px 网格 */
    }
    h1 { font-family: "Microsoft YaHei", "Segoe UI", sans-serif; font-weight: 700; }
  </style>
</head>
<body data-ppt-role="cover">
  <!-- 每个元素都有 data-ppt-id；文字只在 p/h1-h6/li/a/span 内 -->
  <h1 data-ppt-id="title">2026 年度业务复盘</h1>
  <p data-ppt-id="subtitle">从增长到提效：一份诚实的成绩单</p>
  <p data-ppt-id="meta" class="small">2026-09-02 · 战略部</p>
</body>
</html>
```

### 1.1 属性用法

| 属性 | 作用 | 示例 |
|---|---|---|
| `data-ppt-id` | 元素唯一标识（错误定位、QA findings 的键） | `data-ppt-id="chart-revenue"` |
| `data-ppt-role` | 页面语义角色（cover/toc/section/content/data/closing），写在 `<body>` 上 | `data-ppt-role="data"` |
| `data-ppt-chart` | 声明原生图表（值 = JSON，见 §3） | `data-ppt-chart='{"type":"bar","labels":["Q1","Q2"],"series":[{"name":"营收","data":[120,150]}]}'` |
| `data-ppt-notes` | 演讲者备注（写在任意元素上，引擎提取为 PPT 备注） | `data-ppt-notes="本页讲三个要点：……"` |
| `data-ppt-raster` | 标记容器需栅格化（仅限渐变容器 / clip-path / 装饰层） | `data-ppt-raster` |

### 1.2 元素白名单（element-not-allowed）

**只允许**：`body` `div` `h1` `h2` `h3` `h4` `h5` `h6` `p` `ul` `ol` `li` `img` `a` `span`。

**禁止**：`table`（用双栏 div 替代）、`section`/`article`/`header`/`footer`/`main` 等语义标签（用 div）、`svg`、`canvas`、`iframe`、`video`、`form`、`button`、`input`、`script`、`style` 之外的任何标签。用了 = 校验错误 `element-not-allowed`。

### 1.3 文字位置（bare-text）

**文字只准出现在**：`p`、`h1`–`h6`、`li`、`a`、`span` 内。以下情况触发 `bare-text` 错误：

- 文字直接写在 `div` / `body` 里（无 p/span 包裹）
- 文字写在 `img` 的 `alt` 之外的其他属性里当正文
- 用 `::before`/`::after` 的 `content` 塞文字

```html
<!-- ❌ bare-text：文字直接挂在 div 下 -->
<div data-ppt-id="bad">这是裸文字</div>

<!-- ✅ 正确：用 p 或 span 包裹 -->
<div data-ppt-id="ok"><p>这是正文</p></div>
```

---

## 2. 逐条规则详解（Rule Reference）

### 2.1 `lang-missing` — 页面语言缺失

- 触发：`<html>` 或 `<body>` 缺 `lang="zh-CN"`。
- 修复：`<html lang="zh-CN">`（推荐写在 html 标签上）。
- 原因：引擎按此设置每个文本 run 的 `lang:'zh-CN'`，PowerPoint 才能正确做中文排版与拼写检查。

### 2.2 `page-size-mismatch` — 页面尺寸不符

- 触发：`body` 的计算尺寸不是 **960 × 540 px**（含 margin 导致的偏移、`width` 缺省、`min-width` 撑大等）。
- 修复：`body { width:960px; height:540px; margin:0; }`，且不要用 `position:fixed/sticky`（会脱离 960×540 布局）。
- 自查：任何子元素 rect 超出 960×540 也会在转换时被标记越界，先修布局再转换。

### 2.3 `element-not-allowed` — 白名单外元素

- 触发：出现 §1.2 白名单之外的标签。
- 修复：把 `table` 换成双栏 `div`；把 `section`/`header` 等换成 `div`；装饰图形用 `div` + CSS 背景/边框画，不用 `svg`。
- 注意：`<style>` 只允许出现在 `<head>` 内；`<script>` 一律禁止。

### 2.4 `bare-text` — 裸文字

- 触发：文字节点不在 `p/h1-h6/li/a/span` 内（见 §1.3）。
- 修复：给裸文字包一层 `p` 或 `span`，并补 `data-ppt-id`。

### 2.5 `gradient-on-text` — 渐变文字

- 触发：`background: linear-gradient(...)` + `-webkit-background-clip: text` / `background-clip: text` + `color: transparent` 的组合（文字渐变）。
- 修复：文字一律用纯色 token（`color: #1F4E79` 之类）。渐变只允许用在**容器背景**上，且该容器必须标 `data-ppt-raster`、上面不得有文字（见 2.7）。
- 禁止项（引擎级）：`backdrop-filter`、CSS `columns`、`position:fixed/sticky`、`animation`/`transition`——这些特性在转换管线里没有对应物，出现即报错，**不要使用**。

### 2.6 `cjk-letter-spacing` — 中文字距超限

- 触发：含 CJK 字符（`[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]`）的文本，`letter-spacing` 超过**字号 × 2%**。
  - 例：17px 正文的 letter-spacing 上限 = 0.34px；56px 标题上限 = 1.12px。
- 修复：中文正文 `letter-spacing: 0` 或 ≤ 0.3px；需要"字距感"时用 0.5px 以内的值，或改用字重/字号表达层级。
- 原因：PowerPoint 对中文 letter-spacing 的渲染与浏览器不一致，超限会重排错位。

### 2.7 `raster-with-text` — 含文字元素被栅格化

- 触发：标了 `data-ppt-raster`（或命中渐变容器 / clip-path 触发器）的元素**内部含有可见文字**。
- 修复：把文字移出栅格化容器——栅格化只用于**纯装饰层**（渐变背景、clip-path 图形）。文字必须作为独立原生文本框放在栅格层之上。
- 结构示例：

```html
<!-- ✅ 正确：渐变背景栅格化，文字是独立原生层 -->
<div data-ppt-raster data-ppt-id="bg-grad"
     style="position:absolute; left:0; top:0; width:960px; height:540px;
            background:linear-gradient(135deg,#14365C,#1F4E79);"></div>
<h1 data-ppt-id="title" style="position:absolute; left:48px; top:200px;">标题</h1>

<!-- ❌ raster-with-text：文字在栅格化容器里 -->
<div data-ppt-raster data-ppt-id="bad"
     style="background:linear-gradient(135deg,#14365C,#1F4E79);">
  <p>这段文字会被整体栅格化 → 报错</p>
</div>
```

### 2.8 `chart-schema` — 图表 JSON 不符合 schema

- 触发：`data-ppt-chart` 的值不是合法 JSON，或缺少 `type` / `labels` / `series` 字段，或 `type` 不是 `bar`/`line`（`pie` 等 → `chart-type-unsupported`）。
- 修复：按 §3 的 schema 重写。JSON 必须用**单引号包裹**在 HTML 属性里（属性值内用双引号），或转义双引号。

---

## 3. 图表 JSON Schema（Chart JSON Schema，data-ppt-chart）

> MVP 仅支持 **bar（柱状图）** 与 **line（折线图）**。图表颜色/字体由引擎从 tokens 注入，页面里不用写颜色。

```json
{
  "type": "bar | line",
  "labels": ["Q1", "Q2", "Q3", "Q4"],
  "series": [
    { "name": "营收（万元）", "data": [120, 150, 138, 172] },
    { "name": "利润（万元）", "data": [30, 42, 38, 55] }
  ]
}
```

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `type` | string | ✅ | 仅 `"bar"` 或 `"line"`；其他值报 `chart-type-unsupported` |
| `labels` | string[] | ✅ | 分类轴标签，长度 ≥ 1；建议 ≤ 12 个 |
| `series` | object[] | ✅ | 至少 1 个系列 |
| `series[].name` | string | ✅ | 系列名（图例用） |
| `series[].data` | number[] | ✅ | 数值数组，长度必须与 `labels` 一致 |

**HTML 中的写法**（属性值用单引号包 JSON，JSON 内部用双引号）：

```html
<div data-ppt-id="chart-revenue" data-ppt-role="data"
     data-ppt-chart='{"type":"bar","labels":["Q1","Q2","Q3","Q4"],"series":[{"name":"营收","data":[120,150,138,172]}]}'
     style="width:640px; height:320px; background:#EDF1F6;"></div>
```

**常见错误**：
- 属性值里用了双引号包 JSON → 属性提前闭合，JSON 损坏 → `chart-schema`。
- `series[].data` 长度 ≠ `labels` 长度 → `chart-schema`。
- `type:"pie"` → `chart-type-unsupported`（MVP 不支持，改用 bar 或拆成多页）。

---

## 4. 演讲者备注（data-ppt-notes）

写在任意元素上，引擎提取为 PowerPoint 备注：

```html
<p data-ppt-id="notes" data-ppt-notes="本页讲三点：1) 营收同比增长 15%；2) 利润增速快于营收；3) 下季度重点在华东。"></p>
```

- 备注文字同样遵守 bare-text 规则（写在 p/span 内）。
- 一页最多一个备注元素；备注不参与视觉排版（引擎只提取文本）。

---

## 5. 写页前自查清单

- [ ] `<html lang="zh-CN">`（`lang-missing`）
- [ ] `body` 960×540、margin:0（`page-size-mismatch`）
- [ ] 只用白名单元素（`element-not-allowed`）
- [ ] 文字只在 p/h1-h6/li/a/span 内（`bare-text`）
- [ ] 无渐变文字（`gradient-on-text`）
- [ ] CJK letter-spacing ≤ 字号 2%（`cjk-letter-spacing`）
- [ ] 栅格化容器内无文字（`raster-with-text`）
- [ ] `data-ppt-chart` JSON 合法且符合 schema（`chart-schema`）
- [ ] 无 backdrop-filter / CSS columns / fixed/sticky / animation / table / @font-face
- [ ] 每个元素有 `data-ppt-id`，body 有 `data-ppt-role`
- [ ] 颜色/字体/字号/间距全部来自 design-system.md 与 tokens.json