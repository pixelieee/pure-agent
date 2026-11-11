import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentCheckpointError, createCheckpointWriter } from '../src/checkpoint.ts';
import type { AgentCheckpoint, AgentSnapshot, CheckpointCallback, ToolCall } from '../src/core.ts';
import { validateAgentSnapshot } from '../src/core.ts';
import { executeToolCalls, registerTools } from '../src/tool-execution.ts';
import { createFileTools } from '../src/tools/filesystem.ts';

// Direct production boundaries and stored protocol data only, never model responses.
const snapshot = (): AgentSnapshot => ({ version: 1, messages: [{ role: 'user', content: 'Boundary data' }] });
const intent = (): AgentCheckpoint => ({
  stage: 'before_tools',
  step: 1,
  calls: [{ id: 'write-1', name: 'write' }],
  snapshot: snapshot(),
});
const fixedError = (error: unknown) => {
  assert.ok(error instanceof AgentCheckpointError);
  assert.equal(error.name, 'AgentCheckpointError');
  assert.equal(error.message, 'Agent checkpoint failed; execution stopped. Effects may have occurred.');
  assert.equal(error.cause, undefined);
  return true;
};

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('checkpoint callback is validated, captured and optional', async () => {
  for (const invalid of [null, false, 1, {}, 'callback']) {
    assert.throws(() => createCheckpointWriter(invalid as unknown as CheckpointCallback), /must be a function/);
  }
  let calls = 0;
  const options = {
    checkpoint: () => {
      calls++;
    },
  };
  const commit = createCheckpointWriter(options.checkpoint);
  options.checkpoint = () => {
    assert.fail('Replacement callback called');
  };
  await commit(intent());
  assert.equal(calls, 1);
  await createCheckpointWriter(undefined)(intent());
});

test('checkpoint snapshots, intent metadata and terminal result are detached', async () => {
  const data = intent();
  const original = structuredClone(data);
  let retained: AgentCheckpoint | undefined;
  const commit = createCheckpointWriter((entry) => {
    retained = entry;
    entry.snapshot.messages[0].content = 'changed';
    if (entry.stage === 'before_tools') entry.calls[0].name = 'changed';
    if (entry.stage === 'terminal') entry.result.text = 'changed';
  });
  await commit(data);
  assert.deepEqual(data, original);
  retained?.snapshot.messages.push({ role: 'user', content: 'later mutation' });
  assert.deepEqual(data, original);
  const terminal: AgentCheckpoint = {
    stage: 'terminal',
    snapshot: snapshot(),
    result: { status: 'completed', steps: 1, text: 'original' },
  };
  await commit(terminal);
  assert.equal(terminal.result.text, 'original');
});

test('invalid or incomplete history is rejected before the callback', async () => {
  let calls = 0;
  const commit = createCheckpointWriter(() => {
    calls++;
  });
  const incomplete = snapshot();
  incomplete.messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'unpaired', type: 'function', function: { name: 'write', arguments: '{}' } }],
  });
  await assert.rejects(commit({ stage: 'after_tools', step: 1, snapshot: incomplete }), fixedError);
  const accessor = snapshot();
  Object.defineProperty(accessor.messages[0], 'content', {
    enumerable: true,
    get() {
      assert.fail('Invalid accessor evaluated');
    },
  });
  await assert.rejects(commit({ stage: 'before_model', step: 1, snapshot: accessor }), fixedError);
  assert.equal(calls, 0);
});

test('checkpoint awaits host settlement rather than detaching a pending write', { timeout: 5000 }, async () => {
  const entered = gate();
  const release = gate();
  let settled = false;
  const commit = createCheckpointWriter(async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = commit(intent()).then(() => {
    settled = true;
  });
  await entered.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release.resolve();
  await pending;
  assert.equal(settled, true);
});

for (const stage of ['before_model', 'before_tools', 'after_tools', 'terminal'] as const) {
  test(`${stage} failures are sanitized and never retried by the production writer`, async () => {
    let calls = 0;
    const commit = createCheckpointWriter(() => {
      calls++;
      throw new Error('Private storage detail');
    });
    const data: AgentCheckpoint =
      stage === 'terminal'
        ? { stage, snapshot: snapshot(), result: { status: 'cancelled', steps: 0, text: '' } }
        : stage === 'before_tools'
          ? intent()
          : { stage, step: 1, snapshot: snapshot() };
    await assert.rejects(commit(data), fixedError);
    assert.equal(calls, 1);
  });
}

test('rejected asynchronous storage writes are sanitized after actual filesystem failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pure-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commit = createCheckpointWriter(async (entry) => {
    await writeFile(join(root, 'missing-parent', 'checkpoint'), JSON.stringify(entry));
  });
  await assert.rejects(commit(intent()), fixedError);
  assert.deepEqual(await readdir(root), []);
});

test('direct file effects follow awaited intent and complete paired checkpoint survives cancellation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pure-checkpoint-effects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const data = snapshot();
  const calls: ToolCall[] = [
    {
      id: 'write-1',
      type: 'function',
      function: {
        name: 'write',
        arguments: JSON.stringify({ path: 'effect', content: 'written once' }),
      },
    },
  ];
  const stages: string[] = [];
  const commit = createCheckpointWriter(async (entry) => {
    stages.push(entry.stage);
    if (entry.stage === 'before_tools') assert.deepEqual(await readdir(root), []);
    await writeFile(join(root, 'checkpoint'), JSON.stringify(entry));
  });
  await commit(intent());
  const storedIntent = JSON.parse(await readFile(join(root, 'checkpoint'), 'utf8'));
  assert.equal(storedIntent.stage, 'before_tools');
  assert.deepEqual(validateAgentSnapshot(storedIntent.snapshot), data);
  data.messages.push({ role: 'assistant', content: null, tool_calls: calls });
  const results = await executeToolCalls(
    calls,
    registerTools(createFileTools({ root })),
    controller.signal,
    async (event) => {
      if (event.type === 'tool_end') {
        controller.abort();
        throw new Error('Observer failure does not prevent pairing');
      }
    },
  );
  data.messages.push({ role: 'tool', tool_call_id: 'write-1', content: results[0] as string });
  await commit({ stage: 'after_tools', step: 1, snapshot: data });
  assert.equal(controller.signal.aborted, true);
  assert.equal(await readFile(join(root, 'effect'), 'utf8'), 'written once');
  const stored = JSON.parse(await readFile(join(root, 'checkpoint'), 'utf8'));
  assert.deepEqual(validateAgentSnapshot(stored.snapshot), data);
  assert.equal(stored.stage, 'after_tools');
  assert.deepEqual(stages, ['before_tools', 'after_tools']);
  // A failed terminal commit neither erases already committed history nor rolls back the tool.
  let attempts = 0;
  const failTerminal = createCheckpointWriter(async () => {
    attempts++;
    await writeFile(join(root, 'absent', 'terminal'), 'cannot commit');
  });
  await assert.rejects(
    failTerminal({
      stage: 'terminal',
      snapshot: data,
      result: { status: 'cancelled', steps: 1, text: '' },
    }),
    fixedError,
  );
  assert.equal(attempts, 1);
  assert.equal(await readFile(join(root, 'effect'), 'utf8'), 'written once');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'checkpoint'), 'utf8')), stored);
});
