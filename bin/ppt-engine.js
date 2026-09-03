#!/usr/bin/env node
'use strict';

/**
 * ppt-engine CLI entry point.
 *
 * Hand-written argument parsing + subcommand registry.
 * Subcommands: convert / render / validate / validate-html / doctor.
 * All except `doctor` are stubs (exit 2, "not implemented") — later todos own them.
 */

const doctor = require('../src/doctor.js');
const { renderPage } = require('../src/render.js');
const fs = require('node:fs');
const path = require('node:path');

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
    stub: false,
  },
  doctor: {
    summary: 'Environment self-check (Node / Playwright / Sharp / fonts / optional tools)',
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
    const code = await doctor.runDoctor(rest);
    process.exit(code);
  }
  if (cmd === 'validate-html') {
    const code = await runValidateHtml(rest);
    process.exit(code);
  }
  process.exit(1); // unreachable
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

  const browser = await require('playwright').chromium.launch({ headless: true });
  const results = [];
  try {
    for (const p of pages) {
      const htmlPath = path.join(project, 'pages', p.file);
      try {
        results.push(await renderPage(htmlPath, { browser }));
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