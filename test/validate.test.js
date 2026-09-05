'use strict';

/**
 * validate.test.js — validator group (tokens/HTML constraints + pptx structure).
 *
 * Two input paths:
 *   1. bad fixtures (test/fixtures/*.html) rendered through src/render.js →
 *      validateHtmlIR → each asserts its expected rule id + non-empty errors;
 *   2. a clean corpus page (02) → validateHtmlIR returns zero errors, and a
 *      pptx built via buildPresentation → validatePptx returns ok; tampered
 *      copies (deleted <a:t> / shape moved out of bounds) are caught.
 *
 * Anti-hang discipline: every renderPage call is raced against a 30s timer;
 * the shared browser is closed in after().
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const { chromium } = require('playwright');
const { renderPage } = require('../src/render.js');
const { buildPresentation } = require('../src/convert/page.js');
const { validateTokens, validateHtmlIR } = require('../src/validate/tokens-html.js');
const { validatePptx } = require('../src/validate/pptx.js');

const CORPUS = path.join(__dirname, '..', 'corpus');
const PAGES = path.join(CORPUS, 'pages');
const FIXTURES = path.join(__dirname, 'fixtures');
const TOKENS_PATH = path.join(__dirname, '..', 'tokens', 'default.json');
const RENDER_TIMEOUT_MS = 30000;

const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));

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
let corpus02Ir;

before(async () => {
  browser = await chromium.launch({ headless: true });
  corpus02Ir = await withTimeout(renderPage(path.join(PAGES, '02.html'), { browser }), RENDER_TIMEOUT_MS, 'render corpus 02');
});

after(async () => {
  if (browser) await browser.close();
});

async function renderFixture(file) {
  return withTimeout(renderPage(path.join(FIXTURES, file), { browser }), RENDER_TIMEOUT_MS, `render ${file}`);
}

async function buildCorpus02Pptx() {
  const pptx = buildPresentation([corpus02Ir], tokens);
  return pptx.write({ outputType: 'nodebuffer' });
}

// ---------------------------------------------------------------------------
// validateTokens (schema)
// ---------------------------------------------------------------------------

test('validateTokens: default tokens pass with zero errors', () => {
  assert.deepEqual(validateTokens(tokens), []);
});

test('validateTokens: schema violations are reported as token-schema', () => {
  const bad = {
    pageSize: { w: 960 }, // missing h
    palette: { bg: 'red', primary: '#1F4E79' }, // bad hex + missing keys
    fonts: { heading: 'Comic Sans MS' }, // off-whitelist font + missing keys
    typeScale: { h1: 100, body: 17 }, // h1 out of range + missing keys
    spacing: 4, // not 8
  };
  const errors = validateTokens(bad);
  assert.ok(errors.length > 0, 'bad tokens must produce errors');
  assert.ok(errors.every((e) => e.rule === 'token-schema'), JSON.stringify(errors));
  const measured = errors.map((e) => e.measured).join('\n');
  const fixes = errors.map((e) => e.suggested_fix).join('\n');
  assert.match(measured, /w":960/, 'pageSize violation must be reported');
  assert.match(measured, /palette/, 'palette violation must be reported');
  assert.match(measured, /fonts/, 'fonts violation must be reported');
  assert.match(measured, /typeScale/, 'typeScale violation must be reported');
  assert.match(fixes, /spacing/, 'spacing violation must be reported');
});

// ---------------------------------------------------------------------------
// validateHtmlIR — one bad fixture per rule
// ---------------------------------------------------------------------------

const FIXTURE_RULES = [
  ['bare-text.html', 'bare-text'],
  ['gradient-text.html', 'gradient-on-text'],
  ['cjk-ls.html', 'cjk-letter-spacing'],
  ['page-size.html', 'page-size-mismatch'],
  ['table-element.html', 'element-not-allowed'],
  ['color-off.html', 'color-not-in-tokens'],
  ['font-off.html', 'font-not-in-tokens'],
  ['chart-bad.html', 'chart-schema'],
  ['chart-pie.html', 'chart-type-unsupported'],
  ['size-off.html', 'size-not-in-scale'],
  ['style-forbidden.html', 'style-forbidden'],
  ['raster-text.html', 'raster-with-text'],
  ['no-lang.html', 'lang-missing'],
  ['img-no-src.html', 'img-src-missing'],
];

for (const [file, rule] of FIXTURE_RULES) {
  test(`fixture ${file} → validateHtmlIR reports ${rule}`, async () => {
    const ir = await renderFixture(file);
    const errors = validateHtmlIR(ir, tokens);
    assert.ok(errors.length > 0, `${file} must produce non-empty errors`);
    const hit = errors.find((e) => e.rule === rule);
    assert.ok(hit, `${file} must report ${rule}, got: ${JSON.stringify(errors.map((e) => e.rule))}`);
    // structured error shape
    assert.ok('page' in hit && 'data-ppt-id' in hit && 'measured' in hit && 'available' in hit && 'suggested_fix' in hit);
    assert.ok(typeof hit.suggested_fix === 'string' && hit.suggested_fix.length > 0);
  });
}

test('clean corpus 02 → validateHtmlIR returns zero errors', () => {
  const errors = validateHtmlIR(corpus02Ir, tokens);
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------
// validatePptx — structural checks on a real generated deck
// ---------------------------------------------------------------------------

test('validatePptx: corpus 02 deck passes (ok=true, zero errors)', async () => {
  const buf = await buildCorpus02Pptx();
  const result = await validatePptx(buf, [corpus02Ir], tokens);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
});

test('validatePptx: tampered deck with a deleted <a:t> → missing-text', async () => {
  const buf = await buildCorpus02Pptx();
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  const tampered = xml.replace(/<a:t>[^<]*<\/a:t>/, '');
  assert.notEqual(tampered, xml, 'tamper must delete a text run');
  zip.file('ppt/slides/slide1.xml', tampered);
  const tamperedBuf = await zip.generateAsync({ type: 'nodebuffer' });
  const result = await validatePptx(tamperedBuf, [corpus02Ir], tokens);
  assert.equal(result.ok, false);
  const hit = result.errors.find((e) => e.rule === 'missing-text');
  assert.ok(hit, `must report missing-text, got: ${JSON.stringify(result.errors.map((e) => e.rule))}`);
  assert.ok(typeof hit.measured === 'string' && hit.measured.length > 0);
});

test('validatePptx: tampered deck with a shape moved out of bounds → out-of-bounds', async () => {
  const buf = await buildCorpus02Pptx();
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  const tampered = xml.replace('<a:off x="457200" y="457200"/>', '<a:off x="-100" y="457200"/>');
  assert.notEqual(tampered, xml, 'tamper must move a shape off-canvas');
  zip.file('ppt/slides/slide1.xml', tampered);
  const tamperedBuf = await zip.generateAsync({ type: 'nodebuffer' });
  const result = await validatePptx(tamperedBuf, [corpus02Ir], tokens);
  assert.equal(result.ok, false);
  const hit = result.errors.find((e) => e.rule === 'out-of-bounds');
  assert.ok(hit, `must report out-of-bounds, got: ${JSON.stringify(result.errors.map((e) => e.rule))}`);
  assert.match(hit.measured, /x=-100/);
});

test('validatePptx: text with quotes/apostrophe/ampersand passes (escapeXml parity with PptxGenJS)', async () => {
  // PptxGenJS escapes " → &quot; and ' → &apos; inside <a:t>; the validator's
  // escapeXml must match exactly or visible quote text would false-positive
  // missing-text. Build a real deck containing all four XML-special chars.
  const border = (c) => ({ widthPx: 0, style: 'none', color: c });
  const el = {
    pptId: 'quote-p',
    tag: 'p',
    rect: { x: 48, y: 100, w: 500, h: 54 },
    styles: {
      bg: 'rgba(0, 0, 0, 0)',
      color: 'rgb(26, 26, 26)',
      fontStack: '"Microsoft YaHei", sans-serif',
      fontResolved: 'Microsoft YaHei',
      fontSizePx: 17,
      fontWeight: '400',
      fontStyle: 'normal',
      lineHeightUsedPx: 27.2,
      letterSpacingPx: 0,
      textAlign: 'left',
      border: { top: border('rgba(0, 0, 0, 0)'), right: border('rgba(0, 0, 0, 0)'), bottom: border('rgba(0, 0, 0, 0)'), left: border('rgba(0, 0, 0, 0)') },
      radiusPx: 0,
      shadow: null,
      opacity: 1,
      zIndex: 0,
      fontBoundingBoxAscentPx: 16,
      fontBoundingBoxDescentPx: 4,
    },
    text: '他说 "你好" & it\'s <tag>',
    attrs: {},
  };
  const ir = {
    page: 'quotes.html',
    lang: 'zh-CN',
    size: { w: 960, h: 540 },
    elements: [el],
    lines: {
      'quote-p': {
        count: 1,
        rects: [{ x: 48, y: 100, w: 500, h: 54 }],
        runs: [[{
          text: '他说 "你好" & it\'s <tag>',
          styles: { fontResolved: 'Microsoft YaHei', fontSizePx: 17, fontWeight: '400', fontStyle: 'normal', color: 'rgb(26, 26, 26)', letterSpacingPx: 0 },
        }]],
      },
    },
    warnings: [],
    errors: [],
  };
  const pptx = buildPresentation([ir], tokens);
  const buf = await pptx.write({ outputType: 'nodebuffer' });
  const result = await validatePptx(buf, [ir], tokens);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});