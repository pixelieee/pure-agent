import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgent, validateAgentSnapshot } from '../src/core.ts';
import type { AgentSnapshot, Message, Model, Tool } from '../src/core.ts';

const final: Message = { role: 'assistant', content: 'Completed' };
const toolReply = {
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'write-1', type: 'function', function: { name: 'write', arguments: '{"value":1}' } }],
  providerData: { kind: 'example.continuation', data: { output: [{ id: 'reasoning-1', encrypted: 'opaque' }] } },
} satisfies Message;
const scripted = (...messages: Message[]): Model => ({
  async complete() {
    const reply = messages.shift();
    assert.ok(reply);
    return reply;
  },
});
const write: Tool = {
  name: 'write',
  description: 'Fixture write',
  parameters: { type: 'object' },
  execute: async () => ({ ok: true }),
};
const safeHistory: AgentSnapshot = {
  version: 1,
  messages: [
    { role: 'system', content: 'Test system' },
    { role: 'user', content: 'Write' },
    toolReply,
    { role: 'tool', content: '{"ok":true}', tool_call_id: 'write-1' },
    final,
  ],
};

test('snapshot restores full provider history without executing tools or models', async () => {
  let executions = 0;
  let modelCalls = 0;
  const agent = createAgent({
    system: 'Test system',
    tools: [{ ...write, execute: async () => ++executions }],
    model: {
      async complete(messages) {
        modelCalls++;
        assert.deepEqual(messages.slice(0, -1), safeHistory.messages);
        assert.equal(messages.at(-1)?.content, 'Continue');
        return final;
      },
    },
  });
  const supplied = structuredClone(safeHistory);
  agent.restore(supplied);
  assert.equal(modelCalls, 0);
  assert.equal(executions, 0);
  assert.deepEqual(agent.snapshot(), safeHistory);
  supplied.messages[1].content = 'changed';
  const snapshot = agent.snapshot();
  snapshot.messages[2].providerData = { kind: 'changed', data: null };
  assert.ok(snapshot.messages[2].tool_calls);
  snapshot.messages[2].tool_calls[0].function.arguments = '{"value":9}';
  assert.deepEqual(agent.snapshot(), safeHistory);
  assert.equal((await agent.run('Continue')).status, 'completed');
  assert.equal(modelCalls, 1);
  assert.equal(executions, 0);
});

test('snapshot after cancellation retains every call result, and restored session never repeats writes', async () => {
  let executions = 0;
  const controller = new AbortController();
  const reply = structuredClone(toolReply);
  reply.tool_calls.push({ id: 'write-2', type: 'function', function: { name: 'write', arguments: '{}' } });
  const agent = createAgent({
    model: scripted(reply),
    tools: [
      {
        ...write,
        async execute() {
          executions++;
          controller.abort();
          return 'written before cancellation';
        },
      },
    ],
  });
  assert.equal((await agent.run('Write', { signal: controller.signal })).status, 'cancelled');
  const snapshot = agent.snapshot();
  assert.deepEqual(
    snapshot.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id),
    ['write-1', 'write-2'],
  );
  const lastContent = snapshot.messages.at(-1)?.content;
  assert.ok(lastContent);
  assert.match(lastContent, /Cancelled before execution/u);
  const resumed = createAgent({ model: scripted(final), tools: [{ ...write, execute: async () => ++executions }] });
  resumed.restore(snapshot);
  assert.equal((await resumed.run('Continue')).status, 'completed');
  assert.equal(executions, 1);
});

test('snapshot and restore are refused throughout an active run, including done observers', async () => {
  let resolve!: (value: Message) => void;
  const agent = createAgent({
    model: { complete: () => new Promise<Message>((done) => (resolve = done)) },
  });
  let observed = 0;
  const running = agent.run('Go', {
    onEvent(event) {
      assert.throws(() => agent.snapshot(), /while running/u);
      assert.throws(() => agent.restore(safeHistory), /while running/u);
      if (event.type === 'done') observed++;
    },
  });
  await new Promise((done) => setImmediate(done));
  assert.throws(() => agent.snapshot(), /while running/u);
  assert.throws(() => agent.restore(safeHistory), /while running/u);
  resolve(final);
  assert.equal((await running).status, 'completed');
  assert.equal(observed, 1);
  assert.equal(agent.snapshot().messages.at(-1)?.content, 'Completed');
});

test('unfinished side-effect turns cannot be restored and failed restore preserves previous history', () => {
  const agent = createAgent({ model: scripted() });
  agent.restore(safeHistory);
  for (const messages of [
    safeHistory.messages.slice(0, 3),
    [...safeHistory.messages.slice(0, 3), final],
    [...safeHistory.messages.slice(0, 3), { role: 'user', content: 'Skip write' }],
    [...safeHistory.messages.slice(0, 3), { role: 'tool', tool_call_id: 'other', content: 'done' }],
  ]) {
    assert.throws(() => agent.restore({ version: 1, messages }), /tool/u);
    assert.deepEqual(agent.snapshot(), safeHistory);
  }
});

test('snapshots validate versions, message roles, schemas, tool result pairing, and system compatibility', () => {
  const invalid: unknown[] = [
    null,
    {},
    { ...safeHistory, version: 2 },
    { ...safeHistory, apiKey: 'invalid-fixture-placeholder' },
    { ...safeHistory, messages: {} },
    { version: 1, messages: [{ role: 'alien', content: 'x' }] },
    { version: 1, messages: [{ role: 'assistant', content: 'x' }] },
    { version: 1, messages: [{ role: 'tool', content: 'x', tool_call_id: 'orphan' }] },
    { version: 1, messages: [{ role: 'user', content: ' ' }] },
    { version: 1, messages: [{ role: 'user', content: 'x', providerData: { kind: 'x', data: {} } }] },
    {
      version: 1,
      messages: [
        { role: 'user', content: 'x' },
        { role: 'system', content: 'y' },
      ],
    },
    { version: 1, messages: [{ role: 'user', content: 'x' }, final, final] },
    {
      version: 1,
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 7 },
      ],
    },
    {
      version: 1,
      messages: [
        { role: 'user', content: 'x' },
        { ...final, tool_calls: [] },
      ],
    },
    {
      version: 1,
      messages: [
        { role: 'user', content: 'x' },
        { ...final, tool_call_id: 'x' },
      ],
    },
    {
      version: 1,
      messages: [
        { role: 'user', content: 'x' },
        { ...final, providerData: { kind: 'x' } },
      ],
    },
    {
      version: 1,
      messages: [
        { role: 'user', content: 'x' },
        { ...final, providerData: { kind: '', data: {} } },
      ],
    },
    {
      version: 1,
      messages: [
        { role: 'user', content: 'x' },
        { ...toolReply, tool_calls: [...toolReply.tool_calls, ...toolReply.tool_calls] },
      ],
    },
    {
      version: 1,
      messages: [
        ...safeHistory.messages.slice(0, 3),
        { role: 'tool', content: '1', tool_call_id: 'write-1' },
        { role: 'tool', content: '2', tool_call_id: 'write-1' },
      ],
    },
  ];
  for (const value of invalid) assert.throws(() => validateAgentSnapshot(value));
  const agent = createAgent({ model: scripted(), system: 'Different' });
  assert.throws(() => agent.restore(safeHistory), /incompatible/u);
  assert.deepEqual(agent.messages, [{ role: 'system', content: 'Different' }]);
});

test('non-JSON provider data is rejected instead of silently losing or mutating continuation state', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const getter = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      throw new Error('Getter must not execute');
    },
  });
  const malformedArray = Object.assign(new Array(1), { extra: 1 });
  for (const data of [
    undefined,
    1n,
    () => 1,
    NaN,
    Infinity,
    -0,
    new Date(),
    new Map(),
    cyclic,
    getter,
    malformedArray,
  ]) {
    assert.throws(
      () =>
        validateAgentSnapshot({
          version: 1,
          messages: [
            { role: 'user', content: 'x' },
            { ...final, providerData: { kind: 'opaque', data } },
          ],
        }),
      /snapshot/u,
    );
  }
});

test('blocked, limited, pre-cancelled, and cancelled-model histories remain resumable', async () => {
  for (const mode of ['blocked', 'limit', 'cancelled-model', 'pre-cancelled']) {
    const controller = new AbortController();
    if (mode === 'pre-cancelled') controller.abort();
    const agent = createAgent({
      maxSteps: 1,
      tools: [write],
      model: {
        async complete() {
          if (mode === 'blocked') throw new Error('fixture failure');
          if (mode === 'cancelled-model') controller.abort();
          return mode === 'limit' ? toolReply : final;
        },
      },
    });
    await agent.run('Start', { signal: controller.signal });
    const restored = createAgent({ model: scripted(final) });
    restored.restore(agent.snapshot());
    assert.equal((await restored.run('Next')).status, 'completed');
  }
});
