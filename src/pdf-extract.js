'use strict';

/**
 * pdf-extract — PDF intake extraction module (pdf-intake plan, todo 1).
 *
 * Turns a PDF into per-page PNGs (pdftoppm) + per-page text (pdftotext,
 * single pass split on \f) + extract-report.json, so the engine never has to
 * feed a raw PDF to a model.
 *
 * Poppler resolution order (Metis #1/#5):
 *   1. --poppler-dir override FIRST — the dir MUST contain BOTH pdftoppm.exe
 *      and pdftotext.exe; if either is missing → POPPLER_NOT_FOUND (PATH is
 *      ignored, the override wins).
 *   2. PATH lookup via doctor.findOnPath('pdftoppm').
 *   3. doctor.PDFTOPPM_DIRS — entries are FULL exe paths; pdftotext is derived
 *      from the same directory via path.dirname.
 *
 * Exit codes: 0 success / 2 usage & argument errors / 1 operational errors.
 * Error schema: { ok:false, error:{ code, detail, fix } } with code ∈
 * POPPLER_NOT_FOUND | PDF_NOT_FOUND | NOT_A_PDF | EXTRACT_FAILED.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const doctor = require('./doctor.js');

const POPPLER_FIX =
  'Install Poppler (https://github.com/oschwartz10612/poppler-windows) and pass ' +
  '--poppler-dir <bin dir> pointing at the directory containing both pdftoppm.exe and pdftotext.exe.';

const DPI_MIN = 72;
const DPI_MAX = 300;
const DPI_DEFAULT = 150;
const TOOL_TIMEOUT_MS = 120000;

/**
 * Resolve the Poppler binaries. Returns { binDir, pdftoppm, pdftotext } or
 * { error: { code: 'POPPLER_NOT_FOUND', detail, fix } }.
 */
function resolvePoppler(opts = {}) {
  const popplerDir = opts.popplerDir || null;

  // 1. --poppler-dir override FIRST: both exes must be present in the dir.
  if (popplerDir) {
    const pdftoppm = path.join(popplerDir, 'pdftoppm.exe');
    const pdftotext = path.join(popplerDir, 'pdftotext.exe');
    if (fs.existsSync(pdftoppm) && fs.existsSync(pdftotext)) {
      return { binDir: popplerDir, pdftoppm, pdftotext };
    }
    return {
      error: {
        code: 'POPPLER_NOT_FOUND',
        detail: `--poppler-dir ${popplerDir} does not contain both pdftoppm.exe and pdftotext.exe`,
        fix: POPPLER_FIX,
      },
    };
  }

  // 2. PATH lookup via doctor's findOnPath.
  const onPath = doctor.findOnPath('pdftoppm');
  if (onPath) {
    const binDir = path.dirname(onPath);
    const pdftotext = path.join(binDir, 'pdftotext.exe');
    if (fs.existsSync(pdftotext)) {
      return { binDir, pdftoppm: onPath, pdftotext };
    }
  }

  // 3. doctor.PDFTOPPM_DIRS — full exe paths; pdftotext from the same dir.
  for (const exe of doctor.PDFTOPPM_DIRS) {
    if (fs.existsSync(exe)) {
      const binDir = path.dirname(exe);
      const pdftotext = path.join(binDir, 'pdftotext.exe');
      if (fs.existsSync(pdftotext)) {
        return { binDir, pdftoppm: exe, pdftotext };
      }
    }
  }

  return {
    error: {
      code: 'POPPLER_NOT_FOUND',
      detail: 'pdftoppm/pdftotext not found on PATH or in the known install dirs',
      fix: POPPLER_FIX,
    },
  };
}

/**
 * Parse pdf-extract flags. Supports both `--flag value` and `--flag=value`.
 * Returns { flags } or { error } (unknown flag / missing value → usage error).
 */
function parseExtractFlags(args) {
  const flags = { in: null, out: null, dpi: DPI_DEFAULT, pages: 'all', popplerDir: null, json: false };
  const valueFlags = new Set(['--in', '--out', '--dpi', '--pages', '--poppler-dir']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') {
      flags.json = true;
      continue;
    }
    let name = a;
    let value = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      name = a.slice(0, eq);
      value = a.slice(eq + 1);
    }
    if (!valueFlags.has(name)) {
      return { error: `unknown flag "${a}"` };
    }
    if (value === null) {
      value = args[++i];
      if (value === undefined) {
        return { error: `${name} requires a value` };
      }
    }
    if (name === '--in') flags.in = value;
    else if (name === '--out') flags.out = value;
    else if (name === '--dpi') flags.dpi = value;
    else if (name === '--pages') flags.pages = value;
    else if (name === '--poppler-dir') flags.popplerDir = value;
  }
  return { flags };
}

/**
 * Parse --pages: 'all' | 'N' | 'N-M'. Returns { first, last } (first/last null
 * for 'all') or { error: true } for anything invalid (incl. N > M, N < 1).
 */
function parsePages(spec) {
  if (spec === 'all') return { first: null, last: null };
  const single = /^(\d+)$/.exec(spec);
  if (single) {
    const n = Number(single[1]);
    if (n < 1) return { error: true };
    return { first: n, last: n };
  }
  const range = /^(\d+)-(\d+)$/.exec(spec);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (a < 1 || b < 1 || a > b) return { error: true };
    return { first: a, last: b };
  }
  return { error: true };
}

/**
 * Best-effort tool version from `-v` stderr (non-fatal; null on any failure).
 */
function toolVersion(exe) {
  try {
    const res = spawnSync(exe, ['-v'], { encoding: 'utf8', timeout: 10000 });
    const out = `${res.stderr || ''}${res.stdout || ''}`;
    const m = /version\s+([^\s]+)/i.exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Operational failure: write extract-report.json ({ok:false, error}), emit
 * human/JSON output, return exit code 1.
 */
function fail(outDir, error, json) {
  const report = { ok: false, error };
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'extract-report.json'), JSON.stringify(report, null, 2));
  } catch {
    // Report file is best-effort; the JSON output / exit code carry the failure.
  }
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stderr.write(`ppt-engine pdf-extract: ${error.code}: ${error.detail}\n`);
  return 1;
}

/**
 * Run the PDF extraction. Returns the process exit code (0 / 2 / 1).
 */
function runPdfExtract(args) {
  const parsed = parseExtractFlags(args);
  if (parsed.error) {
    process.stderr.write(`ppt-engine pdf-extract: ${parsed.error}\n`);
    return 2;
  }
  const flags = parsed.flags;

  if (!flags.in) {
    process.stderr.write('ppt-engine pdf-extract: --in <file.pdf> is required\n');
    return 2;
  }

  const dpiNum = Number(flags.dpi);
  if (!Number.isInteger(dpiNum) || dpiNum <= 0) {
    process.stderr.write(`ppt-engine pdf-extract: --dpi must be a positive integer (got "${flags.dpi}")\n`);
    return 2;
  }
  const dpi = Math.min(DPI_MAX, Math.max(DPI_MIN, dpiNum));

  const range = parsePages(flags.pages);
  if (range.error) {
    process.stderr.write(`ppt-engine pdf-extract: invalid --pages "${flags.pages}" (expected all | N | N-M)\n`);
    return 2;
  }

  const pdfPath = path.resolve(flags.in);
  const outDir = path.resolve(flags.out || path.join(path.dirname(pdfPath), 'pdf-extract'));

  // Input validation: file exists, then %PDF magic bytes.
  if (!fs.existsSync(pdfPath)) {
    return fail(outDir, {
      code: 'PDF_NOT_FOUND',
      detail: `PDF not found: ${pdfPath}`,
      fix: 'Check the --in path and re-run.',
    }, flags.json);
  }
  const magic = fs.readFileSync(pdfPath).subarray(0, 4).toString('latin1');
  if (magic !== '%PDF') {
    return fail(outDir, {
      code: 'NOT_A_PDF',
      detail: `File is not a PDF (missing %PDF magic bytes): ${pdfPath}`,
      fix: 'Point --in at a real PDF file.',
    }, flags.json);
  }

  const poppler = resolvePoppler({ popplerDir: flags.popplerDir });
  if (poppler.error) {
    return fail(outDir, poppler.error, flags.json);
  }

  const pagesDir = path.join(outDir, 'pages');
  const textDir = path.join(outDir, 'text');
  fs.mkdirSync(pagesDir, { recursive: true });
  fs.mkdirSync(textDir, { recursive: true });

  // pdftoppm: rasterize to pages/page-NN.png. Never shell:true (CJK paths).
  const ppmArgs = ['-png', '-r', String(dpi)];
  if (range.first !== null) ppmArgs.push('-f', String(range.first), '-l', String(range.last));
  ppmArgs.push(pdfPath, path.join(pagesDir, 'page'));
  const ppm = spawnSync(poppler.pdftoppm, ppmArgs, { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS });
  if (ppm.error || ppm.status !== 0) {
    return fail(outDir, {
      code: 'EXTRACT_FAILED',
      detail: `pdftoppm failed (status ${ppm.status}): ${(ppm.stderr || '').trim() || (ppm.error && ppm.error.message) || 'unknown error'}`,
      fix: 'Check that the PDF is not corrupt and Poppler is functional.',
    }, flags.json);
  }

  // Rename step: page-NN.png → NN.png in numeric order (01.png, 02.png, ...).
  const pngRe = /^page-(\d+)\.png$/;
  const pngs = fs.readdirSync(pagesDir)
    .filter((f) => pngRe.test(f))
    .sort((a, b) => Number(pngRe.exec(a)[1]) - Number(pngRe.exec(b)[1]));
  for (let i = 0; i < pngs.length; i++) {
    const nn = String(i + 1).padStart(2, '0');
    fs.renameSync(path.join(pagesDir, pngs[i]), path.join(pagesDir, `${nn}.png`));
  }

  // pdftotext: single pass to all.txt, then split on \f into text/NN.txt.
  const txt = spawnSync(poppler.pdftotext, ['-enc', 'UTF-8', pdfPath, path.join(textDir, 'all.txt')], {
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
  });
  if (txt.error || txt.status !== 0) {
    return fail(outDir, {
      code: 'EXTRACT_FAILED',
      detail: `pdftotext failed (status ${txt.status}): ${(txt.stderr || '').trim() || (txt.error && txt.error.message) || 'unknown error'}`,
      fix: 'Check that the PDF is not corrupt and Poppler is functional.',
    }, flags.json);
  }

  let sections = fs.readFileSync(path.join(textDir, 'all.txt'), 'utf8').split('\f');
  while (sections.length > 0 && sections[sections.length - 1].trim() === '') sections.pop();
  if (range.first !== null) sections = sections.slice(range.first - 1, range.last);

  const warnings = [];
  if (pngs.length !== sections.length) {
    warnings.push(`page count mismatch: ${pngs.length} PNGs vs ${sections.length} text sections`);
  }
  const pages = [];
  for (let i = 0; i < sections.length; i++) {
    const nn = String(i + 1).padStart(2, '0');
    fs.writeFileSync(path.join(textDir, `${nn}.txt`), sections[i]);
    const entry = { n: i + 1, png: `pages/${nn}.png`, txt: `text/${nn}.txt`, textChars: sections[i].length };
    if (sections[i].length === 0) {
      entry.warning = 'page text is empty';
      warnings.push(`page ${nn}: text is empty`);
    }
    pages.push(entry);
  }
  if (pages.length === 0) warnings.push('no pages extracted');

  const versions = { pdftoppm: toolVersion(poppler.pdftoppm), pdftotext: toolVersion(poppler.pdftotext) };
  const report = {
    ok: true,
    tool: { pdftoppm: poppler.pdftoppm, pdftotext: poppler.pdftotext, versions },
    dpi,
    pageCount: pages.length,
    pages,
    warnings,
    error: null,
  };
  fs.writeFileSync(path.join(outDir, 'extract-report.json'), JSON.stringify(report, null, 2));

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    for (const p of pages) {
      const pngBytes = fs.statSync(path.join(outDir, p.png)).size;
      process.stdout.write(
        `  page ${String(p.n).padStart(2, '0')}: ${p.png} (${pngBytes} bytes), ${p.txt} (${p.textChars} chars)${p.warning ? ` — ${p.warning}` : ''}\n`
      );
    }
    process.stdout.write(`pdf-extract: ${pages.length} pages extracted to ${outDir}\n`);
  }
  return 0;
}

module.exports = { runPdfExtract, resolvePoppler };