'use strict';

/**
 * render.test.js — browser measurement layer (HTML → layout IR).
 *
 * Uses node:test + node:assert. Renders golden corpus pages through
 * src/render.js (real headless chromium) and asserts the binding IR:
 *   {page, size:{w:960,h:540}, elements:[{pptId,tag,rect,styles}],
 *    lines:{[pptId]:{count,rects}}, warnings, errors}
 *
 * Anti-hang discipline: every renderPage call is raced against a 30s timer;
 * the shared browser is closed in after(); the CLI spawns are bounded by
 * spawnSync timeout.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { renderPage } = require('../src/render.js');

const CORPUS = path.join(__dirname, '..', 'corpus');
const PAGES = path.join(CORPUS, 'pages');
const FIXTURES = path.join(__dirname, 'fixtures');
const BIN = path.join(__dirname, '..', 'bin', 'ppt-engine.js');

const expected = JSON.parse(fs.readFileSync(path.join(CORPUS, 'expected.json'), 'utf8'));
const expectedFor = (file) => expected.pages.find((p) => p.file === file);

const RENDER_TIMEOUT_MS = 30000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
});

test('corpus 01: title/subtitle/meta each render as exactly 1 line', async () => {
  const ir = await withTimeout(renderPage(path.join(PAGES, '01.html'), { browser }), RENDER_TIMEOUT_MS, 'render 01');
  assert.equal(ir.errors.length, 0, `01 must have zero errors: ${JSON.stringify(ir.errors)}`);
  assert.equal(ir.size.w, 960);
  assert.equal(ir.size.h, 540);
  assert.equal(ir.lines.title.count, 1, '01 title must be 1 line');
  assert.equal(ir.lines.subtitle.count, 1, '01 subtitle must be 1 line');
  assert.equal(ir.lines.meta.count, 1, '01 meta must be 1 line');
  // line rects must carry real dimensions (load-bearing for per-line emission)
  const titleRect = ir.lines.title.rects[0];
  assert.ok(titleRect && titleRect.w > 0 && titleRect.h > 0, `01 title line rect must have w/h: ${JSON.stringify(titleRect)}`);
});

test('corpus 02: mixed CJK paragraph line counts match expected.json', async () => {
  const ir = await withTimeout(renderPage(path.join(PAGES, '02.html'), { browser }), RENDER_TIMEOUT_MS, 'render 02');
  assert.equal(ir.errors.length, 0, `02 must have zero errors: ${JSON.stringify(ir.errors)}`);
  const exp = expectedFor('02.html');
  for (const [id, count] of Object.entries(exp.textLineCounts)) {
    assert.ok(ir.lines[id], `02 must have lines for "${id}"`);
    assert.equal(ir.lines[id].count, count, `02 "${id}" line count must match expected.json`);
  }
});

test('corpus 01: CJK font resolution returns "Microsoft YaHei" for the title', async () => {
  const ir = await withTimeout(renderPage(path.join(PAGES, '01.html'), { browser }), RENDER_TIMEOUT_MS, 'render 01');
  const title = ir.elements.find((e) => e.pptId === 'title');
  assert.ok(title, '01 must contain a title element');
  assert.equal(title.styles.fontResolved, 'Microsoft YaHei');
  assert.ok(title.styles.fontBoundingBoxAscentPx > 0, 'ascent must be measured');
  assert.ok(title.styles.fontBoundingBoxDescentPx > 0, 'descent must be measured');
});

test('corpus 01/03/09: all element rects stay within the 960x540 canvas', async () => {
  for (const file of ['01.html', '03.html', '09.html']) {
    const ir = await withTimeout(renderPage(path.join(PAGES, file), { browser }), RENDER_TIMEOUT_MS, `render ${file}`);
    assert.equal(ir.errors.length, 0, `${file} must have zero errors: ${JSON.stringify(ir.errors)}`);
    assert.ok(ir.elements.length > 0, `${file} must extract elements`);
    for (const el of ir.elements) {
      const r = el.rect;
      assert.ok(r.x >= -0.5 && r.y >= -0.5, `${file} ${el.pptId} rect origin negative: ${JSON.stringify(r)}`);
      assert.ok(r.x + r.w <= 960.5, `${file} ${el.pptId} rect exceeds width: ${JSON.stringify(r)}`);
      assert.ok(r.y + r.h <= 540.5, `${file} ${el.pptId} rect exceeds height: ${JSON.stringify(r)}`);
    }
  }
});

test('no-lang fixture produces a structured {rule:"lang-missing"} error', async () => {
  const ir = await withTimeout(renderPage(path.join(FIXTURES, 'no-lang.html'), { browser }), RENDER_TIMEOUT_MS, 'render no-lang');
  const langErr = ir.errors.find((e) => e.rule === 'lang-missing');
  assert.ok(langErr, `must contain lang-missing error: ${JSON.stringify(ir.errors)}`);
  assert.equal(langErr['data-ppt-id'], null);
  assert.equal(langErr.measured, null);
  assert.equal(langErr.available, 'zh-CN');
  assert.ok(langErr.suggested_fix.length > 0);
});

test('bad-element fixture reports element-not-allowed instead of silently skipping', async () => {
  const ir = await withTimeout(renderPage(path.join(FIXTURES, 'bad-element.html'), { browser }), RENDER_TIMEOUT_MS, 'render bad-element');
  const err = ir.errors.find((e) => e.rule === 'element-not-allowed');
  assert.ok(err, `must contain element-not-allowed error: ${JSON.stringify(ir.errors)}`);
  assert.equal(err.measured, '<table>');
  assert.equal(err['data-ppt-id'], 'bad-table');
  // the allowlisted sibling is still extracted
  assert.ok(ir.elements.some((e) => e.pptId === 'ok-para'), 'allowlisted sibling must still be extracted');
});

test('no-ids fixture auto-assigns deterministic ppt-N ids with warnings', async () => {
  const ir = await withTimeout(renderPage(path.join(FIXTURES, 'no-ids.html'), { browser }), RENDER_TIMEOUT_MS, 'render no-ids');
  assert.equal(ir.errors.length, 0, `no-ids must have zero errors: ${JSON.stringify(ir.errors)}`);
  const missing = ir.warnings.filter((w) => w.rule === 'ppt-id-missing');
  assert.ok(missing.length >= 3, `must warn for each missing id, got ${missing.length}`);
  const ids = ir.elements.map((e) => e.pptId);
  assert.ok(ids.includes('ppt-1') && ids.includes('ppt-2') && ids.includes('ppt-3'), `deterministic ppt-N ids expected: ${ids.join(',')}`);
});

test('CLI validate-html --project corpus exits 0 with zero errors', () => {
  const res = spawnSync(process.execPath, [BIN, 'validate-html', '--project', CORPUS], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(res.status, 0, `validate-html must exit 0\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stdout, /12 pages, 0 errors/);
});

test('CLI validate-html on a no-lang project exits non-zero with structured JSON error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-engine-nolang-'));
  try {
    fs.writeFileSync(path.join(tmp, 'deck.json'), JSON.stringify({ pages: [{ file: 'no-lang.html' }] }));
    fs.mkdirSync(path.join(tmp, 'pages'));
    fs.copyFileSync(path.join(FIXTURES, 'no-lang.html'), path.join(tmp, 'pages', 'no-lang.html'));
    const res = spawnSync(process.execPath, [BIN, 'validate-html', '--project', tmp, '--json'], {
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.notEqual(res.status, 0, 'no-lang project must exit non-zero');
    const out = JSON.parse(res.stdout);
    assert.equal(out.pages.length, 1);
    assert.equal(out.pages[0].errors[0].rule, 'lang-missing');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});