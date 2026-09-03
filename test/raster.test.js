'use strict';

/**
 * raster.test.js — decoration-layer rasterization.
 *
 * Real corpus page 05 (gradient container + native text) is rendered, then
 * rasterized through src/raster.js, then converted through buildPresentation:
 * the slide XML must contain BOTH a <p:pic> (the rasterized gradient) AND
 * native <a:t> text (title/subtitle), with the <p:pic> BEFORE the text shapes
 * in document order. The raster PNG dims must be >= 2x the display rect.
 *
 * The raster-text fixture (gradient div with a text <p> INSIDE it +
 * data-ppt-raster) must produce the structured {rule:"raster-with-text"} error
 * — an element containing visible text is NEVER rasterized whole.
 *
 * Anti-hang discipline: every renderPage/rasterizePage call is raced against a
 * 30s timer; the shared browser is closed in after().
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const JSZip = require('jszip');
const sharp = require('sharp');
const { chromium } = require('playwright');
const { renderPage } = require('../src/render.js');
const { rasterizePage } = require('../src/raster.js');
const { buildPresentation } = require('../src/convert/page.js');

const CORPUS = path.join(__dirname, '..', 'corpus');
const PAGES = path.join(CORPUS, 'pages');
const FIXTURES = path.join(__dirname, 'fixtures');
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

test('corpus 05: gradient bg rasterized as <p:pic> before native <a:t> text', async () => {
  const htmlPath = path.join(PAGES, '05.html');
  const ir = await withTimeout(renderPage(htmlPath, { browser }), RENDER_TIMEOUT_MS, 'render 05');
  assert.equal(ir.errors.length, 0, `05 must render with zero errors: ${JSON.stringify(ir.errors)}`);

  const result = await withTimeout(rasterizePage(ir, htmlPath, { browser }), RENDER_TIMEOUT_MS, 'rasterize 05');
  assert.equal(result.errors.length, 0, `05 must rasterize with zero errors: ${JSON.stringify(result.errors)}`);

  const bg = result.ir.elements.find((e) => e.pptId === 'bg-grad');
  assert.ok(bg && bg.raster, 'bg-grad must carry raster data');
  assert.ok(Buffer.isBuffer(bg.raster.imageData), 'raster imageData must be a Buffer');
  assert.ok(bg.raster.imageData.length > 0, 'raster imageData must be non-empty');
  assert.ok(bg.raster.rect, 'raster must carry the display rect');
  assert.ok(bg.raster.filename && bg.raster.filename.startsWith('assets/'), `raster must suggest a relative filename: ${bg.raster.filename}`);

  // Raster PNG dims >= 2x display rect (±1px tolerance).
  const meta = await sharp(bg.raster.imageData).metadata();
  assert.ok(meta.width >= bg.rect.w * 2 - 1, `raster width ${meta.width} must be >= 2x rect width ${bg.rect.w}`);
  assert.ok(meta.height >= bg.rect.h * 2 - 1, `raster height ${meta.height} must be >= 2x rect height ${bg.rect.h}`);

  // Convert and inspect the slide XML.
  const pptx = buildPresentation([result.ir], {});
  const buf = await pptx.write({ outputType: 'nodebuffer' });
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');

  assert.match(xml, /<p:pic>/, 'slide must contain the rasterized gradient picture');
  assert.match(xml, /<a:t>技术架构演进<\/a:t>/, 'title must be native text');
  assert.match(xml, /<a:t>从单体到微服务的三年之路<\/a:t>/, 'subtitle must be native text');

  const picIdx = xml.indexOf('<p:pic>');
  const textIdx = xml.indexOf('<a:t>');
  assert.ok(picIdx >= 0 && textIdx >= 0, 'both <p:pic> and <a:t> must be present');
  assert.ok(picIdx < textIdx, 'raster <p:pic> must appear BEFORE the native text shapes');
});

test('raster-text fixture: visible text inside a raster container errors raster-with-text', async () => {
  const htmlPath = path.join(FIXTURES, 'raster-text.html');
  const ir = await withTimeout(renderPage(htmlPath, { browser }), RENDER_TIMEOUT_MS, 'render raster-text');
  assert.equal(ir.errors.length, 0, `fixture must render with zero errors: ${JSON.stringify(ir.errors)}`);

  const result = await withTimeout(rasterizePage(ir, htmlPath, { browser }), RENDER_TIMEOUT_MS, 'rasterize raster-text');
  const err = result.errors.find((e) => e.rule === 'raster-with-text');
  assert.ok(err, `must contain raster-with-text error: ${JSON.stringify(result.errors)}`);
  assert.equal(err['data-ppt-id'], 'bad-raster');
  assert.equal(err.page, 'raster-text.html');
  assert.match(err.suggested_fix, /split/);
  // The offending element must NOT be rasterized.
  const bad = result.ir.elements.find((e) => e.pptId === 'bad-raster');
  assert.ok(bad && !bad.raster, 'text-containing element must never be rasterized');
});