'use strict';

/**
 * chart.test.js — native chart emission (data-ppt-chart).
 *
 * Corpus 06 (bar) and 07 (line) render through src/render.js and convert
 * through buildPresentation: the chart XML (ppt/charts/chart1.xml) must
 * contain the native c:barChart / c:lineChart element — never a rendered
 * image. The chart-pie fixture (type "pie") must throw the structured
 * {rule:"chart-type-unsupported"} error.
 *
 * Anti-hang discipline: every renderPage call is raced against a 30s timer;
 * the shared browser is closed in after().
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const JSZip = require('jszip');
const { chromium } = require('playwright');
const { renderPage } = require('../src/render.js');
const { buildPresentation } = require('../src/convert/page.js');

const CORPUS = path.join(__dirname, '..', 'corpus');
const PAGES = path.join(CORPUS, 'pages');
const FIXTURES = path.join(__dirname, 'fixtures');
const RENDER_TIMEOUT_MS = 30000;

// Business blue-gold palette (matches skill/references/design-system.md §1.1).
const TOKENS = {
  palette: {
    bg: '#F5F7FA',
    surface: '#FFFFFF',
    primary: '#1F4E79',
    accent: '#C9A227',
    text: '#1A1A1A',
    muted: '#6B7280',
    primaryLight: '#3A6EA5',
    primaryDark: '#14365C',
    accentLight: '#DDBB4F',
    accentDark: '#A07F1B',
  },
  fonts: {
    heading: 'Microsoft YaHei',
    body: 'DengXian',
    chart: 'Microsoft YaHei',
  },
};

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

async function renderCorpus(file) {
  const ir = await withTimeout(renderPage(path.join(PAGES, file), { browser }), RENDER_TIMEOUT_MS, `render ${file}`);
  assert.equal(ir.errors.length, 0, `${file} must render with zero errors: ${JSON.stringify(ir.errors)}`);
  return ir;
}

async function convertToZip(irPages) {
  const pptx = buildPresentation(irPages, TOKENS);
  const buf = await pptx.write({ outputType: 'nodebuffer' });
  return JSZip.loadAsync(buf);
}

// pptxgenjs names chart files chartN.xml with a process-global counter, so the
// exact N depends on how many charts were created earlier in this process.
async function readChartXml(zip) {
  const name = Object.keys(zip.files).find((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
  assert.ok(name, `chart XML must exist, got: ${Object.keys(zip.files).filter((n) => n.includes('chart')).join(',')}`);
  return zip.file(name).async('string');
}

test('corpus 06: bar chart emits a native c:barChart with labels and series', async () => {
  const ir = await renderCorpus('06.html');
  const zip = await convertToZip([ir]);
  const chartXml = await readChartXml(zip);
  assert.match(chartXml, /<c:barChart>/, 'bar chart must be a native c:barChart');
  assert.match(chartXml, /<c:v>Q1<\/c:v>/, 'category labels must be present');
  assert.match(chartXml, /<c:v>营收<\/c:v>/, 'series name must be present');
  assert.match(chartXml, /<c:v>42<\/c:v>/, 'series values must be present');
  // The slide references the chart natively (not an image).
  const slideXml = await zip.file('ppt/slides/slide1.xml').async('string');
  assert.match(slideXml, /<c:chart r:id=/, 'slide must reference the native chart');
});

test('corpus 07: line chart emits a native c:lineChart', async () => {
  const ir = await renderCorpus('07.html');
  const zip = await convertToZip([ir]);
  const chartXml = await readChartXml(zip);
  assert.match(chartXml, /<c:lineChart>/, 'line chart must be a native c:lineChart');
  assert.match(chartXml, /<c:v>活跃用户<\/c:v>/, 'first series name must be present');
  assert.match(chartXml, /<c:v>新增用户<\/c:v>/, 'second series name must be present');
});

test('chart-pie fixture: unsupported type throws chart-type-unsupported', async () => {
  const ir = await withTimeout(renderPage(path.join(FIXTURES, 'chart-pie.html'), { browser }), RENDER_TIMEOUT_MS, 'render chart-pie');
  assert.equal(ir.errors.length, 0, `fixture must render with zero errors: ${JSON.stringify(ir.errors)}`);

  let caught = null;
  try {
    buildPresentation([ir], TOKENS);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'buildPresentation must throw for an unsupported chart type');
  const m = caught.message.match(/\{.*\}/s);
  assert.ok(m, `error message must embed structured JSON: ${caught.message}`);
  const err = JSON.parse(m[0]);
  assert.equal(err.rule, 'chart-type-unsupported');
  assert.equal(err['data-ppt-id'], 'chart-pie');
  assert.equal(err.page, 'chart-pie.html');
  assert.equal(err.measured, 'pie');
  assert.equal(err.available, 'bar, line');
  assert.match(err.suggested_fix, /bar\/line/);
});