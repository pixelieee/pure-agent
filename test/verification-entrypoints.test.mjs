import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const refusal = 'node scripts/refuse-legacy-verification.mjs';

// Inspect scripts before executing anything: a regression cannot launch a legacy suite.
test('ambiguous verification commands fail closed without lifecycle hooks', () => {
  for (const name of ['test', 'check', 'test:package']) {
    assert.equal(manifest.scripts[name], refusal);
    assert.equal(manifest.scripts[`pre${name}`], undefined);
    assert.equal(manifest.scripts[`post${name}`], undefined);
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/refuse-legacy-verification.mjs', root))], {
    cwd: root,
    env: {},
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Verification refused/);
  assert.match(result.stderr, /component checks only/);
  assert.match(result.stderr, /Real API acceptance is separate and pending/);
});
