'use strict';

// 静态文档测试：只读 skill/references/*.md，不依赖 src/ 或任何 npm 包。
// 运行：node --test test/docs-static.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DESIGN_SYSTEM = path.join(ROOT, 'skill', 'references', 'design-system.md');
const HTML_CONSTRAINTS = path.join(ROOT, 'skill', 'references', 'html-constraints.md');
const SKILL = path.join(ROOT, 'skill', 'SKILL.md');
const VISUAL_QA = path.join(ROOT, 'skill', 'references', 'visual-qa.md');

function read(file) {
  assert.ok(fs.existsSync(file), `文件不存在: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

test('design-system.md 存在且包含 ≥4 套配色系统', () => {
  const content = read(DESIGN_SYSTEM);
  // 每套配色以 "### N.N <名称> ... Palette" 标题开头
  const paletteHeadings = content.match(/^### \d+\.\d+ .*Palette/gm) || [];
  assert.ok(
    paletteHeadings.length >= 4,
    `期望 ≥4 个配色标题，实际 ${paletteHeadings.length}: ${paletteHeadings.join(', ')}`
  );
});

test('design-system.md 包含字体关键词 Microsoft YaHei', () => {
  const content = read(DESIGN_SYSTEM);
  assert.ok(content.includes('Microsoft YaHei'), '缺少关键词 "Microsoft YaHei"');
});

test('design-system.md 包含 8px 间距网格', () => {
  const content = read(DESIGN_SYSTEM);
  assert.ok(content.includes('8px'), '缺少关键词 "8px"');
});

test('html-constraints.md 覆盖全部 8 个校验规则 id', () => {
  const content = read(HTML_CONSTRAINTS);
  const requiredRuleIds = [
    'bare-text',
    'gradient-on-text',
    'cjk-letter-spacing',
    'page-size-mismatch',
    'element-not-allowed',
    'raster-with-text',
    'chart-schema',
    'lang-missing',
  ];
  const missing = requiredRuleIds.filter((id) => !content.includes(id));
  assert.deepStrictEqual(missing, [], `html-constraints.md 缺少规则 id: ${missing.join(', ')}`);
});

test('html-constraints.md 包含图表 JSON schema 章节', () => {
  const content = read(HTML_CONSTRAINTS);
  assert.ok(
    /chart JSON schema/i.test(content),
    '缺少 "chart JSON schema" 章节标题'
  );
  // schema 必须覆盖 type / labels / series 三个字段
  for (const field of ['type', 'labels', 'series']) {
    assert.ok(content.includes(field), `chart schema 缺少字段 "${field}"`);
  }
});

// ---------------------------------------------------------------------------
// todo 11：Skill 壳（SKILL.md 一键工作流 + visual-qa rubric）
// ---------------------------------------------------------------------------

test('SKILL.md 存在且包含全部阶段门标题', () => {
  const content = read(SKILL);
  // 阶段门：intake / 大纲 / tokens / 逐页 / convert / render / QA / 交付
  const requiredKeywords = ['Intake', '大纲', 'Tokens', '逐页', 'Convert', 'Render', 'QA', '交付'];
  const missing = requiredKeywords.filter((k) => !content.includes(k));
  assert.deepStrictEqual(missing, [], `SKILL.md 缺少阶段门关键词: ${missing.join(', ')}`);
});

test('SKILL.md 包含 Re-edit 双通道修改章节', () => {
  const content = read(SKILL);
  assert.ok(/Re-edit/i.test(content), '缺少 "Re-edit" 章节');
  // 双通道：AI 通道（改 HTML/tokens 重导出）+ 人工通道（PowerPoint 手改原生元素）
  assert.ok(content.includes('PowerPoint'), 'Re-edit 章节必须提到 PowerPoint 手改通道');
  assert.ok(content.includes('convert'), 'Re-edit 章节必须提到重跑 convert');
});

test('SKILL.md 包含全部禁令句（不启动服务器 / 逐页 / 冻结）', () => {
  const content = read(SKILL);
  assert.ok(/不启动/.test(content) && /服务器/.test(content), '缺少 "不启动…服务器" 禁令（Windows 会话卡死红线）');
  assert.ok(/逐页/.test(content), '缺少 "逐页" 禁令（禁脚本批量生成）');
  assert.ok(/冻结/.test(content), '缺少 "冻结" 禁令（tokens 冻结后不得中途修改）');
});

test('SKILL.md 链接到 references/visual-qa.md', () => {
  const content = read(SKILL);
  assert.ok(content.includes('visual-qa.md'), 'SKILL.md 必须引用 references/visual-qa.md');
});

test('design-system.md 包含旁门左道方法论章节（§8：配色/排版四原则/文字提炼/图表）', () => {
  const content = read(DESIGN_SYSTEM);
  // 章节存在
  assert.ok(content.includes('## 8. 旁门左道设计方法论'), '缺少 §8 旁门左道设计方法论章节');
  // 8.1 配色：631 原则 + 色轮三法 + 主色系统 + 取色来源 + 十字正交法
  for (const kw of ['6:3:1', '近似色配色法', '对比色配色法', '分散对比色', '主色系统', '明度深浅对比', '十字正交法', '排版为主、配色为辅']) {
    assert.ok(content.includes(kw), `§8.1 配色方法论缺少关键词 "${kw}"`);
  }
  // 8.2 排版四原则
  for (const kw of ['亲密（Proximity）', '对齐（Alignment）', '对比（Contrast）', '重复（Repetition）']) {
    assert.ok(content.includes(kw), `§8.2 排版四原则缺少关键词 "${kw}"`);
  }
  // 8.3 文字提炼
  for (const kw of ['一页一个核心信息', '关键词替代句子', '大字报式强调', '层级三件套']) {
    assert.ok(content.includes(kw), `§8.3 文字提炼缺少关键词 "${kw}"`);
  }
  // 8.4 图表
  for (const kw of ['按意图选图表', '一图一结论', '图表配色继承主色系统']) {
    assert.ok(content.includes(kw), `§8.4 图表规范缺少关键词 "${kw}"`);
  }
  // §7 自查清单引用了方法论
  assert.ok(content.includes('6:3:1 比例'), '§7 自查清单未引用 6:3:1 配比');
});

test('visual-qa.md 存在且包含 hard / soft / don\'t-touch 规则', () => {
  const content = read(VISUAL_QA);
  assert.ok(/hard/i.test(content), '缺少 hard 规则');
  assert.ok(/soft/i.test(content), '缺少 soft 规则');
  assert.ok(/don'?t-?touch/i.test(content), "缺少 don't-touch 规则");
});

test('visual-qa.md 包含 findings JSON schema 字段（以 data-ppt-id 为键）', () => {
  const content = read(VISUAL_QA);
  const requiredFields = ['data-ppt-id', 'rule', 'evidence', 'hard', 'soft', 'rounds'];
  const missing = requiredFields.filter((f) => !content.includes(f));
  assert.deepStrictEqual(missing, [], `visual-qa.md findings schema 缺少字段: ${missing.join(', ')}`);
});