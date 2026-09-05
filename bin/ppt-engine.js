#!/usr/bin/env node
'use strict';

/**
 * ppt-engine CLI entry point.
 *
 * Hand-written argument parsing + subcommand registry.
 * Subcommands: convert / render / validate / validate-html / doctor.
 * All five are implemented. `validate <deck.pptx>` structurally validates a
 * GENERATED deck: it re-renders the pages of the convert output project
 * (self-contained: deck.json + tokens.json + pages/) to rebuild the layout IR,
 * then runs validatePptx (text match, shape bounds, bodyPr insets/anchor,
 * pic rels, typeface ∈ tokens).
 */

const doctor = require('../src/doctor.js');
const { runPdfExtract } = require('../src/pdf-extract.js');
const { renderPage } = require('../src/render.js');
const { rasterizePage } = require('../src/raster.js');
const { buildPresentation } = require('../src/convert/page.js');
const { validateTokens, validateHtmlIR } = require('../src/validate/tokens-html.js');
const { validatePptx } = require('../src/validate/pptx.js');
const fs = require('node:fs');
const path = require('node:path');

const COMMANDS = {
  convert: {
    summary: 'Convert an HTML project into a native editable deck.pptx',
    stub: false,
  },
  render: {
    summary: 'Render one-shot screenshots of each page (QA)',
    stub: false,
  },
  validate: {
    summary: 'Structurally validate a generated deck.pptx',
    stub: false,
  },
  'validate-html': {
    summary: 'Validate HTML against the token / constraint rules',
    stub: false,
  },
  doctor: {
    summary: 'Environment self-check (Node / Playwright / Sharp / fonts / optional tools)',
    stub: false,
  },
  'pdf-extract': {
    summary: 'PDF → 每页 PNG + 分页文本 + extract-report.json（Poppler）',
    stub: false,
  },
};

function usage(stream) {
  stream.write('ppt-engine - HTML to native editable PPTX engine\n\n');
  stream.write('Usage: node bin/ppt-engine.js <command> [options]\n\n');
  stream.write('Commands:\n');
  for (const [name, def] of Object.entries(COMMANDS)) {
    stream.write(`  ${name.padEnd(14)} ${def.summary}\n`);
  }
  stream.write('\n  convert: node bin/ppt-engine.js convert --project <dir> [--json]\n');
  stream.write('  render:  node bin/ppt-engine.js render --project <dir> --shots [--json]\n');
  stream.write('  validate: node bin/ppt-engine.js validate <deck.pptx> [--json]\n');
  stream.write('  pdf-extract: node bin/ppt-engine.js pdf-extract --in <file.pdf> [--out <dir>] [--dpi <int>] [--pages <all|N|N-M>] [--poppler-dir <dir>] [--json]\n');
  stream.write('\nRun "node bin/ppt-engine.js doctor --json" for a machine-readable environment check.\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    usage(process.stderr);
    process.exit(1);
  }
  const cmd = argv[0];
  const rest = argv.slice(1);
  const def = COMMANDS[cmd];
  if (!def) {
    process.stderr.write(`ppt-engine: unknown command "${cmd}"\n\n`);
    usage(process.stderr);
    process.exit(1);
  }
  if (def.stub) {
    process.stderr.write(`ppt-engine: command "${cmd}" is not implemented yet\n`);
    process.exit(2);
  }
  if (cmd === 'doctor') {
    process.exit(await doctor.runDoctor(rest));
  }
  if (cmd === 'pdf-extract') {
    process.exit(await runPdfExtract(rest));
  }
  if (cmd === 'validate-html') {
    process.exit(await runValidateHtml(rest));
  }
  if (cmd === 'convert') {
    process.exit(await runConvert(rest));
  }
  if (cmd === 'render') {
    process.exit(await runRender(rest));
  }
  if (cmd === 'validate') {
    process.exit(await runValidate(rest));
  }
  process.exit(1); // unreachable
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parseProjectArgs(args) {
  const flags = { project: null, jsonOut: false, shots: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.jsonOut = true;
    else if (a === '--shots') flags.shots = true;
    else if (a === '--project') flags.project = args[++i];
    else if (a.startsWith('--project=')) flags.project = a.slice('--project='.length);
    // Unknown flags are ignored (matches the validate-html parser).
  }
  return flags;
}

// Output layout contract: OUT = <project>/../out/<deck-name>/ where deck-name
// is the basename of the project dir (corpus → out/corpus).
function outputDirFor(project) {
  const abs = path.resolve(project);
  return path.join(path.dirname(abs), 'out', path.basename(abs));
}

// Windows filename sanitization for the title-named deck copy: strip reserved
// characters (/ \ : * ? " < > |) and control chars, collapse whitespace, trim;
// fall back to 'deck' when nothing survives. CJK characters are legal in
// Windows filenames — kept as-is.
function sanitizeFilename(name) {
  const cleaned = String(name)
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'deck';
}

// file:// URL with encodeURI so CJK paths work (same approach as src/render.js).
function toFileUrl(absPath) {
  const forward = absPath.replace(/\\/g, '/');
  const prefix = forward.startsWith('/') ? '' : '///';
  return 'file://' + prefix + encodeURI(forward);
}

// Read + validate the project manifest (deck.json). Returns {manifest} or
// {error} with a human-readable message.
function loadManifest(project) {
  const manifestPath = path.join(project, 'deck.json');
  if (!fs.existsSync(manifestPath)) {
    return { error: `deck.json not found in project "${project}"` };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { error: `deck.json is not valid JSON: ${err.message}` };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { error: 'deck.json must be a JSON object' };
  }
  if (typeof manifest.title !== 'string' || !manifest.title) {
    return { error: 'deck.json is missing a non-empty string "title"' };
  }
  const ps = manifest.pageSize;
  if (!ps || typeof ps !== 'object' || typeof ps.w !== 'number' || typeof ps.h !== 'number' || ps.w <= 0 || ps.h <= 0) {
    return { error: 'deck.json "pageSize" must be {w,h} positive numbers' };
  }
  if (typeof manifest.tokensPath !== 'string' || !manifest.tokensPath) {
    return { error: 'deck.json is missing a non-empty string "tokensPath"' };
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    return { error: 'deck.json declares no pages (pages must be a non-empty array)' };
  }
  for (const p of manifest.pages) {
    if (!p || typeof p !== 'object' || typeof p.file !== 'string' || !p.file) {
      return { error: 'deck.json pages[] entries must have a non-empty string "file"' };
    }
  }
  return { manifest };
}

// Resolve tokens.json via manifest.tokensPath: relative to the project dir
// first, then fall back to the repo root (the corpus project lives inside the
// repo and points at tokens/default.json).
function resolveTokens(project, manifest) {
  const candidates = [
    path.resolve(project, manifest.tokensPath),
    path.resolve(__dirname, '..', manifest.tokensPath),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        return { tokens: JSON.parse(fs.readFileSync(c, 'utf8')), sourcePath: c };
      } catch (err) {
        return { error: `tokens file "${c}" is not valid JSON: ${err.message}` };
      }
    }
  }
  return { error: `tokens file not found (tried ${candidates.join(', ')})` };
}

// data-ppt-role transparency (phase-2 interface reservation — record only, no
// logic): map data-ppt-id → data-ppt-role from the page HTML source.
function extractRolesFromHtml(html) {
  const roles = new Map();
  const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const attrs = m[0];
    const id = /data-ppt-id="([^"]*)"/.exec(attrs);
    const role = /data-ppt-role="([^"]*)"/.exec(attrs);
    if (id && role) roles.set(id[1], role[1]);
  }
  return roles;
}

function summarizeElements(ir, roles) {
  return (ir.elements || []).map((el) => ({
    pptId: el.pptId,
    tag: el.tag,
    role: roles.get(el.pptId) || null,
    rect: el.rect,
  }));
}

function printStructuredError(stream, e) {
  stream.write(
    `ERROR [${e.rule}] page=${e.page} id=${e['data-ppt-id']} measured=${JSON.stringify(e.measured)} ` +
    `available=${JSON.stringify(e.available)} suggested_fix=${e.suggested_fix}\n`
  );
}

function printReportHuman(report) {
  process.stdout.write(`ppt-engine convert: ${report.title}\n`);
  for (const p of report.pages) {
    const status = p.errors.length ? 'FAILED' : 'OK';
    process.stdout.write(
      `  ${p.file} (${p.role || '?'}): ${status} — ${p.elements.length} elements, ${p.errors.length} errors, ${p.warnings.length} warnings\n`
    );
    for (const e of p.errors) printStructuredError(process.stdout, e);
    for (const w of p.warnings) {
      process.stdout.write(`WARN  [${w.rule}] page=${w.page} id=${w['data-ppt-id']} suggested_fix=${w.suggested_fix}\n`);
    }
  }
  process.stdout.write(`conversion-report: ${report.pages.length} pages, ${report['errors:total']} errors, ${report['warnings:total']} warnings\n`);
}

// buildPresentation throws structured chart errors embedded as JSON in the
// message ("convert: chart error {...}"); extract them when present.
function extractStructuredError(err) {
  const msg = err && err.message ? err.message : String(err);
  const m = /convert: chart error (\{.*\})/.exec(msg);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch (e) { /* fall through */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// convert --project <dir> [--json]
// ---------------------------------------------------------------------------

async function runConvert(args) {
  const { project, jsonOut } = parseProjectArgs(args);
  if (!project) {
    process.stderr.write('ppt-engine convert: --project <dir> is required\n');
    return 2;
  }

  const { manifest, error: manifestError } = loadManifest(project);
  if (manifestError) {
    process.stderr.write(`ppt-engine convert: ${manifestError}\n`);
    return 1;
  }
  const { tokens, sourcePath: tokensPath, error: tokensError } = resolveTokens(project, manifest);
  if (tokensError) {
    process.stderr.write(`ppt-engine convert: ${tokensError}\n`);
    return 1;
  }
  const tokenErrors = validateTokens(tokens);
  if (tokenErrors.length) {
    for (const e of tokenErrors) printStructuredError(process.stderr, e);
    process.stderr.write(`ppt-engine convert: tokens.json failed validation (${tokenErrors.length} errors)\n`);
    return 1;
  }

  // Output project layout: OUT/pages/ + OUT/assets/ + OUT/shots/ + deck.pptx +
  // conversion-report.json. Source project stays read-only.
  const outDir = outputDirFor(project);
  const outPagesDir = path.join(outDir, 'pages');
  const outAssetsDir = path.join(outDir, 'assets');
  fs.mkdirSync(outPagesDir, { recursive: true });
  fs.mkdirSync(outAssetsDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });

  // Copy source assets (images referenced by pages) into the output project.
  const srcAssetsDir = path.join(project, 'assets');
  if (fs.existsSync(srcAssetsDir)) {
    for (const f of fs.readdirSync(srcAssetsDir)) {
      const s = path.join(srcAssetsDir, f);
      if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(outAssetsDir, f));
    }
  }

  // Copy pages with NN-slug.html naming; write the output manifest (tokensPath
  // now points at the copied tokens.json so the output project is self-contained).
  const outPages = [];
  for (let i = 0; i < manifest.pages.length; i++) {
    const p = manifest.pages[i];
    const src = path.join(project, 'pages', p.file);
    const nn = String(i + 1).padStart(2, '0');
    const newFile = p.slug ? `${nn}-${p.slug}.html` : p.file;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outPagesDir, newFile));
    outPages.push({ ...p, file: newFile });
  }
  fs.writeFileSync(path.join(outDir, 'deck.json'), JSON.stringify({ ...manifest, tokensPath: 'tokens.json', pages: outPages }, null, 2));
  fs.copyFileSync(tokensPath, path.join(outDir, 'tokens.json'));

  const browser = await require('playwright').chromium.launch({ headless: true });
  const irPages = [];
  const reportPages = [];
  try {
    for (const p of manifest.pages) {
      const entry = {
        file: p.file,
        slug: p.slug || null,
        role: p.role || null,
        intent: p.intent || null,
        elements: [],
        errors: [],
        warnings: [],
      };
      const htmlPath = path.join(project, 'pages', p.file);
      if (!fs.existsSync(htmlPath)) {
        entry.errors.push({
          page: p.file,
          'data-ppt-id': null,
          rule: 'page-file-missing',
          measured: htmlPath,
          available: 'existing HTML file under pages/',
          suggested_fix: `Create pages/${p.file} (or fix the "file" field in deck.json).`,
        });
        reportPages.push(entry);
        continue;
      }
      let ir;
      try {
        ir = await renderPage(htmlPath, { browser });
      } catch (err) {
        entry.errors.push({
          page: p.file,
          'data-ppt-id': null,
          rule: 'render-failed',
          measured: err.message,
          available: 'renderable HTML',
          suggested_fix: 'Fix the HTML so the page renders (see the error above).',
        });
        reportPages.push(entry);
        continue;
      }
      entry.warnings.push(...ir.warnings);
      entry.elements = summarizeElements(ir, extractRolesFromHtml(fs.readFileSync(htmlPath, 'utf8')));
      const htmlErrors = validateHtmlIR(ir, tokens);
      if (htmlErrors.length) {
        entry.errors.push(...htmlErrors);
        reportPages.push(entry);
        continue;
      }
      const raster = await rasterizePage(ir, htmlPath, { browser });
      if (raster.errors.length) {
        entry.errors.push(...raster.errors);
        reportPages.push(entry);
        continue;
      }
      // Write produced raster images under the OUTPUT project's assets/.
      for (const el of raster.ir.elements) {
        if (el.raster && el.raster.imageData) {
          const dest = path.join(outDir, el.raster.filename);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, el.raster.imageData);
        }
      }
      irPages.push(raster.ir);
      reportPages.push(entry);
    }
  } finally {
    await browser.close();
  }

  const totalErrors = reportPages.reduce((n, e) => n + e.errors.length, 0);
  const totalWarnings = reportPages.reduce((n, e) => n + e.warnings.length, 0);
  const report = {
    title: manifest.title,
    pageSize: manifest.pageSize,
    pages: reportPages,
    ok: totalErrors === 0,
    'errors:total': totalErrors,
    'warnings:total': totalWarnings,
  };
  fs.writeFileSync(path.join(outDir, 'conversion-report.json'), JSON.stringify(report, null, 2));

  if (totalErrors > 0) {
    if (jsonOut) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else printReportHuman(report);
    return 1;
  }

  // Every page converted with zero errors: build + write the deck, then run
  // the mandatory structural validation (validatePptx) on the written file.
  let deckBuf;
  try {
    const pptx = buildPresentation(irPages, tokens);
    deckBuf = await pptx.write({ outputType: 'nodebuffer' });
  } catch (err) {
    const structured = extractStructuredError(err);
    if (structured) {
      const pageEntry = reportPages.find((e) => e.file === structured.page);
      if (pageEntry) pageEntry.errors.push(structured);
      else reportPages.push({ file: structured.page, slug: null, role: null, intent: null, elements: [], errors: [structured], warnings: [] });
      const te = reportPages.reduce((n, e) => n + e.errors.length, 0);
      report.ok = te === 0;
      report['errors:total'] = te;
      fs.writeFileSync(path.join(outDir, 'conversion-report.json'), JSON.stringify(report, null, 2));
    }
    if (jsonOut) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stderr.write(`ppt-engine convert: buildPresentation failed: ${err.message}\n`);
    return 1;
  }
  fs.writeFileSync(path.join(outDir, 'deck.pptx'), deckBuf);

  // User-friendly copy named after the manifest title (Windows filename-safe).
  const safeTitle = sanitizeFilename(manifest.title);
  const titleDeckPath = path.join(outDir, safeTitle + '.pptx');
  fs.copyFileSync(path.join(outDir, 'deck.pptx'), titleDeckPath);

  const validation = await validatePptx(deckBuf, irPages, tokens);
  if (!validation.ok) {
    if (jsonOut) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    for (const e of validation.errors) printStructuredError(process.stderr, e);
    process.stderr.write(`ppt-engine convert: validatePptx failed (${validation.errors.length} errors)\n`);
    return 1;
  }

  if (jsonOut) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    printReportHuman(report);
    process.stdout.write(`deck.pptx written to ${path.join(outDir, 'deck.pptx')}\n`);
    process.stdout.write(`${safeTitle}.pptx written to ${titleDeckPath}\n`);
    process.stdout.write(`validatePptx: ok (${irPages.length} slides)\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// render --project <dir> --shots [--json]
// ---------------------------------------------------------------------------

async function runRender(args) {
  const { project, jsonOut, shots } = parseProjectArgs(args);
  if (!project) {
    process.stderr.write('ppt-engine render: --project <dir> is required\n');
    return 2;
  }
  if (!shots) {
    process.stderr.write('ppt-engine render: --shots is required (renders QA screenshots)\n');
    return 2;
  }

  const { manifest, error: manifestError } = loadManifest(project);
  if (manifestError) {
    process.stderr.write(`ppt-engine render: ${manifestError}\n`);
    return 1;
  }

  const outDir = outputDirFor(project);
  const shotsDir = path.join(outDir, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });

  // One-shot browser: launched, used for every page, closed before exit.
  const browser = await require('playwright').chromium.launch({ headless: true });
  const written = [];
  try {
    for (let i = 0; i < manifest.pages.length; i++) {
      const p = manifest.pages[i];
      const htmlPath = path.join(project, 'pages', p.file);
      if (!fs.existsSync(htmlPath)) {
        process.stderr.write(`ppt-engine render: page file not found: ${htmlPath}\n`);
        return 1;
      }
      const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 });
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
        const nn = String(i + 1).padStart(2, '0');
        const shotPath = path.join(shotsDir, `${nn}.png`);
        await page.screenshot({ path: shotPath, type: 'png' });
        written.push(shotPath);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  if (jsonOut) {
    process.stdout.write(JSON.stringify({ shots: written }, null, 2) + '\n');
  } else {
    for (const f of written) process.stdout.write(`shot: ${f}\n`);
    process.stdout.write(`render: ${written.length} shots written to ${shotsDir}\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// validate <deck.pptx> [--json]
// ---------------------------------------------------------------------------
// Structural validation of a GENERATED deck. The deck.pptx must live inside a
// convert output project (out/<deck>/), which is self-contained: deck.json
// (pages renamed NN-slug.html, tokensPath → tokens.json), tokens.json and
// pages/*.html. The pages are re-rendered to rebuild the layout IR, then
// validatePptx checks text match, shape bounds (EMU), bodyPr insets/anchor,
// picture rels and typeface whitelist. Exit 0 only on zero errors.
async function runValidate(args) {
  let deckPath = null;
  let jsonOut = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') jsonOut = true;
    else if (a === '--file') deckPath = args[++i];
    else if (a.startsWith('--file=')) deckPath = a.slice('--file='.length);
    else if (!a.startsWith('-') && deckPath === null) deckPath = a; // positional
  }
  if (!deckPath) {
    process.stderr.write('ppt-engine validate: <deck.pptx> is required (positional or --file)\n');
    return 2;
  }
  const absDeck = path.resolve(deckPath);
  if (!fs.existsSync(absDeck)) {
    process.stderr.write(`ppt-engine validate: deck not found: ${absDeck}\n`);
    return 1;
  }
  const outDir = path.dirname(absDeck);

  // The output project must be a convert product: deck.json + tokens.json +
  // pages/ beside the deck. A bare deck cannot be validated (the IR rebuild
  // needs the page sources).
  const manifestPath = path.join(outDir, 'deck.json');
  const tokensPath = path.join(outDir, 'tokens.json');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(tokensPath)) {
    process.stderr.write(`ppt-engine validate: expected a convert output project at "${outDir}" (deck.json + tokens.json), got a bare deck.\n`);
    return 1;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`ppt-engine validate: ${manifestPath} is not valid JSON: ${err.message}\n`);
    return 1;
  }
  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`ppt-engine validate: ${tokensPath} is not valid JSON: ${err.message}\n`);
    return 1;
  }
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  if (pages.length === 0) {
    process.stderr.write('ppt-engine validate: output deck.json declares no pages\n');
    return 1;
  }

  const browser = await require('playwright').chromium.launch({ headless: true });
  const irPages = [];
  const errors = [];
  try {
    for (const p of pages) {
      const htmlPath = path.join(outDir, 'pages', p.file);
      if (!fs.existsSync(htmlPath)) {
        errors.push({
          page: p.file,
          'data-ppt-id': null,
          rule: 'page-file-missing',
          measured: htmlPath,
          available: 'existing HTML file under pages/',
          suggested_fix: 'Re-run convert so the output project contains every page.',
        });
        continue;
      }
      try {
        irPages.push(await renderPage(htmlPath, { browser }));
      } catch (err) {
        errors.push({
          page: p.file,
          'data-ppt-id': null,
          rule: 'render-failed',
          measured: err.message,
          available: 'renderable HTML',
          suggested_fix: 'Fix the HTML so the page renders.',
        });
      }
    }
  } finally {
    await browser.close();
  }

  if (errors.length) {
    for (const e of errors) printStructuredError(process.stderr, e);
    process.stderr.write(`ppt-engine validate: ${errors.length} page error(s) while rebuilding the layout IR\n`);
    return 1;
  }

  const deckBuf = fs.readFileSync(absDeck);
  const validation = await validatePptx(deckBuf, irPages, tokens);
  if (jsonOut) {
    process.stdout.write(JSON.stringify({ ok: validation.ok, deck: absDeck, slides: irPages.length, errors: validation.errors }, null, 2) + '\n');
  } else {
    for (const e of validation.errors) printStructuredError(process.stdout, e);
    if (validation.ok) {
      process.stdout.write(`validate: ok (${irPages.length} slides, zero errors)\n`);
    } else {
      process.stdout.write(`validate: FAILED (${validation.errors.length} errors)\n`);
    }
  }
  return validation.ok ? 0 : 1;
}

/**
 * validate-html --project <dir> [--json]
 *
 * Runs the render measurement layer on every page in the project manifest
 * (deck.json) and reports the structured render-level errors
 * ({page, data-ppt-id, rule, measured, available, suggested_fix}).
 * Exit 0 only when every page renders with zero errors.
 */
async function runValidateHtml(args) {
  let project = '.';
  let jsonOut = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') jsonOut = true;
    else if (a === '--project') project = args[++i] || '.';
    else if (a.startsWith('--project=')) project = a.slice('--project='.length);
  }

  const manifestPath = path.join(project, 'deck.json');
  if (!fs.existsSync(manifestPath)) {
    process.stderr.write(`ppt-engine validate-html: deck.json not found in project "${project}"\n`);
    return 1;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`ppt-engine validate-html: deck.json is not valid JSON: ${err.message}\n`);
    return 1;
  }
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  if (pages.length === 0) {
    process.stderr.write('ppt-engine validate-html: deck.json declares no pages\n');
    return 1;
  }

  // Load tokens so the full HTML constraint validation (token whitelists,
  // gradient-on-text, style-forbidden, cjk-letter-spacing, chart schema) runs —
  // not just the render-level errors. Projects without a tokensPath fall back
  // to the repo default tokens.
  const { tokens, error: tokensError } = resolveTokens(project, {
    ...manifest,
    tokensPath: manifest.tokensPath || 'tokens/default.json',
  });
  if (tokensError) {
    process.stderr.write(`ppt-engine validate-html: ${tokensError}\n`);
    return 1;
  }

  const browser = await require('playwright').chromium.launch({ headless: true });
  const results = [];
  try {
    for (const p of pages) {
      const htmlPath = path.join(project, 'pages', p.file);
      try {
        const ir = await renderPage(htmlPath, { browser });
        // validateHtmlIR carries over render-level errors (element-not-allowed,
        // lang-missing) and adds the token/constraint checks.
        results.push({ ...ir, errors: validateHtmlIR(ir, tokens), warnings: ir.warnings });
      } catch (err) {
        process.stderr.write(`ppt-engine validate-html: page "${p.file}" failed to render: ${err.message}\n`);
        return 1;
      }
    }
  } finally {
    await browser.close();
  }

  const allErrors = results.flatMap((r) => r.errors);
  const allWarnings = results.flatMap((r) => r.warnings);
  if (jsonOut) {
    process.stdout.write(JSON.stringify({ pages: results }, null, 2) + '\n');
  } else {
    for (const r of results) {
      for (const e of r.errors) {
        process.stdout.write(`ERROR ${r.page} [${e.rule}] id=${e['data-ppt-id']} measured=${JSON.stringify(e.measured)} suggested_fix=${e.suggested_fix}\n`);
      }
    }
    for (const r of results) {
      for (const w of r.warnings) {
        process.stdout.write(`WARN  ${r.page} [${w.rule}] id=${w['data-ppt-id']} suggested_fix=${w.suggested_fix}\n`);
      }
    }
    process.stdout.write(`validate-html: ${results.length} pages, ${allErrors.length} errors, ${allWarnings.length} warnings\n`);
  }
  return allErrors.length === 0 ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`ppt-engine: unexpected error: ${err.stack || err.message}\n`);
  process.exit(1);
});