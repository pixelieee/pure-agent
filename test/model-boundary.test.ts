import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgent } from '../src/core.ts';
import type { Message, ToolCall } from '../src/core.ts';
import { createSessionStore } from '../src/session.ts';

const call = (id = 'write-1'): ToolCall => ({
  id,
  type: 'function',
  function: { name: 'write', arguments: '{}' },
});
const final: Message = { role: 'assistant', content: 'Done' };
const toolReply: Message = { role: 'assistant', content: null, tool_calls: [call()] };
const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
const invalid: [string, unknown][] = [
  ['nonserializable final response', { ...final, providerData: { kind: 'fixture', data: 1n } }],
  ['empty provider kind', { ...toolReply, providerData: { kind: '', data: null } }],
  ['missing provider data', { ...toolReply, providerData: { kind: 'fixture' } }],
  ['null provider envelope', { ...toolReply, providerData: null }],
  ['extra provider key', { ...toolReply, providerData: { kind: 'fixture', data: null, extra: true } }],
  [
    'empty tool name',
    { ...toolReply, tool_calls: [call(), { ...call('write-2'), function: { name: '', arguments: '{}' } }] },
  ],
  ['extra call key', { ...toolReply, tool_calls: [call(), { ...call('write-2'), extra: true }] }],
  [
    'extra function key',
    {
      ...toolReply,
      tool_calls: [call(), { ...call('write-2'), function: { name: 'write', arguments: '{}', extra: true } }],
    },
  ],
  ...[
    ['undefined', undefined],
    ['bigint', 1n],
    ['NaN', NaN],
    ['infinity', Infinity],
    ['negative zero', -0],
    ['date', new Date(0)],
    ['map', new Map()],
    ['cycle', cyclic],
    ['sparse array', new Array(1)],
    ['array properties', Object.assign([1], { extra: true })],
  ].map(([name, data]): [string, unknown] => [String(name), { ...toolReply, providerData: { kind: 'fixture', data } }]),
];

for (const [name, message] of invalid) {
  test(`invalid model ${name} blocks before tool effects and leaves a resumable session`, async () => {
    let requests = 0;
    let writes = 0;
    const events: string[] = [];
    const agent = createAgent({
      model: { complete: async () => (++requests === 1 ? (message as Message) : final) },
      tools: [{ name: 'write', description: 'Fixture', parameters: { type: 'object' }, execute: async () => ++writes }],
    });
    const result = await agent.run('First', {
      onEvent: (event) => {
        events.push(event.type);
      },
    });
    assert.deepEqual(result, { status: 'blocked', text: '', steps: 1, error: 'Model returned invalid assistant data' });
    assert.equal(writes, 0);
    assert.equal(requests, 1);
    assert.deepEqual(events, ['model_start', 'done']);
    assert.deepEqual(agent.snapshot(), { version: 1, messages: [{ role: 'user', content: 'First' }] });
    assert.equal((await agent.run('Next')).status, 'completed');
    assert.equal(requests, 2);
    assert.equal(writes, 0);
    const restored = createAgent({ model: { complete: async () => final } });
    restored.restore(agent.snapshot());
    assert.deepEqual(restored.snapshot(), agent.snapshot());
  });
}

test('valid opaque model data and tool effects survive disk save, load, and resume unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-model-boundary-'));
  let writes = 0;
  let requests = 0;
  const providerData = {
    kind: 'fixture',
    data: { items: [null, true, false, 0, 1.5, 'opaque', { nested: ['value'] }] },
  };
  const first: Message = { ...toolReply, providerData };
  const agent = createAgent({
    model: { complete: async () => (++requests === 1 ? first : final) },
    tools: [{ name: 'write', description: 'Fixture', parameters: { type: 'object' }, execute: async () => ++writes }],
  });
  try {
    assert.equal((await agent.run('Write')).status, 'completed');
    assert.equal(writes, 1);
    assert.equal(requests, 2);
    const snapshot = agent.snapshot();
    assert.deepEqual(snapshot.messages[1], first);
    const options = {
      path: join(root, 'session.json'),
      identity: { provider: 'fixture', model: 'offline', workspaceRoot: root },
    };
    const saved = await createSessionStore(options).save(snapshot, { status: 'completed' });
    assert.deepEqual(JSON.parse(await readFile(options.path, 'utf8')), saved);
    const loaded = await createSessionStore(options).load();
    assert.deepEqual(loaded.snapshot, snapshot);
    const resumed = createAgent({
      model: {
        complete: async (messages) => {
          assert.deepEqual(messages.slice(0, -1), snapshot.messages);
          return final;
        },
      },
    });
    resumed.restore(loaded.snapshot);
    assert.equal((await resumed.run('Continue')).status, 'completed');
    assert.equal(writes, 1);
    assert.deepEqual(resumed.snapshot().messages.slice(0, snapshot.messages.length), snapshot.messages);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
