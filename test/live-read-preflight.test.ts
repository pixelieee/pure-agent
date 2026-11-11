import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LIVE_LIMITS, parseLiveArguments } from '../examples/live-read-acceptance.ts';

// Only parser and preflight tests. No model/client construction or HTTP fixtures.
test('live parser requires an explicit run mode and accepts credential/model selectors', () => {
  assert.equal(parseLiveArguments([]).mode, 'missing');
  assert.equal(parseLiveArguments(['--credentials-file', 'missing.env']).mode, 'missing');
  assert.deepEqual(parseLiveArguments(['--run', '--credentials-file', 'private.env', '--model', 'gpt-5.6-luna']), {
    mode: 'run',
    credentialsFile: 'private.env',
    model: 'gpt-5.6-luna',
  });
  for (const mode of ['help', 'preflight'] as const) assert.equal(parseLiveArguments([`--${mode}`]).mode, mode);
  assert.equal(LIVE_LIMITS.maxOutputTokensTotal, LIVE_LIMITS.maxModelSteps * LIVE_LIMITS.maxOutputTokensPerStep);
  assert.equal(LIVE_LIMITS.automaticRetries, 0);
});

test('ambiguous, duplicate and unknown arguments are rejected without echoing values', () => {
  for (const args of [
    ['--run', '--help'],
    ['--run', '--preflight'],
    ['--run', '--run'],
    ['--preflight', '--preflight'],
    ['--credentials-file'],
    ['--credentials-file', ''],
    ['--credentials-file', '--run'],
    ['--credentials-file', 'first', '--credentials-file', 'second'],
    ['--model'],
    ['--model', 'first', '--model', 'second'],
    ['--model', 'not a model'],
    ['--model', 'a'.repeat(201)],
    ['--credentials-file', 'invalid\0path'],
    ['--api-key', 'do-not-echo'],
    ['--base-url', 'https://invalid.example'],
    ['--env-file', 'do-not-read.env'],
    ['--run=true'],
    ['--max-steps', '100'],
    ['--max-output-tokens', '999999'],
    ['unexpected-private-input'],
  ]) {
    assert.throws(() => parseLiveArguments(args), { message: 'LIVE_INVALID_ARGUMENT' });
  }
});

function assertSafeReport(report: unknown): void {
  assert.ok(report && typeof report === 'object' && !Array.isArray(report));
  for (const [key, value] of Object.entries(report)) {
    if (key === 'code')
      assert.ok(['LIVE_PREFLIGHT_ONLY', 'LIVE_RUN_REQUIRED', 'LIVE_INVALID_ARGUMENT'].includes(value));
    else if (value && typeof value === 'object') assertSafeReport(value);
    else assert.ok(typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value)));
  }
}

test('standalone help/preflight cannot import a provider, runtime or credential resolver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-live-preflight-'));
  try {
    const examples = join(root, 'examples');
    await mkdir(examples);
    const entry = join(examples, 'live-read-acceptance.ts');
    // There is no ../src or dependency installation here. Any dynamic production
    // import would fail, so successful preflight proves it stays before that gate.
    await copyFile(new URL('../examples/live-read-acceptance.ts', import.meta.url), entry);
    const cases: { args: string[]; status: number; code?: string }[] = [
      { args: ['--help'], status: 0 },
      { args: ['--credentials-file', 'must-not-be-read.env', '--help'], status: 0 },
      { args: ['--preflight'], status: 0, code: 'LIVE_PREFLIGHT_ONLY' },
      { args: ['--credentials-file', 'must-not-be-read.env', '--preflight'], status: 0, code: 'LIVE_PREFLIGHT_ONLY' },
      { args: [], status: 2, code: 'LIVE_RUN_REQUIRED' },
      { args: ['--credentials-file', 'must-not-be-read.env'], status: 2, code: 'LIVE_RUN_REQUIRED' },
      { args: ['--base-url', 'do-not-echo'], status: 2, code: 'LIVE_INVALID_ARGUMENT' },
      { args: ['--run', '--preflight'], status: 2, code: 'LIVE_INVALID_ARGUMENT' },
    ];
    for (const { args, status, code } of cases) {
      assert.notEqual(parseMode(args), 'run', 'Never launch an opted-in live run from these tests');
      const child = spawnSync(process.execPath, [entry, ...args], {
        cwd: root,
        env: { NO_COLOR: '1' }, // Do not inherit credentials, preload flags or host configuration.
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 32_768,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.signal, null);
      assert.equal(child.status, status);
      assert.equal(child.stderr, '');
      assert.ok(!child.stdout.includes(root));
      assert.ok(!child.stdout.includes('must-not-be-read.env'));
      assert.ok(!child.stdout.includes('do-not-echo'));
      if (code) {
        const report = JSON.parse(child.stdout);
        assertSafeReport(report);
        assert.equal(report.code, code);
        assert.equal(report.passed, false);
        assert.equal(report.liveAttempted, false);
        assert.equal(report.preflightOnly, code === 'LIVE_PREFLIGHT_ONLY');
        assert.deepEqual(report.limits, LIVE_LIMITS);
        assert.ok(Object.values(report.counts).every((value) => value === 0));
        assert.ok(Object.values(report.checks).every((value) => value === false));
      } else assert.match(child.stdout, /calls may cost money/);
      assert.deepEqual(await readdir(root), ['examples']);
      assert.deepEqual(await readdir(examples), ['live-read-acceptance.ts']);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function parseMode(args: readonly string[]): string {
  try {
    return parseLiveArguments(args).mode;
  } catch {
    return 'invalid';
  }
}
