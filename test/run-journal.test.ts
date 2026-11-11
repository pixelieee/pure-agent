import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCheckpointWriter } from '../src/checkpoint.ts';
import type { AgentCheckpoint } from '../src/checkpoint.ts';
import { executeToolCalls, registerTools } from '../src/tool-execution.ts';
import { createFileTools } from '../src/tools/filesystem.ts';
import type { AgentSnapshot, ToolCall } from '../src/core.ts';
import { createRunJournal, createRunJournalStore, reduceRunJournal, validateRunJournal } from '../src/run-journal.ts';

// Stored transcript fixtures and real filesystem operations only. No model or HTTP response substitutes.
const empty: AgentSnapshot = { version: 1, messages: [] };
const admitted: AgentSnapshot = { version: 1, messages: [{ role: 'user', content: 'Stored request' }] };
const initial = () => createRunJournal('task-1', 7, empty);
const beforeModel: AgentCheckpoint = { stage: 'before_model', step: 1, snapshot: admitted };
const beforeTools: AgentCheckpoint = {
  stage: 'before_tools',
  step: 1,
  snapshot: admitted,
  calls: [{ id: 'call-1', name: 'write' }],
};
const paired: AgentSnapshot = {
  version: 1,
  messages: [
    ...admitted.messages,
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'write', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'stored result' },
  ],
};
const terminal: AgentCheckpoint = {
  stage: 'terminal',
  snapshot: empty,
  result: { status: 'cancelled', text: '', steps: 0 },
};
const transition = (record: ReturnType<typeof initial>, checkpoint: AgentCheckpoint) =>
  reduceRunJournal(record, record, { kind: 'checkpoint', checkpoint });
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pure-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'run.json');
  return { directory, path, store: createRunJournalStore({ path }) };
}

test('reducer fences all transitions and preserves intent on interruption', () => {
  const record = transition(transition(initial(), beforeModel), beforeTools);
  for (const fence of [
    { ...record, taskId: 'other' },
    { ...record, runId: 8 },
    { ...record, revision: 1 },
  ]) {
    for (const update of [
      { kind: 'interrupted' },
      { kind: 'failed' },
      { kind: 'checkpoint', checkpoint: terminal },
    ] as const) {
      assert.throws(() => reduceRunJournal(record, fence, update), { code: 'CONFLICT' });
    }
  }
  const stopped = reduceRunJournal(record, record, { kind: 'interrupted' });
  assert.deepEqual(stopped.pendingTools, beforeTools.calls);
  assert.equal(stopped.resources, 'unknown');
  assert.throws(() => transition(stopped, beforeModel), { code: 'TRANSITION' });
  assert.throws(() => transition(record, terminal), { code: 'TRANSITION' });
  assert.throws(() => transition(record, { stage: 'after_tools', step: 1, snapshot: empty }), { code: 'HISTORY' });
});

test('strict schema, contiguous sequence, complete snapshots and bounded event history', () => {
  const record = initial();
  for (const value of [
    { ...record, version: 2 },
    { ...record, runId: 0 },
    { ...record, revision: Number.MAX_SAFE_INTEGER },
    { ...record, extra: true },
    { ...record, resources: 'released' },
    { ...record, events: [{ sequence: 2, phase: 'accepted' }] },
    { ...record, snapshot: { version: 1, messages: paired.messages.slice(0, 2) } },
    { ...record, pendingTools: beforeTools.calls },
    { ...record, outcome: 'completed' },
  ])
    assert.throws(() => validateRunJournal(value));
  let full = record;
  for (let i = 0; i < 341; i++) {
    full = transition(full, { ...beforeModel, snapshot: i === 0 ? admitted : full.snapshot });
    full = transition(full, { ...beforeTools, snapshot: full.snapshot });
    // Build a new, real persisted-data pairing for this reducer test.
    full = transition(full, {
      stage: 'after_tools',
      step: 1,
      snapshot: { version: 1, messages: [...full.snapshot.messages, ...paired.messages.slice(1)] },
    });
  }
  assert.equal(full.revision, 1024);
  assert.throws(() => transition(full, { ...terminal, snapshot: full.snapshot }));
});

test('real private persistence, detached snapshots, stale concurrent writers and terminal resource uncertainty', async (t) => {
  const { path, store } = await fixture(t);
  const input = initial();
  const promise = store.create(input);
  input.taskId = 'mutated';
  const created = await promise;
  assert.equal(created.taskId, 'task-1');
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const other = createRunJournalStore({ path });
  const stale = await other.load();
  let current = await store.transition(created, { kind: 'checkpoint', checkpoint: beforeModel });
  await assert.rejects(other.transition(stale, { kind: 'failed' }), { code: 'CONFLICT' });
  current = await store.transition(current, {
    kind: 'checkpoint',
    checkpoint: { ...terminal, snapshot: current.snapshot },
  });
  assert.equal(current.outcome, 'cancelled');
  assert.equal(current.resources, 'unknown');
  const reopened = await other.load();
  assert.deepEqual(reopened, current);
  reopened.events[0].phase = 'failed';
  assert.equal((await store.load()).events[0].phase, 'accepted');
  await assert.rejects(store.create(initial()), { code: 'EXISTS' });
});

test('callback commits intent before actual file effect, then complete paired snapshot', async (t) => {
  const { directory, store } = await fixture(t);
  let current = await store.create(initial());
  const writer = createCheckpointWriter(async (checkpoint) => {
    current = await store.transition(current, { kind: 'checkpoint', checkpoint });
  });
  await writer(beforeModel);
  await writer(beforeTools);
  assert.deepEqual((await store.load()).pendingTools, beforeTools.calls);
  const call: ToolCall = {
    id: 'call-1',
    type: 'function',
    function: {
      name: 'write',
      arguments: JSON.stringify({ path: 'effect', content: 'actual effect' }),
    },
  };
  const results = await executeToolCalls(
    [call],
    registerTools(createFileTools({ root: directory })),
    new AbortController().signal,
    async () => {},
  );
  const actual: AgentSnapshot = {
    version: 1,
    messages: [
      ...admitted.messages,
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: results[0] as string },
    ],
  };
  await writer({ stage: 'after_tools', step: 1, snapshot: actual });
  assert.equal((await store.load()).pendingTools, null);
  assert.equal(await readFile(join(directory, 'effect'), 'utf8'), 'actual effect');
  const failed = createCheckpointWriter(async (checkpoint) => {
    await store.transition({ ...current, revision: 1 }, { kind: 'checkpoint', checkpoint });
  });
  await assert.rejects(failed({ ...terminal, snapshot: actual }), { name: 'AgentCheckpointError' });
  assert.equal((await store.load()).phase, 'after_tools');
});

test('invalid UTF-8, corruption, size limits, permissions, links and orphan locks fail closed', async (t) => {
  const { directory, path, store } = await fixture(t);
  const record = await store.create(initial());
  const original = await readFile(path);
  for (const body of [Buffer.from([0xff]), Buffer.from('{')]) {
    await writeFile(path, body);
    await assert.rejects(store.load(), { code: 'CORRUPT' });
  }
  await writeFile(path, original);
  await assert.rejects(createRunJournalStore({ path, maxBytes: 1 }).load(), { code: 'SIZE' });
  await assert.rejects(
    createRunJournalStore({ path, maxBytes: original.length }).transition(record, { kind: 'failed' }),
    { code: 'SIZE' },
  );
  assert.deepEqual(await readFile(path), original);
  await chmod(path, 0o644);
  await assert.rejects(store.load(), { code: 'PERMISSIONS' });
  await chmod(path, 0o600);
  await writeFile(`${path}.lock`, '', { mode: 0o600 });
  await assert.rejects(store.transition(record, { kind: 'failed' }), { code: 'LOCKED' });
  await rm(`${path}.lock`);
  const target = join(directory, 'target');
  await writeFile(target, original, { mode: 0o600 });
  await rm(path);
  await symlink(target, path);
  await assert.rejects(store.load(), { code: 'UNSAFE_PATH' });
  await assert.rejects(store.transition(record, { kind: 'failed' }), { code: 'UNSAFE_PATH' });
  const realParent = join(directory, 'real');
  await mkdir(realParent, { mode: 0o700 });
  const alias = join(directory, 'alias');
  await symlink(realParent, alias);
  await assert.rejects(createRunJournalStore({ path: join(alias, 'run') }).create(initial()), { code: 'UNSAFE_PATH' });
  await chmod(directory, 0o755);
  await assert.rejects(store.load(), { code: 'PERMISSIONS' });
});

const moduleUrl = new URL('../src/run-journal.ts', import.meta.url).href;
// Fault boundaries use actual filesystem syscalls in a separate owned process, not model substitutes.
async function child(source: string, args: string[]) {
  return spawn(process.execPath, ['--input-type=module', '-e', source, ...args], {
    env: {},
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
}
test('owned writer crash leaves lock, old committed record and real effect uncertainty', {
  timeout: 10000,
}, async (t) => {
  const { directory, path, store } = await fixture(t);
  let current = await store.create(initial());
  current = await store.transition(current, { kind: 'checkpoint', checkpoint: beforeModel });
  current = await store.transition(current, { kind: 'checkpoint', checkpoint: beforeTools });
  const proc = await child(
    `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    fs.rename = async () => { process.send('before-rename'); await new Promise(() => {}); };
    syncBuiltinESMExports();
    const { createRunJournalStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createRunJournalStore({ path: process.argv[1] });
    const record = await store.load();
    await fs.writeFile(process.argv[2], 'effect happened', { mode: 0o600 });
    await store.transition(record, { kind: 'interrupted' });
  `,
    [path, join(directory, 'effect')],
  );
  t.after(() => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  });
  assert.deepEqual((await once(proc, 'message'))[0], 'before-rename');
  const exit = once(proc, 'exit');
  proc.kill('SIGKILL');
  assert.deepEqual(await exit, [null, 'SIGKILL']);
  assert.equal((await store.load()).phase, 'before_tools');
  assert.equal(await readFile(join(directory, 'effect'), 'utf8'), 'effect happened');
  await assert.rejects(store.transition(current, { kind: 'interrupted' }), { code: 'LOCKED' });
  assert.ok((await lstat(`${path}.lock`)).isFile());
});

test('post-rename directory sync failure reports uncertain and reread reveals committed state', {
  timeout: 10000,
}, async (t) => {
  const { path, store } = await fixture(t);
  await store.create(initial());
  const proc = await child(
    `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const open = fs.open;
    fs.open = async (...args) => {
      const handle = await open(...args);
      if ((await handle.stat()).isDirectory()) {
        const sync = handle.sync.bind(handle); let n = 0;
        handle.sync = async () => { if (++n === 2) throw new Error('injected sync failure'); return sync(); };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const { createRunJournalStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createRunJournalStore({ path: process.argv[1] });
    const record = await store.load();
    try { await store.transition(record, { kind: 'interrupted' }); }
    catch (error) { process.send(error.code); }
    process.disconnect();
  `,
    [path],
  );
  const exit = once(proc, 'exit');
  assert.equal((await once(proc, 'message'))[0], 'COMMIT_UNCERTAIN');
  assert.deepEqual(await exit, [0, null]);
  assert.equal((await store.load()).phase, 'interrupted');
  await assert.rejects(store.transition(initial(), { kind: 'failed' }), { code: 'CONFLICT' });
});

test('invalid data never commits and every successful commit immediately reloads', async (t) => {
  const { path, store } = await fixture(t);
  let record = await store.create(initial());
  assert.deepEqual(await store.load(), record);
  record = await store.transition(record, { kind: 'checkpoint', checkpoint: beforeModel });
  assert.deepEqual(await store.load(), record);
  const body = await readFile(path);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const extra = Object.assign([{ id: 'call-1', name: 'write' }], { extra: true });
  for (const value of [new Array(1), [undefined], [null], extra, [{ id: 'call-1', name: undefined }]]) {
    await assert.rejects(
      store.transition(record, { kind: 'checkpoint', checkpoint: { ...beforeTools, calls: value } } as never),
      { code: 'INVALID' },
    );
    assert.deepEqual(await readFile(path), body);
    assert.deepEqual(await store.load(), record);
  }
  await assert.rejects(store.transition(record, { kind: 'failed', checkpoint: cycle } as never), { code: 'INVALID' });
  await assert.rejects(store.transition(record, { kind: 'failed', checkpoint: {} } as never), { code: 'INVALID' });
  assert.deepEqual(await readFile(path), body);
  record = await store.transition(record, { kind: 'checkpoint', checkpoint: beforeTools });
  assert.deepEqual(await store.load(), record);
  record = await store.transition(record, {
    kind: 'checkpoint',
    checkpoint: { stage: 'after_tools', step: 1, snapshot: paired },
  });
  assert.deepEqual(await store.load(), record);
  record = await store.transition(record, { kind: 'checkpoint', checkpoint: { ...terminal, snapshot: paired } });
  assert.deepEqual(await store.load(), record);
});

test('accessors are rejected without evaluation at every public data boundary', async (t) => {
  const { path, store } = await fixture(t);
  const record = await store.create(initial());
  const body = await readFile(path);
  let invoked = 0;
  function accessor(value: object, key: string) {
    Object.defineProperty(value, key, {
      enumerable: true,
      get() {
        invoked++;
        throw new Error('PRIVATE_SENTINEL');
      },
    });
    return value;
  }
  for (const value of [
    accessor(initial(), 'taskId'),
    { ...initial(), events: [accessor({ sequence: 1, phase: 'accepted' }, 'phase')] },
    { ...initial(), snapshot: accessor({ version: 1, messages: [] }, 'messages') },
    { ...initial(), pendingTools: [accessor({ id: 'x', name: 'write' }, 'name')] },
  ]) {
    assert.throws(() => validateRunJournal(value), { code: 'INVALID' });
    await assert.rejects(store.create(value as never), { code: 'INVALID' });
  }
  for (const update of [
    accessor({ kind: 'failed' }, 'kind'),
    { kind: 'checkpoint', checkpoint: accessor({ ...beforeModel }, 'stage') },
    { kind: 'checkpoint', checkpoint: { ...beforeTools, calls: [accessor({ id: 'x', name: 'write' }, 'name')] } },
  ])
    await assert.rejects(store.transition(record, update as never), { code: 'INVALID' });
  await assert.rejects(store.transition(accessor({ ...record }, 'revision') as never, { kind: 'failed' }), {
    code: 'INVALID',
  });
  assert.throws(() => createRunJournalStore(accessor({ path }, 'path') as never), { code: 'INVALID' });
  assert.equal(invoked, 0);
  assert.deepEqual(await readFile(path), body);
});

test('public missing-file and directory errors contain only fixed safe codes', async (t) => {
  const { directory, path, store } = await fixture(t);
  const missing = createRunJournalStore({ path: join(directory, 'PRIVATE_SENTINEL', 'run') });
  const operations = [
    () => store.load(),
    () => missing.load(),
    () => missing.create(initial()),
    () => missing.transition(initial(), { kind: 'failed' }),
  ];
  for (const operation of operations)
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'RunJournalError');
      assert.equal(error.message, 'Run journal: NOT_FOUND');
      assert.equal(Object.hasOwn(error, 'path'), false);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.equal(JSON.stringify(error).includes(directory), false);
      return true;
    });
  await writeFile(path, 'bad', { mode: 0o600 });
  await assert.rejects(store.load(), { code: 'CORRUPT' });
});

test('precommit I/O and uncertain rename faults never expose original exception data', {
  timeout: 10000,
}, async (t) => {
  for (const mode of ['write', 'rename']) {
    const { path, store } = await fixture(t);
    await store.create(initial());
    const proc = await child(
      `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const secret = () => Object.assign(new Error('PRIVATE_SENTINEL ' + process.argv[1]), { path: process.argv[1] });
      if (process.argv[2] === 'rename') {
        const rename = fs.rename;
        fs.rename = async (...args) => { await rename(...args); throw secret(); };
      } else {
        const open = fs.open;
        fs.open = async (...args) => {
          const handle = await open(...args);
          if (String(args[0]).endsWith('.tmp')) handle.sync = async () => { throw secret(); };
          return handle;
        };
      }
      syncBuiltinESMExports();
      const { createRunJournalStore } = await import(${JSON.stringify(moduleUrl)});
      const store = createRunJournalStore({ path: process.argv[1] });
      try { await store.transition(await store.load(), { kind: 'interrupted' }); }
      catch (error) { process.send({ code: error.code, message: error.message, path: Object.hasOwn(error, 'path'), cause: Object.hasOwn(error, 'cause') }); }
      process.disconnect();
    `,
      [path, mode],
    );
    const exit = once(proc, 'exit');
    const expected = mode === 'rename' ? 'COMMIT_UNCERTAIN' : 'IO';
    assert.deepEqual((await once(proc, 'message'))[0], {
      code: expected,
      message: `Run journal: ${expected}`,
      path: false,
      cause: false,
    });
    assert.deepEqual(await exit, [0, null]);
    assert.equal((await store.load()).phase, mode === 'rename' ? 'interrupted' : 'accepted');
  }
});

test('checkpoint discriminants and malformed history fail safely in reducer and store', async (t) => {
  const { store } = await fixture(t);
  const record = await store.create(initial());
  const orphan = { version: 1, messages: [{ role: 'tool', tool_call_id: 'x', content: 'PRIVATE_SENTINEL' }] };
  for (const checkpoint of [
    { stage: 'interrupted', step: 1, snapshot: empty },
    { stage: 'failed', step: 1, snapshot: empty },
    { stage: 'before_model', step: 1, snapshot: orphan },
  ]) {
    const update = { kind: 'checkpoint', checkpoint } as never;
    const expected = { name: 'RunJournalError', code: 'INVALID', message: 'Run journal: INVALID' };
    assert.throws(() => reduceRunJournal(record, record, update), expected);
    await assert.rejects(store.transition(record, update), expected);
    assert.deepEqual(await store.load(), record);
  }
});
