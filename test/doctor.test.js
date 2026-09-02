'use strict';

/**
 * doctor stage-2 tests: strict mode, --font-dir override, optional tools.
 * Uses node:test + node:assert (no third-party test framework).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'ppt-engine.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 30000,
  });
}

function mandatoryChecks(out) {
  return out.checks.filter((c) => c.mandatory);
}

test('doctor --json --strict exits 0 with all mandatory checks ok', () => {
  const res = runCli(['doctor', '--json', '--strict']);
  assert.equal(res.status, 0, `doctor --strict should exit 0, got ${res.status}\nstderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.strict, true, 'output must carry strict=true');
  const names = out.checks.map((c) => c.name);
  for (const required of ['node', 'playwright', 'sharp']) {
    assert.ok(names.includes(required), `checks must include "${required}", got [${names.join(', ')}]`);
  }
  for (const c of out.checks) {
    assert.equal(typeof c.ok, 'boolean', `check "${c.name}" must have boolean ok`);
    assert.equal(typeof c.detail, 'string', `check "${c.name}" must have string detail`);
    assert.equal(typeof c.fix, 'string', `check "${c.name}" must have string fix`);
    assert.equal(typeof c.mandatory, 'boolean', `check "${c.name}" must have boolean mandatory`);
  }
  const mandatory = mandatoryChecks(out);
  assert.ok(mandatory.length > 0, 'must have at least one mandatory check');
  for (const c of mandatory) {
    assert.equal(c.ok, true, `mandatory check "${c.name}" must be ok=true`);
  }
});

test('doctor --json --strict --font-dir <nonexistent> exits non-zero and names missing fonts', () => {
  const badDir = path.join(os.tmpdir(), 'ppt-engine-no-such-font-dir-' + Date.now());
  const res = runCli(['doctor', '--json', '--strict', '--font-dir', badDir]);
  assert.notEqual(res.status, 0, 'bad font-dir must exit non-zero');
  const out = JSON.parse(res.stdout);
  const fontChecks = out.checks.filter((c) => c.name.startsWith('font:'));
  assert.ok(fontChecks.length >= 5, `expected >=5 font checks, got ${fontChecks.length}`);
  for (const c of fontChecks) {
    assert.equal(c.ok, false, `font check "${c.name}" must fail with bad font-dir`);
    assert.match(c.detail, /NOT found/, `detail must say NOT found: ${c.detail}`);
    assert.ok(c.detail.includes(badDir), `detail must name the bad font dir: ${c.detail}`);
    assert.ok(c.fix.length > 0, `failed font check "${c.name}" must carry a fix hint`);
  }
});

test('optional checks (soffice/pdftoppm) never fail the exit code', () => {
  const res = runCli(['doctor', '--json', '--strict']);
  assert.equal(res.status, 0, 'doctor --strict must exit 0 when mandatory pass');
  const out = JSON.parse(res.stdout);
  for (const name of ['soffice', 'pdftoppm']) {
    const c = out.checks.find((x) => x.name === name);
    assert.ok(c, `checks must include "${name}"`);
    assert.equal(c.mandatory, false, `"${name}" must be optional`);
    assert.equal(c.ok, true, `"${name}" must keep ok=true even when missing`);
    assert.equal(typeof c.found, 'boolean', `"${name}" must carry a found flag`);
  }
  // exit code must equal mandatory-only status
  const mandatoryOk = mandatoryChecks(out).every((c) => c.ok);
  assert.equal(res.status, mandatoryOk ? 0 : 1);
});

test('--font-dir override works with a real copied font (positive case)', () => {
  const srcFont = path.join('C:\\Windows\\Fonts', 'arial.ttf');
  assert.ok(fs.existsSync(srcFont), 'arial.ttf must exist on this Windows box');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-engine-fonts-'));
  try {
    fs.copyFileSync(srcFont, path.join(tmpDir, 'arial.ttf'));
    const res = runCli(['doctor', '--json', '--strict', '--font-dir', tmpDir]);
    assert.notEqual(res.status, 0, 'only one font present -> mandatory fonts still fail overall');
    const out = JSON.parse(res.stdout);
    const arial = out.checks.find((c) => c.name === 'font:arial.ttf');
    assert.ok(arial, 'font:arial.ttf check must exist');
    assert.equal(arial.ok, true, 'copied arial.ttf must pass');
    assert.ok(arial.detail.includes(tmpDir), `detail must name the override dir: ${arial.detail}`);
    const msyh = out.checks.find((c) => c.name === 'font:msyh.ttc');
    assert.equal(msyh.ok, false, 'msyh.ttc must still be missing in the override dir');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});