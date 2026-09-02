#!/usr/bin/env node
'use strict';

/**
 * ppt-engine CLI entry point.
 *
 * Hand-written argument parsing + subcommand registry.
 * Subcommands: convert / render / validate / validate-html / doctor.
 * All except `doctor` are stubs (exit 2, "not implemented") — later todos own them.
 */

const fs = require('node:fs');
const path = require('node:path');

const MIN_NODE_MAJOR = 20;

const COMMANDS = {
  convert: {
    summary: 'Convert an HTML project into a native editable deck.pptx',
    stub: true,
  },
  render: {
    summary: 'Render one-shot screenshots of each page (QA)',
    stub: true,
  },
  validate: {
    summary: 'Structurally validate a generated deck.pptx',
    stub: true,
  },
  'validate-html': {
    summary: 'Validate HTML against the token / constraint rules',
    stub: true,
  },
  doctor: {
    summary: 'Environment self-check (Node / Playwright / Sharp)',
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
  stream.write('\nRun "node bin/ppt-engine.js doctor --json" for a machine-readable environment check.\n');
}

function parseFlags(args) {
  const flags = { json: false };
  for (const a of args) {
    if (a === '--json') flags.json = true;
    // Unknown flags are ignored here; later todos own full per-command parsing.
  }
  return flags;
}

async function checkNode() {
  const current = Number(process.versions.node.split('.')[0]);
  const ok = current >= MIN_NODE_MAJOR;
  return {
    name: 'node',
    ok,
    detail: `Node.js ${process.versions.node} (required >= ${MIN_NODE_MAJOR})`,
    fix: ok ? '' : 'Install Node.js >= 20 from https://nodejs.org/ and re-run this check.',
  };
}

async function checkPlaywright() {
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
    };
  } catch (err) {
    return {
      name: 'sharp',
      ok: false,
      detail: `sharp native binding failed to load: ${err.message}`,
      fix: 'Run "npm rebuild sharp" (or "npm i") to restore the native binding.',
    };
  }
}

async function runDoctor(args) {
  const flags = parseFlags(args);
  const checks = await Promise.all([checkNode(), checkPlaywright(), checkSharp()]);
  const ok = checks.every((c) => c.ok);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok, checks }, null, 2) + '\n');
  } else {
    for (const c of checks) {
      const mark = c.ok ? 'PASS' : 'FAIL';
      process.stdout.write(`[${mark}] ${c.name}: ${c.detail}\n`);
      if (!c.ok && c.fix) process.stdout.write(`      fix: ${c.fix}\n`);
    }
    process.stdout.write(`\n${ok ? 'All checks passed.' : 'Some checks failed.'}\n`);
  }
  return ok ? 0 : 1;
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
    const code = await runDoctor(rest);
    process.exit(code);
  }
  process.exit(1); // unreachable
}

main().catch((err) => {
  process.stderr.write(`ppt-engine: unexpected error: ${err.stack || err.message}\n`);
  process.exit(1);
});