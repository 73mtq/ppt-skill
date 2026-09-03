'use strict';

/**
 * CLI smoke tests for bin/ppt-engine.js.
 * Uses node:test + node:assert (no third-party test framework).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'ppt-engine.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('doctor --json exits 0 and reports node/playwright/sharp all ok', () => {
  const res = runCli(['doctor', '--json']);
  assert.equal(res.status, 0, `doctor should exit 0, got ${res.status}\nstderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.ok(Array.isArray(out.checks), 'output.checks must be an array');
  const names = out.checks.map((c) => c.name);
  for (const required of ['node', 'playwright', 'sharp']) {
    assert.ok(names.includes(required), `checks must include "${required}", got [${names.join(', ')}]`);
  }
  for (const c of out.checks) {
    assert.equal(typeof c.ok, 'boolean', `check "${c.name}" must have boolean ok`);
    assert.equal(typeof c.detail, 'string', `check "${c.name}" must have string detail`);
    assert.equal(typeof c.fix, 'string', `check "${c.name}" must have string fix`);
    assert.equal(c.ok, true, `check "${c.name}" must be ok=true`);
  }
});

test('unknown command exits non-zero and prints usage', () => {
  const res = runCli(['nosuchcmd']);
  assert.notEqual(res.status, 0, 'unknown command must exit non-zero');
  assert.match(res.stderr, /unknown command/, 'stderr must mention the unknown command');
  assert.match(res.stderr, /Usage:/, 'stderr must print usage');
});

test('stub command exits 2 and prints "not implemented"', () => {
  for (const cmd of ['convert', 'render', 'validate']) {
    const res = runCli([cmd]);
    assert.equal(res.status, 2, `"${cmd}" stub must exit 2, got ${res.status}`);
    assert.match(res.stderr, /not implemented/, `"${cmd}" stub must print "not implemented"`);
  }
});

test('no arguments prints usage and exits non-zero', () => {
  const res = runCli([]);
  assert.notEqual(res.status, 0, 'no-args invocation must exit non-zero');
  assert.match(res.stderr, /Usage:/, 'no-args invocation must print usage');
});