# 视觉评审 Rubric（Visual QA）

> 截图评审的唯一依据。在 `render --shots` 产出 `shots/NN.png` 后，逐页对照本 rubric 评审，findings 落 JSON。配套：SKILL.md ⑥ 阶段门、references/design-system.md（设计依据）、references/html-constraints.md（语法约束）。
>
> 评审对象：`out/out/<deck>/shots/NN.png`（1920×1080，2× 截图）。每页的 `intent`（deck.json）是"这页必须传达什么"的核对基准。

## §0 前置条件（Prerequisites）

评审前必须满足，否则先回 ⑤ 转换阶段：

1. `convert` 退出码 0，且 `conversion-report.json` 的 `errors:total` = 0（引擎级错误已清零）。
2. `render --shots` 已产出全部 `shots/NN.png`，文件存在且非空。
3. 截图尺寸 1920×1080（2×）。

引擎已强制的事（**不要重复检查**）：元素白名单、裸文字、渐变文字、CJK letter-spacing 超限、栅格化含文字、图表 schema、页面尺寸、lang——这些是 `convert` 的校验错误，不是本 rubric 的职责。

## §1 Hard 规则（命中必须修）

| # | 类别 | 触发条件 | 允许的修法 |
|---|------|---------|-----------|
| H1 | 越界 | 元素超出 960×540 画布（截图里贴边/出边） | 缩小或移回画布内 |
| H2 | 文字溢出 | 文字超出其容器/文本框边界（截断、压边） | 减小字号或换行，或加大容器 |
| H3 | 文字重叠 | 两个文字块互相覆盖（同一文本框内换行除外） | 重排位置或调整尺寸 |
| H4 | 对比度不足 | 小字（<24px）对比度 < 4.5:1；大字（≥24px）< 3.0:1 | 换用 tokens 内更深的文字色 / 更浅的底色；**不得自造颜色** |
| H5 | 破图 | 图片缺失、损坏、严重变形（拉伸/裁切掉关键内容） | 修 `img` 的 src / object-fit / 尺寸 |
| H6 | 缺关键元素 | `intent` 声明的关键信息在截图中缺失 | 按 intent 补回元素 |
| H7 | 人物肖像身份一致性 | 页面含具名真实人物肖像 | 对照权威来源（出版社/官方媒体/百科）核实确为本人；无法核实 → 从权威来源替换或移除（宁缺毋错） |

检测顺序：H1 → H2 → H3（结构）→ H4（可读性）→ H5 → H6 → H7（内容）。逐页顺序执行，不并行。H7 在 ④ 页编写时执行、⑥ QA 复核。

H7 验证方式：web 搜索权威来源（出版社/官方媒体/百科）核对肖像身份；验证结论记录于项目 NOTES.md（deckC 先例：余华介绍/NOTES.md 事实核查段）。

## §2 Soft 规则（明显才修）

> 应用"**明显**"阈值：拿不准就不动。宁可少修，不要来回振荡。

| # | 类别 | 触发条件 | 修复方向 |
|---|------|---------|---------|
| S1 | 垂直节奏 | 同一逻辑文本块内行距过紧（< 1.05× 字号）或出现 > 150px 的非装饰性空洞 | 行距调到 1.15–1.3×；收紧空洞 |
| S2 | 对齐漂移 | 同列元素 x 偏差 > 4px，或同行基线偏差 > 4px，且语义上应在同一网格线 | 对齐到 8px 网格 |
| S3 | CJK 字距 | 中文文字 letter-spacing 超过字号 2%（截图目测字距异常） | 降到 ≤ 2%（引擎已拦超限，此处只查目测异常） |
| S4 | accent 过量 | accent 色面积 > 页面 10%，或一页 accent 出现 > 3 处 | 收敛到 ≤ 3 处、≤ 10% |

每轮 soft 修复上限 **2 处**；其余 soft 命中记入 findings 的 `untouched_concerns`。

## §3 Don't-touch（不可触碰）

与 §1 同等权重的硬边界：

- **tokens.json**（冻结）：不改颜色、字体、字号、间距 token；发现 token 本身有问题 → 升级给用户，不在页面里绕过。
- **内容语义**：不增删文案、不改数字、不改图表数据；只允许调位置、字号（阶梯内）、间距、对齐。
- **版式结构**：不改列数、不换图表类型（bar↔line）、不增删区块。
- **其他文件**：不编辑 design-system.md / html-constraints.md / deck.json 的 intent / 其他页面的 HTML。
- **原子性**：一次修一处，不做批量多元素替换。

若某"违规"必须改 tokens 或重构版式才能修 → 记入 `needs_human_items`（带 `suggested_fix_summary`），不擅自处理。

## §4 迭代预算（Iteration Budget）

- **默认 1 轮，上限 3 轮**。每轮 = 修 HTML → 重 `convert` → 重 `render` → 复核。
- 每轮必须：修完全部 hard 命中；soft 最多修 2 处。
- **回滚触发**：某轮修复引入了**之前不存在的新 hard 命中** → 立即回滚本轮对 HTML 的全部修改，该页记 `needs_human`，findings 记录"rolled back fix X — created Hard Y"。
- **干净退出**：一轮结束 hard = 0 且 soft ≤ 2 → 该页 `ok`（无修改）或 `fixed`（有修改）。
- 轮次用尽仍不达标 → 进入 §7 升级。

## §5 Findings JSON Schema（以 data-ppt-id 为键）

每轮评审结果写 `out/<deck>/findings.json`（追加轮次历史，**不删除旧轮记录**）：

```json
{
  "deck": "deckA",
  "rounds": 2,
  "pages": {
    "03.html": {
      "role": "content",
      "intent": "问题分析：双栏，左问题右对策",
      "status": "fixed",
      "hard": [
        {
          "data-ppt-id": "chart-revenue",
          "rule": "H2",
          "evidence": "柱状图标签文字溢出图表容器右缘 12px",
          "fix": "缩小图表容器宽度至 600px",
          "round": 1
        }
      ],
      "soft": [
        {
          "data-ppt-id": "list-left",
          "rule": "S2",
          "evidence": "左栏列表项 x 偏差 6px",
          "fix": "对齐到 48px 网格",
          "round": 1
        }
      ],
      "untouched_concerns": [
        { "data-ppt-id": "footer", "rule": "S1", "evidence": "页脚与正文间距偏大", "reason": "soft-cap reached" }
      ],
      "needs_human_items": [
        { "data-ppt-id": "title", "rule": "H4", "suggested_fix_summary": "muted 色在深底上对比度不足，需在 tokens 层决策" }
      ]
    }
  },
  "summary": { "hard": 0, "soft": 2, "rounds": 2 }
}
```

字段约定：
- 键 = 页面文件名（`NN.html`）；每条 finding 的键 = 元素 `data-ppt-id`（缺失时用引擎自动补的 `ppt-N`）。
- `status`：`ok`（无修改）/ `fixed`（有修改）/ `needs_human`（需升级）。
- `hard` / `soft`：数组，每条含 `data-ppt-id`、`rule`（H1–H7 / S1–S4）、`evidence`（客观描述）、`fix`（已做的修改）、`round`。
- `untouched_concerns`：soft 上限未处理的命中，`reason` 为 `soft-cap reached` 或 `ambiguous_design_intent`。
- `needs_human_items`：必须带 `suggested_fix_summary`，禁止只写问题不写建议。
- `summary`：终态计数——**退出标准：`hard` = 0 且 `soft` ≤ 2**。

## §6 退出标准（QA Exit Criteria）

- `conversion-report.json`：`errors:total` = 0。
- findings 终态：`summary.hard` = 0，`summary.soft` ≤ 2。
- 轮次 ≤ 3。
- 全部满足 → 进入 SKILL.md ⑦ 交付。

## §7 超限升级报告（Escalation Report）

轮次用尽（3 轮）或出现 don't-touch 冲突时，**停止自行修复**，向用户输出以下格式的报告：

```
## QA 升级报告：<deck 名>

**状态**：迭代预算已用尽 / 触及 don't-touch 边界（选一）

**轮次历史**（findings.json 完整保留）：
- 第 1 轮：hard 3 → 2，soft 4 → 3
- 第 2 轮：hard 2 → 1（修复 X 引入新 hard Y，已回滚）
- 第 3 轮：hard 1 → 1（未收敛）

**剩余问题**（按 data-ppt-id 列出）：
- `chart-revenue` [H2]：标签溢出容器右缘 12px。已尝试：缩小容器。未收敛原因：……
- `title` [H4]：muted 色对比度不足。**需要 tokens 层决策**（don't-touch）：建议把 muted 从 #6B7280 调深到 #4B5563，或该页改用 primary 色标题。

**需要用户决策的选项**：
1. 接受现状（hard 1 处，影响轻微）→ 直接交付；
2. 授权修改 tokens.json（解除冻结一次）→ 我改后全 deck 复查；
3. 授权重构该页版式（改列数/换图表）→ 我重写该页 HTML。

**当前产物**：out/out/<deck>/deck.pptx（上一轮零错误版本）+ 源文件 out/<deck>/ 完整保留。
```

要点：给用户**可执行的选项**（接受 / 授权 / 重构），不把问题抛回去让用户自己想办法；所有轮次历史保留在 findings.json，证明迭代真实发生。