import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentCheckpoint, AgentSnapshot } from '../src/core.ts';
import {
  createTaskRecord,
  createTaskRecordStore,
  reduceTaskRecord,
  taskFence,
  validateTaskRecord,
} from '../src/task-record.ts';
import type { TaskTransition } from '../src/task-record.ts';

// Stored lifecycle data and real filesystem checks. No Agent, Model or HTTP substitutes.
const snapshot: AgentSnapshot = { version: 1, messages: [] };
const initial = () => createTaskRecord('task-1', 'request-1', 'Private task input', snapshot);
const terminal: AgentCheckpoint = { stage: 'terminal', snapshot, result: { status: 'cancelled', text: '', steps: 0 } };
const step = (record: ReturnType<typeof initial>, change: TaskTransition) =>
  reduceTaskRecord(record, taskFence(record), change);
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pure-task-record-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'task.json');
  return { path, store: createTaskRecordStore({ path }) };
}

test('one envelope fences task/run/revision and separates terminal result from disposal', () => {
  let record = initial();
  for (const fence of [
    { ...taskFence(record), taskId: 'other' },
    { ...taskFence(record), runId: 2 },
    { ...taskFence(record), revision: 2 },
  ])
    assert.throws(() => reduceTaskRecord(record, fence, { kind: 'running' }), { code: 'CONFLICT' });
  record = step(record, { kind: 'cancelling' });
  assert.equal(record.run.phase, 'accepted');
  record = step(record, { kind: 'checkpoint', checkpoint: terminal });
  assert.equal(record.status, 'cancelled');
  assert.equal(record.cleanup, 'owned');
  assert.equal(record.run.resources, 'unknown');
  assert.throws(() => step(record, { kind: 'cancelling' }), { code: 'TRANSITION' });
  assert.throws(() => step(record, { kind: 'dispose_settled' }), { code: 'TRANSITION' });
  record = step(record, { kind: 'cleanup_pending' });
  const failed = step(record, { kind: 'cleanup_failed' });
  record = step(record, { kind: 'dispose_settled' });
  assert.equal(failed.status, 'cancelled');
  assert.equal(failed.cleanup, 'failed');
  assert.equal(record.status, 'cancelled');
  assert.equal(record.run.resources, 'unknown');
  assert.throws(() => step(record, { kind: 'running' }), { code: 'TRANSITION' });
  assert.throws(() => step(initial(), { kind: 'cleanup_pending' }), { code: 'TRANSITION' });
});

test('checkpoint and host histories must agree, including failure with uncertain effects', () => {
  let record = step(initial(), { kind: 'running' });
  const input: AgentSnapshot = { version: 1, messages: [{ role: 'user', content: 'Private task input' }] };
  record = step(record, { kind: 'checkpoint', checkpoint: { stage: 'before_model', step: 1, snapshot: input } });
  record = step(record, {
    kind: 'checkpoint',
    checkpoint: { stage: 'before_tools', step: 1, snapshot: input, calls: [{ id: 'call', name: 'write' }] },
  });
  record = step(record, { kind: 'failed' });
  assert.equal(record.status, 'failed');
  assert.deepEqual(record.run.pendingTools, [{ id: 'call', name: 'write' }]);
  assert.equal(record.run.resources, 'unknown');
  assert.equal(record.run.outcome, 'failed');
  assert.equal(record.events[record.events.length - 1]?.status, 'failed');
  const serializedEvents = JSON.stringify(record.events);
  for (const secret of ['Private task input', 'write', 'snapshot', 'request-1'])
    assert.ok(!serializedEvents.includes(secret));
  for (const value of [
    { ...record, version: 2 },
    { ...record, status: 'completed' },
    { ...record, cleanup: 'dispose_settled' },
    { ...record, revision: Number.MAX_SAFE_INTEGER },
    { ...record, run: { ...record.run, runId: 2 } },
    { ...record, events: record.events.slice(0, -1), revision: record.revision - 1 },
    { ...record, events: record.events.map((event, i) => (i === 1 ? { ...event, kind: 'checkpoint' } : event)) },
    { ...record, events: record.events.map((event, i) => (i === 2 ? { ...event, sequence: 9 } : event)) },
    { ...record, extra: true },
    { ...record, requestId: '' },
    { ...record, input: ' ' },
  ])
    assert.throws(() => validateTaskRecord(value));
});

test('accepted input, state, events and checkpoints replace atomically with private modes', async (t) => {
  const { path, store } = await fixture(t);
  const candidate = initial();
  const create = store.create(candidate);
  candidate.input = 'Caller mutation';
  candidate.run.taskId = 'mutated';
  let record = await create;
  assert.equal(record.input, 'Private task input');
  assert.equal(record.run.taskId, 'task-1');
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const stale = taskFence(record);
  record = await store.transition(stale, { kind: 'running' });
  await assert.rejects(store.transition(stale, { kind: 'cancelling' }), { code: 'CONFLICT' });
  record = await store.transition(taskFence(record), { kind: 'checkpoint', checkpoint: terminal });
  const disk = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(disk, record);
  assert.equal(disk.status, disk.run.outcome);
  assert.equal(disk.events.at(-1)?.status, 'cancelled');
  const reloaded = await createTaskRecordStore({ path }).load();
  reloaded.events[0].kind = 'failed';
  assert.deepEqual(await store.load(), record);
  await assert.rejects(store.create(initial()), { code: 'EXISTS' });
  const bytes = await readFile(path);
  const small = createTaskRecordStore({ path, maxBytes: bytes.length });
  await assert.rejects(small.transition(taskFence(record), { kind: 'cleanup_pending' }), { code: 'SIZE' });
  assert.deepEqual(await readFile(path), bytes);
  await writeFile(`${path}.lock`, '', { mode: 0o600 });
  await assert.rejects(store.transition(taskFence(record), { kind: 'cleanup_pending' }), { code: 'LOCKED' });
  assert.deepEqual(await store.load(), record);
});

test('hostile input never invokes accessors or proxies and corruption is refused', async (t) => {
  const { path, store } = await fixture(t);
  let reads = 0;
  const accessor = { ...initial() };
  Object.defineProperty(accessor, 'input', {
    enumerable: true,
    get: () => {
      reads++;
      return 'secret';
    },
  });
  const proxy = new Proxy(initial(), {
    get() {
      reads++;
      throw new Error('secret');
    },
  });
  for (const value of [accessor, proxy, { ...initial(), events: Array(1) }]) {
    assert.throws(() => validateTaskRecord(value), { code: 'INVALID' });
    await assert.rejects(store.create(value), { code: 'INVALID' });
  }
  assert.equal(reads, 0);
  await assert.rejects(store.load(), { name: 'TaskError', message: 'Task: NOT_FOUND', code: 'NOT_FOUND' });
  const record = await store.create(initial());
  const change = { kind: 'running' };
  Object.defineProperty(change, 'kind', {
    get: () => {
      reads++;
      return 'failed';
    },
  });
  await assert.rejects(store.transition(taskFence(record), change as TaskTransition), { code: 'INVALID' });
  assert.equal(reads, 0);
  await writeFile(path, Buffer.from([0xff]));
  await assert.rejects(store.load(), { code: 'CORRUPT' });
});
