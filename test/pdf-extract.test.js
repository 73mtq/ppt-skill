'use strict';

/**
 * pdf-extract tests (pdf-intake plan, todo 3).
 *
 * Fixture provenance: test/fixtures/sample.pdf is a HAND-AUTHORED minimal
 * single-page PDF (963 bytes) built by a one-shot node generator script that
 * computed xref offsets directly (no soffice/LibreOffice, no external
 * service). The generator was deleted after the fixture was committed; the
 * fixture is a static file, never regenerated at test time. Its known text:
 * ASCII "PPT-ENGINE PDF FIXTURE" (Type1 Helvetica) + CJK "余华测试"
 * (Type0/UniJIS-UCS2-H, UTF-16BE hex string).
 *
 * Coverage:
 *   - usage errors -> exit 2 (missing --in, --pages 3-1, --pages abc, --bogus)
 *   - PDF_NOT_FOUND -> exit 1 + structured error (--json)
 *   - NOT_A_PDF -> exit 1 + structured error (--json)
 *   - POPPLER_NOT_FOUND -> exit 1 via --poppler-dir <empty dir>; passes on ANY
 *     machine because --poppler-dir override takes precedence over PATH
 *     (regression guard for the resolution order).
 *   - integration (t.skip when poppler missing, corpus-gate pattern):
 *     full extraction of the fixture + --pages 1 single-page extraction.
 *
 * Uses node:test + node:assert (no third-party test framework).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findOnPath, PDFTOPPM_DIRS } = require('../src/doctor');

const BIN = path.join(__dirname, '..', 'bin', 'ppt-engine.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'sample.pdf');
const NOT_PDF = path.join(__dirname, 'fixtures', 'bad-element.html');

const KNOWN_ASCII = 'PPT-ENGINE PDF FIXTURE';
const KNOWN_CJK = '余华测试';

function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 30000,
  });
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Whitespace-insensitive contains: pdftotext may insert line breaks/spaces
// around glyphs, so compare with all whitespace stripped.
function containsText(txt, needle) {
  return String(txt).replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''));
}

// Poppler bin dir: PATH first, then doctor's known install dirs (full exe
// paths). Mirrors corpus-gate's findTool + t.skip pattern.
function findPopplerDir() {
  const onPath = findOnPath('pdftoppm');
  if (onPath) return path.dirname(onPath);
  for (const exe of PDFTOPPM_DIRS) {
    if (fs.existsSync(exe)) return path.dirname(exe);
  }
  return null;
}

// --- usage errors -> exit 2 -------------------------------------------------

test('usage: missing --in exits 2', () => {
  const res = runCli(['pdf-extract']);
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}\nstderr: ${res.stderr}`);
  assert.match(res.stderr, /--in/);
});

test('usage: --pages 3-1 exits 2', () => {
  const res = runCli(['pdf-extract', '--in', FIXTURE, '--pages', '3-1']);
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}\nstderr: ${res.stderr}`);
  assert.match(res.stderr, /invalid --pages/);
});

test('usage: --pages abc exits 2', () => {
  const res = runCli(['pdf-extract', '--in', FIXTURE, '--pages', 'abc']);
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}\nstderr: ${res.stderr}`);
  assert.match(res.stderr, /invalid --pages/);
});

test('usage: unknown flag --bogus exits 2', () => {
  const res = runCli(['pdf-extract', '--in', FIXTURE, '--bogus']);
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}\nstderr: ${res.stderr}`);
  assert.match(res.stderr, /unknown flag/);
});

// --- operational errors -> exit 1 + structured error ------------------------

test('PDF_NOT_FOUND: nonexistent --in exits 1 with structured error', (t) => {
  const outDir = mkTmp('ppt-extract-notfound-');
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const missing = path.join(outDir, 'no-such.pdf');
  const res = runCli(['pdf-extract', '--in', missing, '--out', outDir, '--json']);
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}\nstderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'PDF_NOT_FOUND');
  assert.ok(out.error.detail.includes('no-such.pdf'), `detail must name the file: ${out.error.detail}`);
  assert.ok(out.error.fix.length > 0, 'error must carry a fix hint');
});

test('NOT_A_PDF: --in pointing at an HTML file exits 1 with structured error', (t) => {
  const outDir = mkTmp('ppt-extract-notpdf-');
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const res = runCli(['pdf-extract', '--in', NOT_PDF, '--out', outDir, '--json']);
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}\nstderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'NOT_A_PDF');
  assert.match(out.error.detail, /%PDF/);
});

test('POPPLER_NOT_FOUND: --poppler-dir <empty dir> exits 1 even when poppler is on PATH', (t) => {
  const emptyDir = mkTmp('ppt-extract-empty-');
  t.after(() => fs.rmSync(emptyDir, { recursive: true, force: true }));
  const outDir = mkTmp('ppt-extract-ppnf-');
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const res = runCli(['pdf-extract', '--in', FIXTURE, '--out', outDir, '--poppler-dir', emptyDir, '--json']);
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}\nstderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'POPPLER_NOT_FOUND');
  assert.ok(out.error.detail.includes(emptyDir), `detail must name the override dir: ${out.error.detail}`);
});

// --- integration (skipped when poppler unavailable) -------------------------

test('integration: extract sample.pdf (skipped when poppler missing)', (t) => {
  const binDir = findPopplerDir();
  if (!binDir) {
    t.skip('poppler not found');
    return;
  }
  const outDir = mkTmp('ppt-extract-ok-');
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const res = runCli(['pdf-extract', '--in', FIXTURE, '--out', outDir, '--poppler-dir', binDir, '--json']);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.pageCount, 1);
  assert.equal(out.pages[0].n, 1);

  const png = path.join(outDir, 'pages', '01.png');
  assert.ok(fs.existsSync(png), 'pages/01.png must exist');
  assert.ok(fs.statSync(png).size > 0, 'pages/01.png must be non-empty');

  const txt = fs.readFileSync(path.join(outDir, 'text', '01.txt'), 'utf8');
  assert.ok(containsText(txt, KNOWN_ASCII), `text/01.txt must contain "${KNOWN_ASCII}", got: ${txt}`);
  assert.ok(containsText(txt, KNOWN_CJK), `text/01.txt must contain "${KNOWN_CJK}", got: ${txt}`);

  const reportFile = JSON.parse(fs.readFileSync(path.join(outDir, 'extract-report.json'), 'utf8'));
  assert.equal(reportFile.ok, true);
  assert.equal(reportFile.pageCount, 1);
});

test('integration: --pages 1 single-page extraction (skipped when poppler missing)', (t) => {
  const binDir = findPopplerDir();
  if (!binDir) {
    t.skip('poppler not found');
    return;
  }
  const outDir = mkTmp('ppt-extract-p1-');
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const res = runCli(['pdf-extract', '--in', FIXTURE, '--out', outDir, '--pages', '1', '--poppler-dir', binDir, '--json']);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.pageCount, 1);
  assert.equal(out.pages[0].n, 1);
  assert.ok(fs.existsSync(path.join(outDir, 'pages', '01.png')), 'pages/01.png must exist');
  assert.ok(fs.existsSync(path.join(outDir, 'text', '01.txt')), 'text/01.txt must exist');
});