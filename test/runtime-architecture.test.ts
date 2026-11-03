import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { Model } from '../src/core.ts';
import { createDeveloperAgent, DEVELOPER_SYSTEM } from '../src/developer-agent.ts';
import type { DeveloperAgentOptions } from '../src/developer-agent.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfilled, rejected) => {
    resolve = fulfilled;
    reject = rejected;
  });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Operation did not settle after cancellation')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t: test.TestContext, authorize: DeveloperAgentOptions['authorize']) {
  const root = await mkdtemp(join(tmpdir(), 'pure-runtime-review-'));
  let modelCalls = 0;
  const model: Model = {
    async complete(messages) {
      modelCalls++;
      return messages.at(-1)?.role === 'tool'
        ? { role: 'assistant', content: 'Offline fixture completed.' }
        : {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'pending-write',
                type: 'function',
                function: {
                  name: 'write',
                  arguments: JSON.stringify({ path: 'must-not-exist.txt', content: 'synthetic test sentinel' }),
                },
              },
            ],
          };
    },
  };
  const runtime = createDeveloperAgent({ root, model, authorize });
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { root, runtime, modelCalls: () => modelCalls };
}

test('independent runtime: cancellation settles even when host authorization never returns', async (t) => {
  const entered = deferred<void>();
  let approvalSignal: AbortSignal | undefined;
  const { root, runtime, modelCalls } = await fixture(t, (_request, context) => {
    approvalSignal = context.signal;
    entered.resolve();
    return new Promise<boolean>(() => {});
  });
  const abort = new AbortController();
  const pending = runtime.agent.run('Write the sentinel', { signal: abort.signal });
  await bounded(entered.promise);
  abort.abort(new Error('User cancelled permission prompt'));
  const result = await bounded(pending);
  assert.equal(result.status, 'cancelled');
  assert.equal(approvalSignal?.aborted, true);
  assert.equal(modelCalls(), 1);
  assert.deepEqual(await readdir(root), []);
  const snapshot = runtime.agent.snapshot();
  assert.equal(snapshot.messages.at(-1)?.role, 'tool');
  assert.equal(snapshot.messages.at(-1)?.tool_call_id, 'pending-write');
  assert.equal(JSON.parse(snapshot.messages.at(-1)?.content ?? '{}').ok, false);
});

for (const decision of ['allow', 'reject'] as const) {
  test(`independent runtime: late authorization ${decision} cannot execute after cancellation`, async (t) => {
    const entered = deferred<void>();
    const approval = deferred<boolean>();
    const { root, runtime, modelCalls } = await fixture(t, () => {
      entered.resolve();
      return approval.promise;
    });
    const abort = new AbortController();
    const pending = runtime.agent.run('Write the sentinel', { signal: abort.signal });
    await bounded(entered.promise);
    abort.abort();
    assert.equal((await bounded(pending)).status, 'cancelled');
    const before = runtime.agent.snapshot();
    if (decision === 'allow') approval.resolve(true);
    else approval.reject(new Error('Late host permission failure'));
    await setImmediate();
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(runtime.agent.snapshot(), before);
    assert.equal(modelCalls(), 1);
  });
}

test('independent runtime: dispose cancels pending permission and disables later runs without effects', async (t) => {
  const entered = deferred<void>();
  const approval = deferred<boolean>();
  const { root, runtime, modelCalls } = await fixture(t, () => {
    entered.resolve();
    return approval.promise;
  });
  const pending = runtime.agent.run('Write the sentinel');
  await bounded(entered.promise);
  await bounded(runtime.dispose());
  assert.equal((await bounded(pending)).status, 'cancelled');
  const before = runtime.agent.snapshot();
  approval.resolve(true);
  await setImmediate();
  const next = await bounded(runtime.agent.run('Try again after disposal'));
  assert.equal(next.status, 'cancelled');
  assert.equal(next.steps, 0);
  assert.equal(modelCalls(), 1);
  assert.deepEqual(runtime.agent.snapshot(), before);
  assert.deepEqual(await readdir(root), []);
  await runtime.dispose();
});

test('independent runtime: only boolean true authorizes a capability', async (t) => {
  for (const decision of [false, undefined, 1, 'yes', {}]) {
    // Exercise JavaScript callers and integrations whose permission API has an incorrect return type.
    const { root, runtime } = await fixture(t, (() => decision) as unknown as DeveloperAgentOptions['authorize']);
    assert.equal((await runtime.agent.run('Write the sentinel')).status, 'completed');
    const toolResult = runtime.agent.messages.find((message) => message.role === 'tool');
    assert.match(toolResult?.content ?? '', /Permission denied/);
    assert.deepEqual(await readdir(root), []);
    await runtime.dispose();
  }
});

test('independent runtime: explicit default instructions are not appended a second time', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pure-runtime-instructions-'));
  const runtime = createDeveloperAgent({
    root,
    system: DEVELOPER_SYSTEM,
    model: { complete: async () => ({ role: 'assistant', content: 'Unused fixture' }) },
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(runtime.agent.messages, [{ role: 'system', content: DEVELOPER_SYSTEM }]);
});
