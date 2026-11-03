import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createAgent } from '../src/core.ts';
import type { AgentSnapshot } from '../src/core.ts';
import { createSessionStore } from '../src/session.ts';
import type { SessionIdentity, SessionRecord } from '../src/session.ts';

const snapshot: AgentSnapshot = {
  version: 1,
  messages: [
    { role: 'user', content: 'Fixture request' },
    { role: 'assistant', content: 'Fixture response' },
  ],
};
async function fixture(run: (path: string, identity: SessionIdentity) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pure-agent-session-'));
  try {
    await run(join(root, 'saved.json'), { provider: 'fixture', model: 'offline-model', workspaceRoot: root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const code = (expected: string) => (error: unknown) => {
  assert.ok(error && typeof error === 'object' && 'code' in error);
  assert.equal(error.code, expected);
  return true;
};

test('explicit session file round-trips private versioned metadata, history, and continuation data', async () => {
  await fixture(async (path, identity) => {
    const originalIdentity = { ...identity, workspaceRoot: join(identity.workspaceRoot, '.', 'nested', '..') };
    const store = createSessionStore({ path, identity: originalIdentity });
    originalIdentity.model = 'mutated';
    await assert.rejects(store.load(), code('ENOENT'));
    const supplied = structuredClone(snapshot);
    supplied.messages[1].providerData = { kind: 'fixture', data: { reasoning: 'opaque', ids: [1, 2] } };
    const expectedSnapshot = structuredClone(supplied);
    const pending = store.save(supplied, { status: 'completed' });
    supplied.messages[0].content = 'changed after save was requested';
    const first = await pending;
    assert.equal(first.format, 'pure-agent.session');
    assert.equal(first.version, 1);
    assert.equal(first.revision, 1);
    assert.equal(first.identity.workspaceRoot, resolve(identity.workspaceRoot));
    assert.deepEqual(first.lastRun, { status: 'completed' });
    assert.deepEqual(first.snapshot, expectedSnapshot);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), first);
    assert.match(await readFile(path, 'utf8'), /\n {2}"version": 1,/u);
    first.snapshot.messages[0].content = 'changed returned record';
    first.identity.model = 'changed returned identity';
    const independent = createSessionStore({ path, identity });
    const loaded = await independent.load();
    assert.deepEqual(loaded.snapshot, expectedSnapshot);
    const agent = createAgent({ model: { complete: async () => ({ role: 'assistant', content: 'resumed' }) } });
    agent.restore(loaded.snapshot);
    assert.equal((await agent.run('Next')).status, 'completed');
    const second = await independent.save(agent.snapshot(), { status: 'completed' });
    assert.equal(second.id, loaded.id);
    assert.equal(second.createdAt, loaded.createdAt);
    assert.equal(second.revision, 2);
    assert.ok(second.updatedAt >= loaded.updatedAt);
    assert.equal(second.snapshot.messages.at(-1)?.content, 'resumed');
    if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(identity.workspaceRoot), ['saved.json']);
  });
});

test('existing sessions require an explicit load, and stale or deleted baselines cannot overwrite', async () => {
  await fixture(async (path, identity) => {
    const owner = createSessionStore({ path, identity });
    await owner.save(snapshot);
    const unopened = createSessionStore({ path, identity });
    await assert.rejects(unopened.save(snapshot), code('SESSION_EXISTS'));
    const stale = createSessionStore({ path, identity });
    await stale.load();
    await owner.save(snapshot);
    const current = await readFile(path, 'utf8');
    await assert.rejects(stale.save(snapshot), code('SESSION_CONFLICT'));
    assert.equal(await readFile(path, 'utf8'), current);
    await stale.load();
    assert.equal((await stale.save(snapshot)).revision, 3);
    await rm(path);
    await assert.rejects(stale.save(snapshot), code('SESSION_CONFLICT'));
    await assert.rejects(readFile(path), code('ENOENT'));
  });
});

test('concurrent saves on one store serialize complete atomic records with increasing revisions', async () => {
  await fixture(async (path, identity) => {
    const store = createSessionStore({ path, identity });
    const results = await Promise.all(Array.from({ length: 8 }, () => store.save(snapshot)));
    assert.deepEqual(
      results.map((result) => result.revision),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.deepEqual(await store.load(), results.at(-1));
    assert.deepEqual(await readdir(identity.workspaceRoot), ['saved.json']);
  });
});

test('foreign writer locks are never deleted or stolen, even if their content looks stale', async () => {
  await fixture(async (path, identity) => {
    const lock = `${path}.lock`;
    await writeFile(lock, '{"pid":-1,"createdAt":"1970-01-01T00:00:00.000Z"}');
    const store = createSessionStore({ path, identity });
    await assert.rejects(store.save(snapshot), code('SESSION_LOCKED'));
    assert.equal(await readFile(lock, 'utf8'), '{"pid":-1,"createdAt":"1970-01-01T00:00:00.000Z"}');
    await assert.rejects(readFile(path), code('ENOENT'));
  });
});

test('corrupt, incompatible, and malformed records are not restored or overwritten', async () => {
  await fixture(async (path, identity) => {
    const store = createSessionStore({ path, identity });
    const original = await store.save(snapshot);
    const cases: [unknown, string][] = [
      ['{not json', 'SESSION_CORRUPT'],
      [Buffer.from([0xc0, 0xaf]), 'SESSION_CORRUPT'],
      [{ ...original, format: 'another-product' }, 'SESSION_VERSION'],
      [{ ...original, version: 2 }, 'SESSION_VERSION'],
      [{ ...original, id: 'arbitrary-id' }, 'SESSION_INVALID'],
      [{ ...original, revision: 0 }, 'SESSION_INVALID'],
      [{ ...original, revision: 1.5 }, 'SESSION_INVALID'],
      [{ ...original, createdAt: 'yesterday' }, 'SESSION_INVALID'],
      [{ ...original, updatedAt: '1970-01-01T00:00:00.000Z' }, 'SESSION_INVALID'],
      [{ ...original, extra: 'unknown' }, 'SESSION_INVALID'],
      [{ ...original, identity: { ...identity, apiKey: 'invalid-fixture-placeholder' } }, 'SESSION_INVALID'],
      [{ ...original, identity: { ...identity, model: 'different-model' } }, 'SESSION_IDENTITY'],
      [{ ...original, identity: { ...identity, provider: 'different-provider' } }, 'SESSION_IDENTITY'],
      [
        { ...original, identity: { ...identity, workspaceRoot: join(identity.workspaceRoot, 'other') } },
        'SESSION_IDENTITY',
      ],
      [{ ...original, snapshot: { version: 2, messages: [] } }, 'SESSION_INVALID'],
      [
        { ...original, snapshot: { version: 1, messages: [{ role: 'tool', content: 'done', tool_call_id: 'a' }] } },
        'SESSION_INVALID',
      ],
      [{ ...original, lastRun: { status: 'running' } }, 'SESSION_INVALID'],
      [{ ...original, lastRun: { status: 'completed', unexpected: true } }, 'SESSION_INVALID'],
    ];
    for (const [invalid, expectedCode] of cases) {
      const bytes = typeof invalid === 'string' || Buffer.isBuffer(invalid) ? invalid : JSON.stringify(invalid);
      await writeFile(path, bytes);
      await assert.rejects(store.load(), code(expectedCode));
      await assert.rejects(store.save(snapshot), code(expectedCode));
      assert.deepEqual(await readFile(path), Buffer.from(bytes));
      assert.deepEqual(await readdir(identity.workspaceRoot), ['saved.json']);
    }
  });
});

test('size limits reject loads and saves without replacing the previous good record', async () => {
  await fixture(async (path, identity) => {
    const store = createSessionStore({ path, identity });
    const original = await store.save(snapshot);
    const bytes = await readFile(path);
    const limited = createSessionStore({ path, identity, maxBytes: bytes.length });
    await limited.load();
    const large: AgentSnapshot = {
      version: 1,
      messages: [{ role: 'user', content: 'x'.repeat(bytes.length) }],
    };
    await assert.rejects(limited.save(large), code('SESSION_TOO_LARGE'));
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(await store.load(), original);
    const tooSmall = createSessionStore({ path, identity, maxBytes: bytes.length - 1 });
    await assert.rejects(tooSmall.load(), code('SESSION_TOO_LARGE'));
  });
});

test('regular-file checks reject session symlinks and directories without touching the target', async () => {
  await fixture(async (path, identity) => {
    const target = join(identity.workspaceRoot, 'target.json');
    const real = createSessionStore({ path: target, identity });
    await real.save(snapshot);
    const original = await readFile(target);
    await symlink(target, path, 'file');
    const store = createSessionStore({ path, identity });
    await assert.rejects(store.load(), code('SESSION_UNSAFE_PATH'));
    await assert.rejects(store.save(snapshot), code('SESSION_UNSAFE_PATH'));
    assert.deepEqual(await readFile(target), original);
    assert.equal((await lstat(path)).isSymbolicLink(), true);
    await rm(path);
    await mkdir(path);
    await assert.rejects(store.load(), code('SESSION_UNSAFE_PATH'));
    await assert.rejects(store.save(snapshot), code('SESSION_UNSAFE_PATH'));
  });
});

test('saving uses restrictive permissions even when replacing a broadly readable existing session', async () => {
  await fixture(async (path, identity) => {
    const store = createSessionStore({ path, identity });
    await store.save(snapshot);
    await chmod(path, 0o644);
    await store.save(snapshot);
    if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o777, 0o600);
  });
});

test('session selection never scans sibling files and creates only the selected parent directory', async () => {
  await fixture(async (path, identity) => {
    await writeFile(path, 'corrupt sibling that must not be examined');
    const selected = join(identity.workspaceRoot, 'nested', 'explicit.json');
    const store = createSessionStore({ path: selected, identity });
    await store.save(snapshot);
    assert.deepEqual((await store.load()).snapshot, snapshot);
    assert.equal(await readFile(path, 'utf8'), 'corrupt sibling that must not be examined');
  });
});

test('invalid snapshot and metadata requests do not create files or leak unrelated config', async () => {
  await fixture(async (path, identity) => {
    const store = createSessionStore({ path, identity });
    await assert.rejects(store.save({ version: 1, messages: [{ role: 'tool', content: 'x' }] }));
    await assert.rejects(store.save(snapshot, { status: 'running' } as never), code('SESSION_INVALID'));
    assert.deepEqual(await readdir(identity.workspaceRoot), []);
    const agent = createAgent({ model: { complete: async () => ({ role: 'assistant', content: 'Done' }) } });
    await agent.run('Hello');
    const saved = await store.save(agent.snapshot());
    assert.deepEqual(Object.keys(saved).sort(), [
      'createdAt',
      'format',
      'id',
      'identity',
      'revision',
      'snapshot',
      'updatedAt',
      'version',
    ]);
    const revised = { ...saved, revision: Number.MAX_SAFE_INTEGER } satisfies SessionRecord;
    await writeFile(path, JSON.stringify(revised));
    await store.load();
    await assert.rejects(store.save(snapshot), code('SESSION_INVALID'));
    assert.equal(JSON.parse(await readFile(path, 'utf8')).revision, Number.MAX_SAFE_INTEGER);
  });
});
