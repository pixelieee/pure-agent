import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CredentialError, resolveOpenAIKey } from '../src/credentials.ts';

// These checks exercise real credential files and CLI preflight only.
// They do not create a model, intercept HTTP, or simulate model responses.
async function fixture(body: string | Uint8Array, run: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pure-credentials-'));
  try {
    const path = join(root, 'credentials.env');
    await writeFile(path, body, { mode: 0o600 });
    await run(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('explicit dotenv credentials support comments, export and quoted values', async () => {
  await fixture('# private credentials\nexport OPENAI_API_KEY="test-only-value"\n', async (path) => {
    assert.equal(await resolveOpenAIKey({}, path), 'test-only-value');
  });
});

test('environment wins without modifying either environment object', async () => {
  const before = process.env.OPENAI_API_KEY;
  const env = Object.freeze({ OPENAI_API_KEY: '  test-only-environment  ' });
  await fixture('OPENAI_API_KEY=test-only-file\n', async (path) => {
    assert.equal(await resolveOpenAIKey(env, path), 'test-only-environment');
    assert.equal(env.OPENAI_API_KEY, '  test-only-environment  ');
    assert.ok(process.env.OPENAI_API_KEY === before, 'Global credential environment must remain unchanged');
  });
});

test('unrelated dotenv settings cannot change process behavior', async () => {
  const before = {
    options: process.env.NODE_OPTIONS,
    endpoint: process.env.OPENAI_BASE_URL,
    proxy: process.env.HTTPS_PROXY,
  };
  await fixture(
    'OPENAI_API_KEY=test-only-value\nNODE_OPTIONS=--invalid-option\nOPENAI_BASE_URL=https://invalid.example\nHTTPS_PROXY=https://invalid.example\n',
    async (path) => {
      assert.equal(await resolveOpenAIKey({}, path), 'test-only-value');
      assert.ok(process.env.NODE_OPTIONS === before.options, 'Global Node options must remain unchanged');
      assert.ok(process.env.OPENAI_BASE_URL === before.endpoint, 'Global endpoint environment must remain unchanged');
      assert.ok(process.env.HTTPS_PROXY === before.proxy, 'Global proxy environment must remain unchanged');
    },
  );
});

test('missing and explicitly empty keys fail without fallback or auto-discovery', async () => {
  await assert.rejects(resolveOpenAIKey({}), { code: 'OPENAI_API_KEY_REQUIRED' });
  await fixture('OPENAI_API_KEY=test-only-file\n', async (path) => {
    await assert.rejects(resolveOpenAIKey({ OPENAI_API_KEY: '  ' }, path), { code: 'OPENAI_API_KEY_REQUIRED' });
  });
  for (const body of ['# no credential\n', 'OPENAI_API_KEY=\n', 'OTHER_KEY=test-only-value\n']) {
    await fixture(body, async (path) => {
      await assert.rejects(resolveOpenAIKey({}, path), { code: 'OPENAI_API_KEY_REQUIRED' });
    });
  }
});

test('explicit files must be readable regular files even when an environment key exists', async () => {
  await fixture('ignored', async (path) => {
    for (const target of [`${path}.missing`, join(path, '..')]) {
      await assert.rejects(resolveOpenAIKey({ OPENAI_API_KEY: 'test-only-value' }, target), (error: unknown) => {
        assert.ok(error instanceof CredentialError);
        assert.equal(error.code, 'ENV_FILE');
        assert.ok(!error.message.includes(target));
        assert.ok(!error.message.includes('test-only-value'));
        return true;
      });
    }
  });
});

test('invalid UTF-8 and oversized inputs fail with content-free errors', async () => {
  for (const body of [new Uint8Array([0xff]), '#'.repeat(65537)]) {
    await fixture(body, async (path) => {
      await assert.rejects(resolveOpenAIKey({}, path), { code: 'ENV_FILE' });
    });
  }
});

test('64 KiB UTF-8 regular files are accepted at the boundary', async () => {
  const prefix = 'OPENAI_API_KEY=test-only-value\n#';
  await fixture(prefix + 'x'.repeat(65536 - prefix.length), async (path) => {
    assert.equal(await resolveOpenAIKey({}, path), 'test-only-value');
  });
});

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
test('actual CLI reports bad credential-file preflight without echoing path or values', async () => {
  await fixture(new Uint8Array([0xff]), async (path) => {
    const child = spawnSync(process.execPath, [cli, '--credentials-file', path, '--read-only'], {
      env: { TERM: 'dumb' },
      encoding: 'utf8',
      timeout: 10000,
      input: '',
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 2);
    assert.match(child.stderr, /Could not read the explicit env file/);
    assert.ok(!child.stderr.includes(path));
    assert.equal(child.stdout, '');
  });
});

test('actual CLI rejects repeated credential-file flags before reading credentials', () => {
  const child = spawnSync(
    process.execPath,
    [cli, '--credentials-file', 'first', '--credentials-file', 'second', '--read-only'],
    {
      env: { TERM: 'dumb' },
      encoding: 'utf8',
      timeout: 10000,
      input: '',
    },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 2);
  assert.equal(child.stderr, 'Invalid argument. Use --help for usage.\n');
  assert.equal(child.stdout, '');
});

test('actual CLI reads the key without applying Node settings or calling a model', async () => {
  await fixture('OPENAI_API_KEY=test-only-value\nNODE_OPTIONS=--invalid-option\n', async (path) => {
    const child = spawnSync(
      process.execPath,
      [cli, '--credentials-file', path, '--cwd', `${path}.missing-workspace`, '--read-only'],
      { env: { TERM: 'dumb' }, encoding: 'utf8', timeout: 10000, input: '' },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 2);
    // The real CLI accepted the key, then stopped before model creation at workspace validation.
    assert.equal(child.stderr, 'Workspace must be an accessible existing directory.\n');
    assert.equal(child.stdout, '');
  });
});

test('actual CLI help does not attempt to read credential files', () => {
  const child = spawnSync(process.execPath, [cli, '--credentials-file', 'missing-file', '--help'], {
    env: { TERM: 'dumb' },
    encoding: 'utf8',
    timeout: 10000,
    input: '',
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.match(child.stdout, /--credentials-file/);
});

test('actual CLI never discovers a launch-directory dotenv file', async () => {
  await fixture('OPENAI_API_KEY=test-only-undiscovered\n', async (path) => {
    const root = join(path, '..');
    await writeFile(join(root, '.env'), 'OPENAI_API_KEY=test-only-undiscovered\n', { mode: 0o600 });
    const child = spawnSync(process.execPath, [cli, '--read-only'], {
      cwd: root,
      env: { TERM: 'dumb' },
      encoding: 'utf8',
      timeout: 10000,
      input: '',
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 2);
    assert.match(child.stderr, /^OPENAI_API_KEY is required/);
    assert.ok(!child.stderr.includes('test-only-undiscovered'));
    assert.equal(child.stdout, '');
  });
});

test('actual CLI resolves a relative credential path from launch directory before workspace validation', async () => {
  await fixture('OPENAI_API_KEY=test-only-relative\n', async (path) => {
    const child = spawnSync(
      process.execPath,
      [cli, '--credentials-file', 'credentials.env', '--cwd', 'missing-workspace', '--read-only'],
      { cwd: join(path, '..'), env: { TERM: 'dumb' }, encoding: 'utf8', timeout: 10000, input: '' },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 2);
    assert.equal(child.stderr, 'Workspace must be an accessible existing directory.\n');
    assert.equal(child.stdout, '');
  });
});

test('actual CLI rejects empty environment credentials without exposing the file key', async () => {
  await fixture('OPENAI_API_KEY=test-only-no-fallback\n', async (path) => {
    const child = spawnSync(process.execPath, [cli, '--credentials-file', path, '--read-only'], {
      env: { TERM: 'dumb', OPENAI_API_KEY: ' ' },
      encoding: 'utf8',
      timeout: 10000,
      input: '',
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 2);
    assert.match(child.stderr, /^OPENAI_API_KEY is required/);
    assert.ok(!child.stderr.includes('test-only-no-fallback'));
    assert.ok(!child.stderr.includes(path));
    assert.equal(child.stdout, '');
  });
});
