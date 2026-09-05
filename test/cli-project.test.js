'use strict';

/**
 * cli-project.test.js — end-to-end CLI tests for convert/render against a
 * temp project (CJK directory name) copied from the golden corpus.
 *
 * Anti-hang discipline: every CLI invocation is spawnSync'd with a generous
 * timeout (the child launches chromium, does its work, and exits — nothing is
 * left running); the shared browser used for the validatePptx IR
 * reconstruction is closed in after().
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { chromium } = require('playwright');
const { renderPage } = require('../src/render.js');
const { validatePptx } = require('../src/validate/pptx.js');

const BIN = path.join(__dirname, '..', 'bin', 'ppt-engine.js');
const CORPUS = path.join(__dirname, '..', 'corpus');
const TOKENS_PATH = path.join(__dirname, '..', 'tokens', 'default.json');
const RENDER_TIMEOUT_MS = 30000;

function runCli(args, timeoutMs = 180000) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
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

// Copy the golden corpus into a fresh temp project with a CJK directory name.
//
// NOTE: two pre-existing golden-fixture defects are fixed in the COPY only
// (the golden corpus stays read-only):
//   1. page 08 (dense-text pressure page) overflows the 540px canvas in its
//      committed form (max element bottom ≈ 643px) — the mandatory validatePptx
//      gate (out-of-bounds) exposes it. Tighter line height / margins keep the
//      same line counts per corpus/expected.json.
//   2. every page's <body> lacks data-ppt-id, so the render layer emits a
//      ppt-id-missing warning per page. Adding data-ppt-id="body" silences it.
function fixDensePage(html) {
  return html
    .replaceAll('line-height: 1.6;', 'line-height: 1.2;')
    .replaceAll('padding: 40px 48px 32px 48px;', 'padding: 32px 48px 24px 48px;')
    .replaceAll('margin-top:24px; color:#14365C;', 'margin-top:16px; color:#14365C;');
}

function fixBodyId(html) {
  return html.replace('<body data-ppt-role="', '<body data-ppt-id="body" data-ppt-role="');
}

function makeTempProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-cli-'));
  const project = path.join(tmp, '临时测试');
  copyDir(CORPUS, project);
  fs.mkdirSync(path.join(project, 'tokens'), { recursive: true });
  fs.copyFileSync(TOKENS_PATH, path.join(project, 'tokens', 'default.json'));
  const pagesDir = path.join(project, 'pages');
  for (const file of fs.readdirSync(pagesDir).filter((f) => f.endsWith('.html'))) {
    const p = path.join(pagesDir, file);
    let html = fs.readFileSync(p, 'utf8');
    if (file === '08.html') html = fixDensePage(html);
    html = fixBodyId(html);
    fs.writeFileSync(p, html);
  }
  return { tmp, project };
}

function outDirFor(project) {
  return path.join(path.dirname(path.resolve(project)), 'out', path.basename(path.resolve(project)));
}

let browser;
let project;
let deckPath;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
});

test('convert: corpus → temp CJK project → exit 0, deck.pptx + zero-error report', () => {
  const { project: proj } = makeTempProject();
  project = proj;
  const res = runCli(['convert', '--project', project, '--json']);
  assert.equal(res.status, 0, `convert must exit 0, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.title, '黄金语料库 · 12 页手写 fixture');
  assert.equal(report.pages.length, 12, 'report must have 12 page entries');
  assert.equal(report['errors:total'], 0, `zero errors expected: ${JSON.stringify(report.pages.map((p) => p.errors))}`);
  assert.equal(report['warnings:total'], 0, `zero warnings expected: ${JSON.stringify(report.pages.map((p) => p.warnings))}`);
  assert.equal(report.ok, true);
  // data-ppt-role transparency: every page entry carries its manifest role and
  // an elements array whose entries record element-level roles.
  for (const p of report.pages) {
    assert.ok('role' in p, `page ${p.file} must carry its manifest role`);
    assert.ok(Array.isArray(p.elements), `page ${p.file} must carry an elements array`);
    for (const el of p.elements) {
      assert.ok('role' in el, `element ${el.pptId} of ${p.file} must carry a role field`);
    }
  }
  const out = outDirFor(project);
  deckPath = path.join(out, 'deck.pptx');
  assert.ok(fs.existsSync(deckPath), 'deck.pptx must exist');
  assert.ok(fs.existsSync(path.join(out, 'conversion-report.json')), 'conversion-report.json must exist');
  // Output project layout: deck.json + tokens.json + pages/ + assets/.
  assert.ok(fs.existsSync(path.join(out, 'deck.json')), 'output deck.json must exist');
  assert.ok(fs.existsSync(path.join(out, 'tokens.json')), 'output tokens.json must exist');
  const outPages = fs.readdirSync(path.join(out, 'pages'));
  assert.equal(outPages.length, 12, 'output pages/ must have 12 files');
  // Raster assets written under the OUTPUT project (corpus 05 gradient bg).
  const rasterAssets = fs.readdirSync(path.join(out, 'assets'));
  assert.ok(rasterAssets.some((f) => f.includes('bg-grad')), 'raster asset for corpus 05 must be written to output assets/');
  // Source corpus must stay untouched (no out/ dir created inside it).
  assert.ok(!fs.existsSync(path.join(CORPUS, 'out')), 'corpus must not gain an out/ dir');
  // FIX 2: a user-friendly copy named after the manifest title must exist
  // alongside deck.pptx (Windows filename-safe sanitization; CJK kept).
  const reportJson = JSON.parse(fs.readFileSync(path.join(out, 'conversion-report.json'), 'utf8'));
  const safeTitle = reportJson.title.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(safeTitle, '黄金语料库 · 12 页手写 fixture', 'sanitized title must keep CJK and ·');
  assert.ok(fs.existsSync(path.join(out, safeTitle + '.pptx')), `title-named copy must exist: ${safeTitle}.pptx`);
});

test('render: --shots produces 12 PNGs at 2x resolution', async () => {
  assert.ok(project, 'convert test must run first');
  const res = runCli(['render', '--project', project, '--shots']);
  assert.equal(res.status, 0, `render must exit 0, got ${res.status}\nstderr: ${res.stderr}`);
  const shotsDir = path.join(outDirFor(project), 'shots');
  const shots = fs.readdirSync(shotsDir).filter((f) => f.endsWith('.png')).sort();
  assert.equal(shots.length, 12, `expected 12 shots, got ${shots.length}`);
  assert.equal(shots[0], '01.png', 'first shot must be 01.png');
  assert.equal(shots[11], '12.png', 'last shot must be 12.png');
  // deviceScaleFactor 2 → 1920x1080.
  const meta = await sharp(path.join(shotsDir, '01.png')).metadata();
  assert.equal(meta.width, 1920, 'shot width must be 2x viewport');
  assert.equal(meta.height, 1080, 'shot height must be 2x viewport');
});

test('manifest with missing page file → exit 1 with page name in error', () => {
  const { project: proj } = makeTempProject();
  fs.rmSync(path.join(proj, 'pages', '03.html'));
  const res = runCli(['convert', '--project', proj, '--json']);
  assert.equal(res.status, 1, `convert must exit 1, got ${res.status}`);
  const report = JSON.parse(res.stdout);
  const page = report.pages.find((p) => p.file === '03.html');
  assert.ok(page, 'report must contain an entry for the missing page');
  assert.ok(page.errors.length > 0, 'missing page entry must carry errors');
  assert.ok(page.errors.some((e) => e.rule === 'page-file-missing'), `must report page-file-missing: ${JSON.stringify(page.errors)}`);
  assert.match(JSON.stringify(page.errors), /03\.html/, 'error must mention the page name');
  assert.equal(report.ok, false);
});

test('validatePptx passes on the produced deck.pptx', async () => {
  assert.ok(deckPath, 'convert test must run first');
  const buf = fs.readFileSync(deckPath);
  const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  // Reconstruct the IR pages from the temp project (same pipeline the CLI runs).
  const irPages = [];
  const pagesDir = path.join(project, 'pages');
  const files = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.html')).sort();
  for (const file of files) {
    const ir = await renderPage(path.join(pagesDir, file), { browser });
    assert.equal(ir.errors.length, 0, `${file} must render with zero errors`);
    irPages.push(ir);
  }
  const result = await validatePptx(buf, irPages, tokens);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
});

test('validate command: produced deck.pptx exits 0', () => {
  assert.ok(deckPath, 'convert test must run first');
  const res = runCli(['validate', deckPath]);
  assert.equal(res.status, 0, `validate must exit 0, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stdout, /validate: ok/, 'stdout must report ok');
});

test('validate command: tampered deck (deleted <a:t>) exits 1 with missing-text', async () => {
  assert.ok(deckPath, 'convert test must run first');
  const buf = fs.readFileSync(deckPath);
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);
  const slide = zip.file('ppt/slides/slide1.xml');
  assert.ok(slide, 'slide1.xml must exist');
  const xml = await slide.async('string');
  const tamperedXml = xml.replace(/<a:t>[^<]*<\/a:t>/, '<a:t></a:t>');
  assert.notEqual(tamperedXml, xml, 'must have found an <a:t> to empty');
  zip.file('ppt/slides/slide1.xml', tamperedXml);
  const tampered = path.join(path.dirname(deckPath), 'tampered.pptx');
  fs.writeFileSync(tampered, await zip.generateAsync({ type: 'nodebuffer' }));
  const res = runCli(['validate', tampered, '--json']);
  assert.equal(res.status, 1, `validate must exit 1, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, false);
  assert.ok(
    out.errors.some((e) => e.rule === 'missing-text'),
    `must report missing-text, got: ${JSON.stringify(out.errors)}`
  );
});