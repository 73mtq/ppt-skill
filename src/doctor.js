'use strict';

/**
 * doctor — full environment self-check (stage-2).
 *
 * Checks (mandatory unless noted):
 *   node        Node.js >= 20
 *   playwright  Playwright chromium executable present
 *   sharp       Sharp native binding loads and renders
 *   font:*      Windows fonts in the font dir (--font-dir overrides)
 *   soffice     LibreOffice — OPTIONAL (feeds todo 9 pixel-diff QA)
 *   pdftoppm    Poppler — OPTIONAL (feeds todo 9 pixel-diff QA)
 *
 * Exit code is driven ONLY by mandatory checks. Optional tools never fail the
 * run: when missing they report ok=true with a detail noting the skip.
 *
 * Output shape (--json): { ok, strict, checks: [{ name, ok, detail, fix, mandatory, found }] }
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MIN_NODE_MAJOR = 20;
const DEFAULT_FONT_DIR = 'C:\\Windows\\Fonts';

// Each entry: { file, family, alt? } — alt satisfies the same check (Deng.ttf OR Dengb.ttf).
const FONT_CHECKS = [
  { file: 'msyh.ttc', family: 'Microsoft YaHei (微软雅黑)' },
  { file: 'msyhbd.ttc', family: 'Microsoft YaHei Bold (微软雅黑 Bold)' },
  { file: 'Deng.ttf', family: 'DengXian (等线)', alt: 'Dengb.ttf' },
  { file: 'segoeui.ttf', family: 'Segoe UI' },
  { file: 'arial.ttf', family: 'Arial' },
];

const SOFFICE_DIRS = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
];

const PDFTOPPM_DIRS = [
  'C:\\Program Files\\poppler\\Library\\bin\\pdftoppm.exe',
  'C:\\Program Files (x86)\\poppler\\Library\\bin\\pdftoppm.exe',
];

const FONT_FIX =
  'Install the missing font (Windows: Settings > Personalization > Fonts, or install the ' +
  'Microsoft YaHei / DengXian font package). The engine needs these Windows fonts for CJK text rendering.';

function parseFlags(args) {
  const flags = { json: false, strict: false, fontDir: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--strict') flags.strict = true;
    else if (a === '--font-dir') {
      flags.fontDir = args[++i];
      if (flags.fontDir === undefined) {
        throw new Error('--font-dir requires a directory argument');
      }
    } else if (a.startsWith('--font-dir=')) {
      flags.fontDir = a.slice('--font-dir='.length);
    }
    // Unknown flags are ignored (later todos own full per-command parsing).
  }
  return flags;
}

function checkNode() {
  const current = Number(process.versions.node.split('.')[0]);
  const ok = current >= MIN_NODE_MAJOR;
  return {
    name: 'node',
    ok,
    detail: `Node.js ${process.versions.node} (required >= ${MIN_NODE_MAJOR})`,
    fix: ok ? '' : 'Install Node.js >= 20 from https://nodejs.org/ and re-run this check.',
    mandatory: true,
    found: ok,
  };
}

function checkPlaywright() {
  let executablePath = null;
  let loadError = null;
  try {
    const { chromium } = require('playwright');
    executablePath = chromium.executablePath();
  } catch (err) {
    loadError = err.message;
  }
  if (loadError) {
    return {
      name: 'playwright',
      ok: false,
      detail: `playwright module failed to load: ${loadError}`,
      fix: 'Run "npm i" to install dependencies, then "npx playwright install chromium".',
      mandatory: true,
      found: false,
    };
  }
  const exists = fs.existsSync(executablePath);
  return {
    name: 'playwright',
    ok: exists,
    detail: exists
      ? `Chromium executable found at ${executablePath}`
      : `Chromium executable NOT found at ${executablePath}`,
    fix: exists
      ? ''
      : 'Run "npx playwright install chromium" (CN mirror: set PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright before installing).',
    mandatory: true,
    found: exists,
  };
}

async function checkSharp() {
  try {
    const sharp = require('sharp');
    const sharpEntry = require.resolve('sharp');
    const version = JSON.parse(
      fs.readFileSync(path.join(path.dirname(sharpEntry), '..', 'package.json'), 'utf8')
    ).version;
    const buf = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const ok = buf.length > 0;
    return {
      name: 'sharp',
      ok,
      detail: ok
        ? `sharp ${version} (libvips ${sharp.versions.vips}) native binding loaded`
        : `sharp ${version} loaded but produced an empty buffer`,
      fix: ok ? '' : 'Reinstall the native binding with "npm rebuild sharp".',
      mandatory: true,
      found: ok,
    };
  } catch (err) {
    return {
      name: 'sharp',
      ok: false,
      detail: `sharp native binding failed to load: ${err.message}`,
      fix: 'Run "npm rebuild sharp" (or "npm i") to restore the native binding.',
      mandatory: true,
      found: false,
    };
  }
}

function checkFont(entry, fontDir) {
  const full = path.join(fontDir, entry.file);
  const altFull = entry.alt ? path.join(fontDir, entry.alt) : null;
  const foundPath = fs.existsSync(full) ? full : altFull && fs.existsSync(altFull) ? altFull : null;
  const ok = foundPath !== null;
  const wanted = entry.alt ? `${entry.file} or ${entry.alt}` : entry.file;
  return {
    name: `font:${entry.file}`,
    ok,
    detail: ok
      ? `${entry.family} found at ${foundPath}`
      : `${entry.family} (${wanted}) NOT found in ${fontDir}`,
    fix: ok ? '' : FONT_FIX,
    mandatory: true,
    found: ok,
  };
}

function findOnPath(exe) {
  try {
    const res = spawnSync('where.exe', [exe], { encoding: 'utf8', timeout: 10000 });
    if (res.status === 0 && res.stdout) {
      const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first) return first;
    }
  } catch {
    // where.exe unavailable — fall through to common install dirs.
  }
  return null;
}

function checkOptionalTool(name, exe, extraDirs, fixHint) {
  const onPath = findOnPath(exe);
  const found = onPath || extraDirs.find((d) => fs.existsSync(d)) || null;
  return {
    name,
    ok: true, // optional: missing never fails the run
    detail: found
      ? `${exe} found at ${found}`
      : `${exe} not found (optional — pixel-diff QA will be skipped)`,
    fix: found ? '' : fixHint,
    mandatory: false,
    found: found !== null,
  };
}

async function runDoctor(args) {
  const flags = parseFlags(args);
  const fontDir = flags.fontDir || DEFAULT_FONT_DIR;
  const checks = [
    checkNode(),
    checkPlaywright(),
    await checkSharp(),
    ...FONT_CHECKS.map((entry) => checkFont(entry, fontDir)),
    checkOptionalTool(
      'soffice',
      'soffice',
      SOFFICE_DIRS,
      'Install LibreOffice (https://www.libreoffice.org/) to enable optional pixel-diff QA; not required for core conversion.'
    ),
    checkOptionalTool(
      'pdftoppm',
      'pdftoppm',
      PDFTOPPM_DIRS,
      'Install Poppler (https://github.com/oschwartz10612/poppler-windows) to enable optional pixel-diff QA; not required for core conversion.'
    ),
  ];
  const ok = checks.filter((c) => c.mandatory).every((c) => c.ok);
  const out = { ok, strict: flags.strict, checks };
  if (flags.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    for (const c of checks) {
      let mark;
      if (!c.mandatory && !c.found) mark = 'INFO';
      else mark = c.ok ? 'PASS' : 'FAIL';
      process.stdout.write(`[${mark}] ${c.name}: ${c.detail}\n`);
      if (!c.ok && c.fix) process.stdout.write(`      fix: ${c.fix}\n`);
    }
    process.stdout.write(`\n${ok ? 'All mandatory checks passed.' : 'Some mandatory checks failed.'}\n`);
  }
  return ok ? 0 : 1;
}

module.exports = { runDoctor, parseFlags, DEFAULT_FONT_DIR, FONT_CHECKS };