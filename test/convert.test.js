'use strict';

/**
 * convert.test.js — conversion core (IR → native PptxGenJS).
 *
 * Two input paths:
 *   1. hand-authored fake IRs (following src/render.js output shape) for the
 *      per-line / margin / valign / lineSpacing / z-order / hyperlink / notes /
 *      indentLevel / error-path assertions;
 *   2. real corpus pages rendered through src/render.js (shared browser,
 *      closed in after()) for the slide-XML assertions (2 <a:t> separated by
 *      <a:br/>, lIns="0", typeface="Microsoft YaHei", explicit anchor).
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
const { sortElements } = require('../src/convert/containers.js');

const CORPUS = path.join(__dirname, '..', 'corpus');
const PAGES = path.join(CORPUS, 'pages');
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

// ---------------------------------------------------------------------------
// Fake IR builders (hand-authored, following src/render.js output shape)
// ---------------------------------------------------------------------------

const NO_BORDER = {
  top: { widthPx: 0, style: 'none', color: 'rgba(0, 0, 0, 0)' },
  right: { widthPx: 0, style: 'none', color: 'rgba(0, 0, 0, 0)' },
  bottom: { widthPx: 0, style: 'none', color: 'rgba(0, 0, 0, 0)' },
  left: { widthPx: 0, style: 'none', color: 'rgba(0, 0, 0, 0)' },
};

function baseStyles(over = {}) {
  return {
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
    border: NO_BORDER,
    radiusPx: 0,
    shadow: null,
    opacity: 1,
    zIndex: 0,
    fontBoundingBoxAscentPx: 16,
    fontBoundingBoxDescentPx: 4,
    ...over,
  };
}

function run(text, over = {}) {
  return {
    text,
    styles: {
      fontResolved: 'Microsoft YaHei',
      fontSizePx: 17,
      fontWeight: '400',
      fontStyle: 'normal',
      color: 'rgb(26, 26, 26)',
      letterSpacingPx: 0,
      ...over,
    },
  };
}

function fakeIr(elements, lines) {
  return {
    page: 'fake.html',
    size: { w: 960, h: 540 },
    elements,
    lines,
    warnings: [],
    errors: [],
  };
}

function textElement(pptId, over = {}) {
  return {
    pptId,
    tag: 'p',
    rect: { x: 48, y: 100, w: 500, h: 54 },
    styles: baseStyles(),
    text: '',
    attrs: {},
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderCorpus(file) {
  const ir = await withTimeout(renderPage(path.join(PAGES, file), { browser }), RENDER_TIMEOUT_MS, `render ${file}`);
  assert.equal(ir.errors.length, 0, `${file} must render with zero errors: ${JSON.stringify(ir.errors)}`);
  return ir;
}

async function convertToZip(irPages) {
  const pptx = buildPresentation(irPages, {});
  const buf = await pptx.write({ outputType: 'nodebuffer' });
  return JSZip.loadAsync(buf);
}

async function slideXml(zip, n = 1) {
  return zip.file(`ppt/slides/slide${n}.xml`).async('string');
}

// ---------------------------------------------------------------------------
// Per-line text emission (fake IR)
// ---------------------------------------------------------------------------

test('fake IR: 2-line paragraph emits 2 <a:t> separated by <a:br/>', async () => {
  const el = textElement('para');
  const ir = fakeIr([el], {
    para: {
      count: 2,
      rects: [{ x: 48, y: 100, w: 500, h: 27 }, { x: 48, y: 127, w: 400, h: 27 }],
      runs: [
        [run('第一行文字')],
        [run('第二行文字')],
      ],
    },
  });
  const zip = await convertToZip([ir]);
  const xml = await slideXml(zip);
  const tStart = xml.indexOf('<a:t>第一行文字');
  assert.ok(tStart >= 0, 'line 1 must be present');
  const tEnd = xml.indexOf('</a:t>', tStart);
  const nextT = xml.indexOf('<a:t>', tEnd);
  assert.ok(nextT >= 0, 'line 2 must be present');
  const between = xml.slice(tEnd, nextT);
  assert.match(between, /<a:br\/>/, 'lines must be separated by <a:br/>');
});

test('fake IR: runs split where computed style differs stay in one line', async () => {
  const el = textElement('para');
  const ir = fakeIr([el], {
    para: {
      count: 1,
      rects: [{ x: 48, y: 100, w: 500, h: 27 }],
      runs: [[
        run('普通'),
        run('加粗', { fontWeight: '700' }),
      ]],
    },
  });
  const zip = await convertToZip([ir]);
  const xml = await slideXml(zip);
  assert.match(xml, /<a:t>普通<\/a:t>/);
  assert.match(xml, /<a:t>加粗<\/a:t>/);
  // both runs in the same paragraph (no <a:br/> between them)
  const tStart = xml.indexOf('<a:t>普通');
  const tEnd = xml.indexOf('</a:t>', tStart);
  const nextT = xml.indexOf('<a:t>', tEnd);
  const between = xml.slice(tEnd, nextT);
  assert.doesNotMatch(between, /<a:br\/>/, 'runs within one line must not be line-broken');
  // the bold run carries b="1"
  const boldRun = xml.slice(xml.indexOf('<a:t>加粗') - 400, xml.indexOf('<a:t>加粗'));
  assert.match(boldRun, / b="1"/, 'bold run must carry b="1"');
});

test('fake IR: every text box has margin 0, explicit anchor, exact lineSpacing', async () => {
  const el = textElement('para');
  const ir = fakeIr([el], {
    para: {
      count: 1,
      rects: [{ x: 48, y: 100, w: 500, h: 27 }],
      runs: [[run('单行文字')]],
    },
  });
  const zip = await convertToZip([ir]);
  const xml = await slideXml(zip);
  assert.match(xml, /<a:bodyPr[^>]*lIns="0"/, 'bodyPr must contain lIns="0"');
  assert.match(xml, /<a:bodyPr[^>]*anchor="t"/, 'bodyPr must contain explicit anchor');
  // lineSpacing = lineHeightUsedPx(27.2) * 0.75 = 20.4pt → spcPts val="2040"
  assert.match(xml, /<a:lnSpc><a:spcPts val="2040"\/><\/a:lnSpc>/, 'lineSpacing must be exact pt');
});

test('fake IR: charSpacing = letterSpacingPx * 0.75 pt', async () => {
  const el = textElement('para');
  const ir = fakeIr([el], {
    para: {
      count: 1,
      rects: [{ x: 48, y: 100, w: 500, h: 27 }],
      runs: [[run('字距文字', { letterSpacingPx: 2 })]],
    },
  });
  const zip = await convertToZip([ir]);
  const xml = await slideXml(zip);
  // 2px * 0.75 = 1.5pt → spc="150"
  assert.match(xml, / spc="150" kern="0"/, 'charSpacing must be letterSpacingPx * 0.75 pt');
});

test('fake IR: lang="zh-CN" on runs', async () => {
  const el = textElement('para');
  const ir = fakeIr([el], {
    para: {
      count: 1,
      rects: [{ x: 48, y: 100, w: 500, h: 27 }],
      runs: [[run('中文运行')]],
    },
  });
  const zip = await convertToZip([ir]);
  const xml = await slideXml(zip);
  assert.match(xml, /<a:rPr lang="zh-CN"/, 'runs must carry lang="zh-CN"');
});

// ---------------------------------------------------------------------------
// Element mappers (fake IR)
// ---------------------------------------------------------------------------

test('fake IR: background shape XML appears before overlaid text', async () => {
  const bg = {
    pptId: 'bg',
    tag: 'div',
    rect: { x: 0, y: 0, w: 960, h: 540 },
    styles: baseStyles({ bg: 'rgb(20, 54, 92)', lineHeightUsedPx: 0 }),
    attrs: {},
  };
  const title = textElement('title', {
    tag: 'h1',
    rect: { x: 64, y: 200, w: 500, h: 67 },
    styles: baseStyles({ fontSizePx: 56, fontWeight: '700', lineHeightUsedPx: 67.2, fontBoundingBoxAscentPx: 50, fontBoundingBoxDescentPx: 12 }),
  });
  const ir = fakeIr([bg, title], {
    title: {
      count: 1,
      rects: [{ x: 64, y: 200, w: 500, h: 67 }],
      runs: [[run('技术架构演进', { fontSizePx: 56, fontWeight: '700' })]],
    },
  });
  const zip = await convertToZip([ir]);
  const xml = await slideXml(zip);
  const shapeIdx = xml.indexOf('prstGeom prst="rect"');
  const textIdx = xml.indexOf('<a:t>');
  assert.ok(shapeIdx >= 0, 'bg shape must be emitted');
  assert.ok(textIdx >= 0, 'title text must be emitted');
  assert.ok(shapeIdx < textIdx, 'bg shape XML must appear before its overlaid text');
});

test('fake IR: a[href] emits a hyperlink on its runs', async () => {
  const link = textElement('link', {
    tag: 'a',
    attrs: { href: 'https://example.com' },
  });
  const ir = fakeIr([link], {
    link: {
      count: 1,
      rects: [{ x: 48, y: 100, w: 200, h: 27 }],
      runs: [[run('访问官网')]],
    },
  });
  const zip = await convertToZip([ir]);
  const xml = await slideXml(zip);
  assert.match(xml, /<a:hlinkClick/, 'hyperlink must be emitted');
  assert.match(xml, /<a:t>访问官网<\/a:t>/);
});

test('fake IR: data-ppt-notes calls addNotes', async () => {
  const el = textElement('title', { attrs: { notes: '演讲备注内容' } });
  const ir = fakeIr([el], {
    title: {
      count: 1,
      rects: [{ x: 48, y: 100, w: 300, h: 27 }],
      runs: [[run('标题')]],
    },
  });
  const zip = await convertToZip([ir]);
  const notesXml = await zip.file('ppt/notesSlides/notesSlide1.xml').async('string');
  assert.match(notesXml, /演讲备注内容/, 'notes must be written to the notes slide');
});

test('fake IR: nested li gets a deeper indentLevel', async () => {
  const li1 = textElement('li-1', { tag: 'li', attrs: { depth: 1 } });
  const li2 = textElement('li-2', { tag: 'li', attrs: { depth: 2 } });
  const ir = fakeIr([li1, li2], {
    'li-1': { count: 1, rects: [{ x: 48, y: 100, w: 300, h: 27 }], runs: [[run('一级条目')]] },
    'li-2': { count: 1, rects: [{ x: 72, y: 130, w: 300, h: 27 }], runs: [[run('二级条目')]] },
  });
  const zip = await convertToZip([ir]);
  const xml = await slideXml(zip);
  // top-level li → lvl 0 (no lvl attr), nested li → lvl="1"
  assert.match(xml, /lvl="1"/, 'nested li must carry indentLevel 1');
  assert.match(xml, /<a:buChar/, 'li must carry a bullet');
});

test('fake IR: li with listType ol emits a numbered bullet (buAutoNum), not a char bullet', async () => {
  const li = textElement('li-1', { tag: 'li', attrs: { depth: 1, listType: 'ol' } });
  const ir = fakeIr([li], {
    'li-1': { count: 1, rects: [{ x: 48, y: 100, w: 300, h: 27 }], runs: [[run('第一条')]] },
  });
  const zip = await convertToZip([ir]);
  const xml = await slideXml(zip);
  assert.match(xml, /<a:buAutoNum/, 'ol li must emit a numbered bullet');
  assert.doesNotMatch(xml, /<a:buChar/, 'ol li must not emit a plain char bullet');
});

test('fake IR: img with object-fit cover emits a native picture', async () => {
  const img = {
    pptId: 'img-main',
    tag: 'img',
    rect: { x: 48, y: 100, w: 640, h: 360 },
    styles: baseStyles({ lineHeightUsedPx: 0 }),
    attrs: { src: path.join(CORPUS, 'assets', 'fixture-image.png'), objectFit: 'cover' },
  };
  const ir = fakeIr([img], {});
  const zip = await convertToZip([ir]);
  const xml = await slideXml(zip);
  assert.match(xml, /<p:pic>/, 'img must emit a native picture');
  assert.match(xml, /<a:srcRect/, 'cover sizing must emit a srcRect crop');
});

// ---------------------------------------------------------------------------
// Real corpus pages (renderPage → buildPresentation)
// ---------------------------------------------------------------------------

test('corpus 02: mixed paragraph emits 2 <a:t> separated by <a:br/> with YaHei runs', async () => {
  const ir = await renderCorpus('02.html');
  const zip = await convertToZip([ir]);
  const xml = await slideXml(zip);
  // para-mixed wraps to 2 lines in the browser; line 1 starts with 本季度
  const tStart = xml.indexOf('<a:t>本季度');
  assert.ok(tStart >= 0, 'para-mixed line 1 must be present');
  const tEnd = xml.indexOf('</a:t>', tStart);
  const nextT = xml.indexOf('<a:t>', tEnd);
  assert.ok(nextT >= 0, 'para-mixed line 2 must be present');
  const between = xml.slice(tEnd, nextT);
  assert.match(between, /<a:br\/>/, 'the two lines must be separated by <a:br/>');
  // bodyPr lIns="0"
  assert.match(xml, /<a:bodyPr[^>]*lIns="0"/, 'bodyPr must contain lIns="0"');
  // typeface="Microsoft YaHei" on runs
  assert.match(xml, /typeface="Microsoft YaHei"/, 'runs must use the resolved English font name');
  // every text box has an explicit anchor attribute
  const bodyPrs = xml.match(/<a:bodyPr[^>]*>/g) || [];
  assert.ok(bodyPrs.length >= 4, `corpus 02 has 4 text boxes, got ${bodyPrs.length}`);
  for (const bp of bodyPrs) {
    assert.match(bp, /anchor="[tctrb]"/, `bodyPr must have explicit anchor: ${bp}`);
  }
});

test('corpus 05: emission order is deterministic and puts bg div before title text', async () => {
  const ir = await renderCorpus('05.html');
  const sorted = sortElements(ir.elements);
  const ids = sorted.map((e) => e.pptId);
  assert.ok(ids.indexOf('bg-grad') < ids.indexOf('title'), `bg-grad must sort before title: ${ids.join(',')}`);
  // determinism: sorting twice yields the same order
  const sorted2 = sortElements(ir.elements);
  assert.deepEqual(ids, sorted2.map((e) => e.pptId));
});

test('corpus 01: solid-fill divs emit rect shapes', async () => {
  const ir = await renderCorpus('01.html');
  const zip = await convertToZip([ir]);
  const xml = await slideXml(zip);
  assert.match(xml, /prstGeom prst="rect"/, 'accent-bar/accent-line must emit rect shapes');
});

test('corpus 04: img emits a native picture', async () => {
  const ir = await renderCorpus('04.html');
  const zip = await convertToZip([ir]);
  const xml = await slideXml(zip);
  assert.match(xml, /<p:pic>/, 'img-main must emit a native picture');
});

test('all 12 corpus pages convert without throwing', async () => {
  const files = fs.readdirSync(PAGES).filter((f) => f.endsWith('.html')).sort();
  assert.equal(files.length, 12);
  for (const file of files) {
    const ir = await renderCorpus(file);
    const zip = await convertToZip([ir]);
    assert.ok(zip.file('ppt/slides/slide1.xml'), `${file} must produce slide1.xml`);
  }
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

test('IR missing lineHeightUsedPx throws a structured error', () => {
  const el = textElement('para');
  const ir = fakeIr([el], {
    para: {
      count: 1,
      rects: [{ x: 48, y: 100, w: 500, h: 27 }],
      runs: [[run('文字')]],
    },
  });
  delete ir.elements[0].styles.lineHeightUsedPx;
  assert.throws(() => buildPresentation([ir], {}), /lineHeightUsedPx/);
});

test('IR with lineSpacing below ascent+descent throws', () => {
  const el = textElement('para');
  const ir = fakeIr([el], {
    para: {
      count: 1,
      rects: [{ x: 48, y: 100, w: 500, h: 27 }],
      runs: [[run('文字')]],
    },
  });
  ir.elements[0].styles.lineHeightUsedPx = 10; // below ascent(16)+descent(4)
  assert.throws(() => buildPresentation([ir], {}), /ascent\+descent/);
});