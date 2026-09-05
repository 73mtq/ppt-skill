'use strict';

/**
 * corpus-gate.test.js — golden-corpus pipeline gate (todo 9).
 *
 * Runs the FULL in-process pipeline over all 12 golden corpus pages:
 *
 *   renderPage → validateHtmlIR → buildPresentation → validatePptx
 *
 * and asserts:
 *   1. zero errors AND zero warnings on every rendered page;
 *   2. per-page line counts / total text runs match corpus/expected.json;
 *   3. the generated deck.pptx unpacks (JSZip) to slide XML whose text runs,
 *      chart types and image counts match corpus/expected.json;
 *   4. no shape is out of bounds (validatePptx surfaces these as errors).
 *
 * Optional pixel-diff gate: when doctor detects BOTH soffice AND pdftoppm, the
 * deck is rendered to PDF → PNG and compared against 96dpi HTML screenshots
 * with pixelmatch (≤5% diff pixels per page). When either tool is missing the
 * test is SKIPPED with an explicit reason — never failed, never faked.
 *
 * Anti-hang discipline: every renderPage call is raced against a 30s timer;
 * the shared browser is closed in after(); soffice/pdftoppm are one-shot
 * spawnSync subprocesses with explicit timeouts.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const JSZip = require('jszip');
const { chromium } = require('playwright');
// pixelmatch 7.x is ESM ("type":"module"); require() returns {default: fn}.
const pixelmatch = require('pixelmatch').default || require('pixelmatch');
const { PNG } = require('pngjs');
const { renderPage } = require('../src/render.js');
const { buildPresentation } = require('../src/convert/page.js');
const { validateHtmlIR } = require('../src/validate/tokens-html.js');
const { validatePptx } = require('../src/validate/pptx.js');
const { findOnPath, PDFTOPPM_DIRS } = require('../src/doctor');

const BIN = path.join(__dirname, '..', 'bin', 'ppt-engine.js');
const CORPUS = path.join(__dirname, '..', 'corpus');
const PAGES = path.join(CORPUS, 'pages');
const TOKENS_PATH = path.join(__dirname, '..', 'tokens', 'default.json');
const RENDER_TIMEOUT_MS = 30000;
const TOOL_TIMEOUT_MS = 120000;
const CLI_TIMEOUT_MS = 180000;
const MAX_DIFF_RATIO = 0.05; // ≤5% diff pixels per page

const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(CORPUS, 'expected.json'), 'utf8'));

// SOFFICE_DIRS is not exported by src/doctor.js; PDFTOPPM_DIRS is imported above.
const SOFFICE_DIRS = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
];

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function toFileUrl(absPath) {
  const forward = absPath.replace(/\\/g, '/');
  const prefix = forward.startsWith('/') ? '' : '///';
  return 'file://' + prefix + encodeURI(forward);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function findTool(exe, dirs) {
  return findOnPath(exe) || dirs.find((d) => fs.existsSync(d)) || null;
}

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Every <a:t> text in a slide XML (unescaped + whitespace-normalized).
function extractATexts(xml) {
  const out = [];
  const re = /<a:t>([^<]*)<\/a:t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = normalizeText(unescapeXml(m[1]));
    if (t) out.push(t);
  }
  return out;
}

// Every per-line run text from the IR (the convert layer emits each run as its
// own <a:t>, so this is the exact multiset the slide XML must contain).
function collectRunTexts(ir) {
  const texts = [];
  for (const lineData of Object.values(ir.lines || {})) {
    if (!Array.isArray(lineData.runs)) continue;
    for (const line of lineData.runs) {
      for (const run of line) {
        const t = normalizeText(run.text);
        if (t) texts.push(t);
      }
    }
  }
  return texts;
}

// Chart type of a slide: follow the slide's rels to its chart part and inspect
// the chart XML for c:barChart / c:lineChart. 'none' when no chart is linked.
async function chartTypeForSlide(zip, slideIndex) {
  const relsEntry = zip.file(`ppt/slides/_rels/slide${slideIndex}.xml.rels`);
  if (!relsEntry) return 'none';
  const relsXml = await relsEntry.async('string');
  const m = /Target="([^"]*chart[^"]*\.xml)"/.exec(relsXml);
  if (!m) return 'none';
  const target = m[1];
  const chartPath = target.startsWith('/')
    ? target.replace(/^\//, '')
    : path.posix.normalize('ppt/slides/' + target);
  const chartEntry = zip.file(chartPath);
  if (!chartEntry) return 'none';
  const chartXml = await chartEntry.async('string');
  if (/c:barChart/.test(chartXml)) return 'bar';
  if (/c:lineChart/.test(chartXml)) return 'line';
  return 'none';
}

// One-shot 96dpi-equivalent screenshot (viewport 960x540 CSS px at
// deviceScaleFactor 1 → 960x540 PNG, matching pdftoppm -r 96 output).
async function screenshotPage(htmlPath, browser) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  try {
    await page.goto(toFileUrl(path.resolve(htmlPath)), { waitUntil: 'networkidle', timeout: 30000 });
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });
    await page.evaluate((timeoutMs) => Promise.race([
      document.fonts.ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]), 10000);
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    return await page.screenshot({ type: 'png' });
  } finally {
    await page.close();
  }
}

// Fraction of differing pixels between two same-size PNG buffers.
function diffRatio(img1Buf, img2Buf) {
  const png1 = PNG.sync.read(img1Buf);
  const png2 = PNG.sync.read(img2Buf);
  assert.equal(png1.width, png2.width, 'PNG widths must match');
  assert.equal(png1.height, png2.height, 'PNG heights must match');
  const { width, height } = png1;
  const diff = new PNG({ width, height });
  const n = pixelmatch(png1.data, png2.data, diff.data, width, height, { threshold: 0.1 });
  return n / (width * height);
}

function convertToPdf(sofficePath, deckPath, outDir) {
  const res = spawnSync(sofficePath, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, deckPath], {
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
  });
  assert.equal(res.status, 0, `soffice failed (${res.status}): ${res.stderr || res.stdout}`);
  const pdf = path.join(outDir, path.basename(deckPath, '.pptx') + '.pdf');
  assert.ok(fs.existsSync(pdf), 'soffice must produce a PDF');
  return pdf;
}

function pdfToPngs(pdftoppmPath, pdfPath, outDir) {
  const prefix = path.join(outDir, 'page');
  const res = spawnSync(pdftoppmPath, ['-png', '-r', '96', pdfPath, prefix], {
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
  });
  assert.equal(res.status, 0, `pdftoppm failed (${res.status}): ${res.stderr || res.stdout}`);
  const pngs = fs.readdirSync(outDir)
    .filter((f) => /^page-\d+\.png$/.test(f))
    .sort()
    .map((f) => path.join(outDir, f));
  assert.equal(pngs.length, 12, `expected 12 page PNGs, got ${pngs.length}`);
  return pngs;
}

let browser;
let irPages = [];
let deckBuf = null;

before(async () => {
  browser = await chromium.launch({ headless: true });
  const files = fs.readdirSync(PAGES).filter((f) => f.endsWith('.html')).sort();
  assert.equal(files.length, 12, 'corpus must have exactly 12 pages');
  for (const file of files) {
    const ir = await withTimeout(
      renderPage(path.join(PAGES, file), { browser }),
      RENDER_TIMEOUT_MS,
      `render ${file}`
    );
    irPages.push(ir);
  }
});

after(async () => {
  if (browser) await browser.close();
});

// ---------------------------------------------------------------------------
// Core gate: render → validate-html → convert → validate
// ---------------------------------------------------------------------------

test('gate: all 12 corpus pages render with zero errors and zero warnings', () => {
  assert.equal(irPages.length, 12);
  for (const ir of irPages) {
    assert.deepEqual(ir.errors, [], `${ir.page} must render with zero errors`);
    assert.deepEqual(ir.warnings, [], `${ir.page} must render with zero warnings`);
  }
});

test('gate: validateHtmlIR passes all 12 pages with zero errors', () => {
  for (const ir of irPages) {
    const errors = validateHtmlIR(ir, tokens);
    assert.deepEqual(errors, [], `${ir.page} must pass HTML validation: ${JSON.stringify(errors)}`);
  }
});

test('gate: per-page line counts and total text runs match corpus/expected.json', () => {
  for (const ir of irPages) {
    const exp = expected.pages.find((p) => p.file === ir.page);
    assert.ok(exp, `expected.json must have an entry for ${ir.page}`);
    // Every expected text block must exist with the exact line count.
    for (const [pptId, count] of Object.entries(exp.textLineCounts)) {
      const lineData = ir.lines[pptId];
      assert.ok(lineData, `${ir.page}: expected text block "${pptId}" missing from IR`);
      assert.equal(lineData.count, count, `${ir.page}: "${pptId}" line count`);
    }
    // No extra text blocks beyond expected (count > 0 only).
    const expectedIds = new Set(Object.keys(exp.textLineCounts));
    for (const [pptId, lineData] of Object.entries(ir.lines)) {
      if (lineData.count > 0) {
        assert.ok(expectedIds.has(pptId), `${ir.page}: unexpected text block "${pptId}" in IR`);
      }
    }
    // totalTextRuns = number of text blocks with at least one line.
    const textBlocks = Object.values(ir.lines).filter((l) => l.count > 0).length;
    assert.equal(textBlocks, exp.totalTextRuns, `${ir.page}: totalTextRuns`);
  }
});

test('gate: full pipeline produces a deck that passes validatePptx (zero errors, no out-of-bounds)', async () => {
  const pptx = buildPresentation(irPages, tokens);
  deckBuf = await pptx.write({ outputType: 'nodebuffer' });
  const result = await validatePptx(deckBuf, irPages, tokens);
  assert.equal(result.ok, true, `validatePptx must pass: ${JSON.stringify(result.errors)}`);
  assert.deepEqual(result.errors, []);
});

test('gate: slide XML text runs, chart types and image counts match corpus/expected.json', async () => {
  assert.ok(deckBuf, 'deck must be built before unpacking');
  const zip = await JSZip.loadAsync(deckBuf);
  for (let i = 0; i < irPages.length; i++) {
    const ir = irPages[i];
    const exp = expected.pages.find((p) => p.file === ir.page);
    assert.ok(exp, `expected.json must have an entry for ${ir.page}`);
    const slideFile = `ppt/slides/slide${i + 1}.xml`;
    const slideEntry = zip.file(slideFile);
    assert.ok(slideEntry, `${ir.page}: ${slideFile} must exist`);
    const xml = await slideEntry.async('string');

    // 1. Text content: the multiset of <a:t> runs equals the IR run texts.
    const xmlTexts = extractATexts(xml).sort();
    const irTexts = collectRunTexts(ir).sort();
    assert.deepEqual(xmlTexts, irTexts, `${ir.page}: slide XML text runs must match IR run texts`);

    // 2. Chart type (bar/line/none) via the slide's chart relationship.
    const chartType = await chartTypeForSlide(zip, i + 1);
    assert.equal(chartType, exp.chartType, `${ir.page}: chart type`);

    // 3. Image count = number of <p:pic> shapes.
    const picCount = (xml.match(/<p:pic>/g) || []).length;
    assert.equal(picCount, exp.imageCount, `${ir.page}: image count`);
  }
});

// ---------------------------------------------------------------------------
// End-to-end sanity: one CLI convert run (cli-project.test.js owns the full
// CLI matrix; this is a single cross-check that the in-process gate pipeline
// matches the CLI's behavior on the same corpus).
// ---------------------------------------------------------------------------

test('gate: CLI convert on a temp corpus copy exits 0 with zero errors (end-to-end sanity)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gate-cli-'));
  try {
    copyDir(CORPUS, tmp);
    const res = spawnSync(process.execPath, [BIN, 'convert', '--project', tmp, '--json'], {
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
    });
    assert.equal(res.status, 0, `convert must exit 0, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const report = JSON.parse(res.stdout);
    assert.equal(report.pages.length, 12, 'report must have 12 page entries');
    assert.equal(report['errors:total'], 0, `zero errors expected: ${JSON.stringify(report.pages.map((p) => p.errors))}`);
    assert.equal(report['warnings:total'], 0, `zero warnings expected: ${JSON.stringify(report.pages.map((p) => p.warnings))}`);
    assert.equal(report.ok, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    const outDir = path.join(path.dirname(tmp), 'out', path.basename(tmp));
    if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Optional pixel-diff gate (skipped when soffice/pdftoppm are missing)
// ---------------------------------------------------------------------------

test('gate: pixel-diff vs LibreOffice render (skipped when soffice/pdftoppm missing)', async (t) => {
  const soffice = findTool('soffice', SOFFICE_DIRS);
  const pdftoppm = findTool('pdftoppm', PDFTOPPM_DIRS);
  if (!soffice || !pdftoppm) {
    const missing = [soffice ? null : 'soffice', pdftoppm ? null : 'pdftoppm'].filter(Boolean).join(', ');
    t.skip(`pixel-diff gate skipped: ${missing} not found`);
    return;
  }
  assert.ok(deckBuf, 'deck must be built before the pixel-diff gate');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gate-pix-'));
  try {
    const deckPath = path.join(tmp, 'deck.pptx');
    fs.writeFileSync(deckPath, deckBuf);
    const pdf = convertToPdf(soffice, deckPath, tmp);
    const pngs = pdfToPngs(pdftoppm, pdf, tmp);
    const files = fs.readdirSync(PAGES).filter((f) => f.endsWith('.html')).sort();
    assert.equal(pngs.length, files.length, 'one PNG per page');
    for (let i = 0; i < files.length; i++) {
      const htmlPng = await withTimeout(
        screenshotPage(path.join(PAGES, files[i]), browser),
        RENDER_TIMEOUT_MS,
        `screenshot ${files[i]}`
      );
      const ratio = diffRatio(htmlPng, fs.readFileSync(pngs[i]));
      assert.ok(
        ratio <= MAX_DIFF_RATIO,
        `${files[i]}: pixel diff ${(ratio * 100).toFixed(2)}% exceeds ${MAX_DIFF_RATIO * 100}%`
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});