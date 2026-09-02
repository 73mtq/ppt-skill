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
  process.exit(1); // unreachable
}

main().catch((err) => {
  process.stderr.write(`ppt-engine: unexpected error: ${err.stack || err.message}\n`);
  process.exit(1);
});