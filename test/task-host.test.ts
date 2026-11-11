import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createCheckpointWriter } from '../src/checkpoint.ts';
import type { AgentSnapshot, CheckpointCallback, RunResult, ToolCall } from '../src/core.ts';
import { createTaskHost } from '../src/task-host.ts';
import type { TaskRuntime } from '../src/task-host.ts';
import { createTaskRecord, createTaskRecordStore, reduceTaskRecord, taskFence } from '../src/task-record.ts';
import { executeToolCalls, registerTools } from '../src/tool-execution.ts';
import { createProcessTools } from '../src/tools/process.ts';
import type { ProcessSnapshot } from '../src/tools/process.ts';

// Host lifecycle drivers only: no Agent/Model constructed and no synthetic model response returned.
// Checkpoints are stored-data fixtures; the process test invokes actual production tool execution.
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const empty: AgentSnapshot = { version: 1, messages: [] };
const finish = (checkpoint: CheckpointCallback, status: RunResult['status'] = 'cancelled', snapshot = empty) =>
  checkpoint({ stage: 'terminal', snapshot, result: { status, text: '', steps: 0 } });
async function directory(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pure-task-host-'));
  const cleanups: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    try {
      for (const cleanup of cleanups.reverse()) await cleanup();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    path: join(root, 'task.json'),
    cleanup: (operation: () => Promise<unknown>) => cleanups.push(operation),
  };
}
async function settled(host: ReturnType<typeof createTaskHost>, taskId: string) {
  for (let i = 0; i < 200; i++) {
    const state = await host.get(taskId);
    if (state.host.execution === 'settled') return state;
    await delay(5);
  }
  throw new Error('Host did not settle');
}

test('durable acceptance precedes execution; duplicate admission, stale cancel and cursor replay', {
  timeout: 10000,
}, async (t) => {
  const { path, cleanup } = await directory(t);
  const entered = gate();
  const release = gate();
  let runs = 0;
  let creations = 0;
  let signal: AbortSignal | undefined;
  const host = createTaskHost({
    path,
    createRuntime(checkpoint) {
      creations++;
      return {
        agent: {
          snapshot: () => empty,
          async run(input, options) {
            runs++;
            signal = options.signal;
            assert.equal(input, 'Private request');
            assert.equal(JSON.parse(await readFile(path, 'utf8')).status, 'running');
            entered.resolve();
            await release.promise;
            await finish(checkpoint);
          },
        },
        async dispose() {},
      };
    },
  });
  cleanup(async () => {
    release.resolve();
    await host.close({ mode: 'cancel' });
  });
  const request = { requestId: 'request-1' };
  const one = host.start('Private request', request);
  request.requestId = 'mutated';
  const two = host.start('Private request', { requestId: 'request-1' });
  const accepted = await one;
  assert.equal(runs, 0);
  assert.deepEqual(await two, accepted);
  assert.equal(creations, 1);
  await entered.promise;
  await assert.rejects(host.start('Other input', { requestId: 'request-1' }), { code: 'CONFLICT' });
  await assert.rejects(host.start('Private request', { requestId: 'other' }), { code: 'CONFLICT' });
  await assert.rejects(host.cancel(accepted.taskId, 2), { code: 'CONFLICT' });
  await assert.rejects(host.get('other'), { code: 'NOT_FOUND' });
  assert.equal(signal?.aborted, false);
  const cancelled = await host.cancel(accepted.taskId, 1);
  assert.equal(cancelled.status, 'cancelling');
  assert.equal(signal?.aborted, true);
  assert.equal((await host.cancel(accepted.taskId, 1)).cursor, cancelled.cursor);
  const page = await host.events(accepted.taskId, 0, 1);
  assert.equal(page.events[0].kind, 'accepted');
  assert.equal(page.hasMore, true);
  page.events[0].status = 'failed';
  assert.equal((await host.events(accepted.taskId, 0, 1)).events[0].status, 'accepted');
  assert.ok(!JSON.stringify(await host.events(accepted.taskId)).includes('Private request'));
  await assert.rejects(host.events(accepted.taskId, -1), { code: 'CURSOR' });
  await assert.rejects(host.events(accepted.taskId, 0, 257), { code: 'CURSOR' });
  await assert.rejects(host.events(accepted.taskId, 999), { code: 'CURSOR' });
  release.resolve();
  const end = await settled(host, accepted.taskId);
  assert.equal(end.status, 'cancelled');
  assert.equal(end.cleanup, 'owned');
  const last = await host.events(accepted.taskId, end.cursor);
  assert.deepEqual(last.events, []);
  assert.equal(last.hasMore, false);
  assert.equal((await host.cancel(accepted.taskId, 1)).cursor, end.cursor);
  assert.equal(runs, 1);
});

test('close drains noncooperative work and separately waits for disposal; no new admission', {
  timeout: 10000,
}, async (t) => {
  const { path } = await directory(t);
  const entered = gate();
  const release = gate();
  const disposing = gate();
  const cleaned = gate();
  let disposals = 0;
  const host = createTaskHost({
    path,
    createRuntime: (checkpoint) => ({
      agent: {
        snapshot: () => empty,
        async run() {
          entered.resolve();
          await release.promise;
          await finish(checkpoint);
        },
      },
      async dispose() {
        disposals++;
        disposing.resolve();
        await cleaned.promise;
      },
    }),
  });
  const accepted = await host.start('Request', { requestId: 'request' });
  await entered.promise;
  let closed = false;
  const closing = host.close({ mode: 'cancel' });
  const observed = closing.then(() => {
    closed = true;
  });
  assert.equal(host.close({ mode: 'drain' }), closing);
  await host.get(accepted.taskId);
  assert.equal((await host.get(accepted.taskId)).status, 'cancelling');
  assert.equal(disposals, 0);
  assert.equal(closed, false);
  await assert.rejects(host.start('New', { requestId: 'new' }), { code: 'CLOSED' });
  release.resolve();
  await disposing.promise;
  const pending = await host.get(accepted.taskId);
  assert.equal(pending.status, 'cancelled');
  assert.equal(pending.cleanup, 'pending');
  assert.equal(pending.resources, 'unknown');
  assert.equal(pending.host.disposal, 'pending');
  assert.equal(closed, false);
  cleaned.resolve();
  await observed;
  assert.equal((await closing)?.cleanup, 'dispose_settled');
  assert.equal(disposals, 1);
});

test('cancellation before the scheduled turn reaches the driver already aborted', async (t) => {
  const { path } = await directory(t);
  let aborted = false;
  const host = createTaskHost({
    path,
    createRuntime: (checkpoint) => ({
      agent: {
        snapshot: () => empty,
        async run(_input, options) {
          aborted = options.signal?.aborted === true;
          await finish(checkpoint);
        },
      },
      async dispose() {},
    }),
  });
  const accepted = await host.start('Request', { requestId: 'request' });
  await host.cancel(accepted.taskId, 1);
  const end = await host.close({ mode: 'drain' });
  assert.equal(aborted, true);
  assert.equal(end?.status, 'cancelled');
  assert.deepEqual(
    (await host.events(accepted.taskId)).events.map((event) => event.kind),
    ['accepted', 'cancelling', 'checkpoint', 'cleanup_pending', 'dispose_settled'],
  );
});

test('terminal outcome retains an actual owned background process until close', { timeout: 10000 }, async (t) => {
  const { root, path, cleanup } = await directory(t);
  const processes = createProcessTools({ root, inheritEnv: false, defaultTimeoutMs: 5000, killGraceMs: 20 });
  cleanup(() => processes.dispose());
  let processId = '';
  const host = createTaskHost({
    path,
    createRuntime: (checkpoint) => ({
      agent: {
        snapshot: () => empty,
        async run(input, options) {
          const commit = createCheckpointWriter(checkpoint);
          const before: AgentSnapshot = { version: 1, messages: [{ role: 'user', content: input }] };
          const call: ToolCall = {
            id: 'actual-process',
            type: 'function',
            function: {
              name: 'start_process',
              arguments: JSON.stringify({ command: 'exec sleep 5' }),
            },
          };
          await commit({ stage: 'before_model', step: 1, snapshot: before });
          await commit({
            stage: 'before_tools',
            step: 1,
            snapshot: before,
            calls: [{ id: call.id, name: call.function.name }],
          });
          const results = await executeToolCalls(
            [call],
            registerTools(processes.tools),
            options.signal ?? new AbortController().signal,
            async () => {},
          );
          processId = JSON.parse(results[0] as string).id;
          const paired: AgentSnapshot = {
            version: 1,
            messages: [
              ...before.messages,
              { role: 'assistant', content: null, tool_calls: [call] },
              { role: 'tool', tool_call_id: call.id, content: results[0] as string },
            ],
          };
          await commit({ stage: 'after_tools', step: 1, snapshot: paired });
          await finish(commit, 'limit', paired);
        },
      },
      dispose: () => processes.dispose(),
    }),
  });
  cleanup(() => host.close({ mode: 'cancel' }));
  const accepted = await host.start('Owned local process test', { requestId: 'process' });
  const beforeClose = await settled(host, accepted.taskId);
  assert.equal(beforeClose.status, 'limit');
  assert.equal(beforeClose.cleanup, 'owned');
  const statusTool = processes.tools.find((tool) => tool.name === 'process_status');
  assert.ok(statusTool);
  const inspect = () =>
    statusTool.execute({ id: processId }, { signal: new AbortController().signal }) as Promise<ProcessSnapshot>;
  assert.equal((await inspect()).status, 'running');
  const closed = await host.close({ mode: 'drain' });
  assert.equal(closed?.cleanup, 'dispose_settled');
  assert.equal(closed?.resources, 'unknown');
  assert.equal((await inspect()).status, 'terminated');
});

test('checkpoint storage failure stops writes, exposes no secrets and still disposes', async (t) => {
  const { path } = await directory(t);
  let disposals = 0;
  const host = createTaskHost({
    path,
    createRuntime: (checkpoint) => ({
      agent: {
        snapshot: () => empty,
        async run() {
          await writeFile(`${path}.lock`, 'owned test blocker', { mode: 0o600 });
          await finish(createCheckpointWriter(checkpoint));
        },
      },
      async dispose() {
        disposals++;
      },
    }),
  });
  const accepted = await host.start('Private input', { requestId: 'failure' });
  const state = await settled(host, accepted.taskId);
  assert.equal(state.host.fault, 'PERSISTENCE');
  assert.equal(state.status, 'running');
  assert.equal(state.phase, 'accepted');
  assert.equal((await createTaskRecordStore({ path }).load()).run.outcome, null);
  await assert.rejects(host.close({ mode: 'cancel' }), { name: 'TaskError', message: 'Task: PERSISTENCE' });
  assert.equal(disposals, 1);
  assert.equal((await host.get(accepted.taskId)).host.disposal, 'settled');
  assert.equal((await host.get(accepted.taskId)).cleanup, 'owned');
  assert.equal((await host.events(accepted.taskId)).events.length, 2);
});

test('existing admission is never reopened or overwritten; failed admission never schedules work', async (t) => {
  const { path } = await directory(t);
  const store = createTaskRecordStore({ path });
  const original = await store.create(createTaskRecord('old-task', 'old-request', 'Old input', empty));
  let runs = 0;
  let disposals = 0;
  const host = createTaskHost({
    path,
    createRuntime: () => ({
      agent: {
        snapshot: () => empty,
        async run() {
          runs++;
        },
      },
      async dispose() {
        disposals++;
      },
    }),
  });
  await assert.rejects(host.start('New input', { requestId: 'new' }), { code: 'PERSISTENCE' });
  await assert.rejects(host.start('New input', { requestId: 'new' }), { code: 'START_FAILED' });
  await turn();
  assert.equal(runs, 0);
  assert.deepEqual(await store.load(), original);
  await assert.rejects(host.close({ mode: 'drain' }), { code: 'PERSISTENCE' });
  assert.equal(disposals, 1);
});

test('missing terminal is failed, late callback is fenced, cleanup rejection is not retried', async (t) => {
  const { path } = await directory(t);
  let callback: CheckpointCallback | undefined;
  let disposals = 0;
  const host = createTaskHost({
    path,
    createRuntime(checkpoint): TaskRuntime {
      callback = checkpoint;
      return {
        agent: { snapshot: () => empty, async run() {} },
        async dispose() {
          disposals++;
          throw new Error('PRIVATE cleanup detail');
        },
      };
    },
  });
  const accepted = await host.start('Request', { requestId: 'request' });
  assert.equal((await settled(host, accepted.taskId)).status, 'failed');
  assert.ok(callback);
  const late = callback;
  await assert.rejects(async () => finish(late), { code: 'STALE_CALLBACK' });
  await assert.rejects(host.close({ mode: 'drain' }), { name: 'TaskError', message: 'Task: CLEANUP' });
  await assert.rejects(host.close({ mode: 'cancel' }), { code: 'CLEANUP' });
  const state = await host.get(accepted.taskId);
  assert.equal(state.status, 'failed');
  assert.equal(state.cleanup, 'failed');
  assert.equal(state.resources, 'unknown');
  assert.equal(disposals, 1);
});

test('byte-cap terminal failure preserves active evidence and still awaits disposal', async (t) => {
  const { path } = await directory(t);
  const input = 'Bounded request';
  const candidate = createTaskRecord('00000000-0000-0000-0000-000000000000', 'bounded', input, empty);
  const running = reduceTaskRecord(candidate, taskFence(candidate), { kind: 'running' });
  const maxBytes = Buffer.byteLength(`${JSON.stringify(running)}\n`);
  let disposals = 0;
  const host = createTaskHost({
    path,
    maxBytes,
    createRuntime: (checkpoint) => ({
      agent: {
        snapshot: () => empty,
        async run() {
          await finish(createCheckpointWriter(checkpoint));
        },
      },
      async dispose() {
        disposals++;
      },
    }),
  });
  const accepted = await host.start(input, { requestId: 'bounded' });
  const failed = await settled(host, accepted.taskId);
  assert.equal(failed.status, 'running');
  assert.equal(failed.host.fault, 'PERSISTENCE');
  assert.equal(failed.cleanup, 'owned');
  await assert.rejects(host.close({ mode: 'drain' }), { code: 'PERSISTENCE' });
  assert.equal(disposals, 1);
  const persisted = await createTaskRecordStore({ path }).load();
  assert.equal(persisted.run.outcome, null);
  assert.equal(persisted.revision, 2);
  assert.equal(persisted.cleanup, 'owned');
});

test('late cancellation does not rewrite an already chosen terminal outcome', async (t) => {
  const { path } = await directory(t);
  const entered = gate();
  const release = gate();
  const host = createTaskHost({
    path,
    createRuntime: (checkpoint) => ({
      agent: {
        snapshot: () => empty,
        async run() {
          entered.resolve();
          await release.promise;
          await finish(checkpoint, 'completed');
        },
      },
      async dispose() {},
    }),
  });
  const accepted = await host.start('Request', { requestId: 'request' });
  await entered.promise;
  assert.equal((await host.cancel(accepted.taskId, 1)).status, 'cancelling');
  release.resolve();
  assert.equal((await host.close({ mode: 'drain' }))?.status, 'completed');
});
