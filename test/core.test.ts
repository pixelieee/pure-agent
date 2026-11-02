import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../src/core.ts';
import type { Message, Model, Tool, ToolCall } from '../src/core.ts';
const call = (name = 'echo', args = '{}', id = 'c1'): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });
const reply = (...calls: ToolCall[]): Message => ({ role: 'assistant', content: null, tool_calls: calls });
const final: Message = { role: 'assistant', content: 'Done' };
const scripted = (...replies: Message[]): Model => ({ complete: async () => { if (!replies.length) throw new Error('No scripted response'); return replies.shift()!; } });
const echo: Tool = { name: 'echo', description: 'Echo', parameters: { type: 'object' }, validate: args => !!args && typeof args === 'object' && !Array.isArray(args), execute: async args => args };

test('final reply, events, reuse, and detached history', async () => {
  const agent = createAgent({ model: scripted(final, final), system: 'System' });
  const events: string[] = [];
  assert.deepEqual(await agent.run('Hello', { onEvent: e => { events.push(e.type); } }), { status: 'completed', text: 'Done', steps: 1 });
  assert.deepEqual(events, ['model_start', 'assistant', 'done']);
  agent.messages[0].content = 'corrupted';
  assert.equal(agent.messages[0].content, 'System');
  assert.equal((await agent.run('Again')).status, 'completed');
  assert.equal(agent.messages.length, 5);
});

test('multiple tool results stay ordered and model receives them', async () => {
  const order: number[] = [];
  const tool: Tool = { ...echo, execute: async ({ n }) => { order.push(n); return { n }; } };
  let step = 0;
  const model: Model = { complete: async messages => {
    if (step++ === 0) return reply(call('echo', '{"n":1}', 'a'), call('echo', '{"n":2}', 'b'));
    assert.deepEqual(messages.slice(-2).map(m => m.tool_call_id), ['a', 'b']);
    return final;
  } };
  const agent = createAgent({ model, tools: [tool] });
  assert.equal((await agent.run('Do it')).steps, 2);
  assert.deepEqual(order, [1, 2]);
});

for (const [name, toolCall, tool] of [
  ['unknown tool', call('missing'), echo],
  ['invalid JSON', call('echo', '{bad'), echo],
  ['non-object JSON', call('echo', 'null'), echo],
  ['failed validation', call(), { ...echo, validate: () => false }],
  ['throwing validation', call(), { ...echo, validate: () => { throw new Error('Validator failed'); } }],
  ['tool failure', call(), { ...echo, execute: async () => { throw new Error('Write failed; not retried'); } }],
  ['nonserializable result', call(), { ...echo, execute: async () => 1n }],
] as [string, ToolCall, Tool][]) {
  test(`${name} becomes a model-visible result`, async () => {
    const agent = createAgent({ model: scripted(reply(toolCall), final), tools: [tool] });
    assert.equal((await agent.run('Go')).status, 'completed');
    const result = JSON.parse(agent.messages.find(m => m.role === 'tool')!.content!);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
  });
}

test('step limit preserves complete tool protocol and permits next run', async () => {
  let writes = 0;
  const agent = createAgent({ model: scripted(reply(call()), final), maxSteps: 1,
    tools: [{ ...echo, execute: async () => ++writes }] });
  assert.equal((await agent.run('Go')).status, 'limit');
  assert.equal(agent.messages.at(-1)?.role, 'tool');
  assert.equal(writes, 1);
  assert.equal((await agent.run('Continue')).status, 'completed');
});

test('model failure blocks without automatic retry and allows reuse', async () => {
  let count = 0;
  const model: Model = { complete: async () => { if (++count === 1) throw new Error('Offline'); return final; } };
  const agent = createAgent({ model });
  assert.equal((await agent.run('Go')).error, 'Offline');
  assert.equal(count, 1);
  assert.equal((await agent.run('Retry')).status, 'completed');
});

test('pre-cancelled run does not change history', async () => {
  const agent = createAgent({ model: scripted(final) });
  assert.equal((await agent.run('Go', { signal: AbortSignal.abort() })).status, 'cancelled');
  assert.equal(agent.messages.length, 0);
});

test('cancelled model cannot commit a late response', async () => {
  const controller = new AbortController();
  const agent = createAgent({ model: { complete: async () => { controller.abort(); return final; } } });
  assert.equal((await agent.run('Go', { signal: controller.signal })).status, 'cancelled');
  assert.deepEqual(agent.messages.map(m => m.role), ['user']);
});

test('cancellation after first tool records all call results, skipping remaining writes', async () => {
  const controller = new AbortController();
  let writes = 0;
  const agent = createAgent({ model: scripted(reply(call('echo', '{}', 'a'), call('echo', '{}', 'b'))),
    tools: [{ ...echo, execute: async (_args, { signal }) => {
      assert.equal(signal, controller.signal); writes++; controller.abort(); return 'first completed';
    } }] });
  assert.equal((await agent.run('Go', { signal: controller.signal })).status, 'cancelled');
  assert.equal(writes, 1);
  assert.deepEqual(agent.messages.slice(-2).map(m => m.tool_call_id), ['a', 'b']);
  assert.match(agent.messages.at(-1)!.content!, /Cancelled/);
});

test('cooperative tool abort is recorded and future runs are valid', async () => {
  const controller = new AbortController();
  const agent = createAgent({ model: scripted(reply(call()), final), tools: [{ ...echo, execute: async () => {
    controller.abort(); throw new Error('Aborted');
  } }] });
  assert.equal((await agent.run('Go', { signal: controller.signal })).status, 'cancelled');
  assert.equal(agent.messages.at(-1)?.role, 'tool');
  assert.equal((await agent.run('New run')).status, 'completed');
});

test('rejects concurrent session runs without corrupting the active run', async () => {
  let resolve!: (message: Message) => void;
  const agent = createAgent({ model: { complete: () => new Promise(r => { resolve = r; }) } });
  const pending = agent.run('First');
  await new Promise(r => setImmediate(r));
  await assert.rejects(agent.run('Second'), /already running/);
  resolve(final);
  assert.equal((await pending).status, 'completed');
  assert.equal(agent.messages.filter(m => m.role === 'user').length, 1);
});

test('observer exceptions and mutations do not change execution', async () => {
  let executions = 0;
  const agent = createAgent({ model: scripted(reply(call('echo', '{"x":1}')), final), tools: [{ ...echo, execute: async args => {
    executions++; assert.equal(args.x, 1); return args;
  } }] });
  const result = await agent.run('Go', { onEvent: event => {
    if (event.type === 'tool_start') (event.args as { x: number }).x = 9;
    throw new Error('UI failed');
  } });
  assert.equal(result.status, 'completed');
  assert.equal(executions, 1);
});

test('invalid model protocol never enters history', async () => {
  for (const message of [{ role: 'user', content: 'bad' }, reply(call(), call())]) {
    const agent = createAgent({ model: scripted(message as Message) });
    assert.equal((await agent.run('Go')).status, 'blocked');
    assert.equal(agent.messages.length, 1);
  }
});

test('constructor and input validation', async () => {
  assert.throws(() => createAgent({ model: scripted(), maxSteps: 0 }), /maxSteps/);
  assert.throws(() => createAgent({ model: scripted(), tools: [echo, echo] }), /duplicate/);
  const agent = createAgent({ model: scripted(final) });
  await assert.rejects(agent.run(' '), /non-empty/);
  assert.equal((await agent.run('Valid')).status, 'completed');
});

test('awaits in-flight cooperative cancellation rather than detaching a write', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  let settled = false;
  const agent = createAgent({ model: scripted(reply(call())), tools: [{ ...echo, execute: async (_args, { signal }) => {
    started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
      settled = true;
      reject(new Error('Write cancelled'));
    }, { once: true }));
  } }] });
  const pending = agent.run('Go', { signal: controller.signal });
  await ready;
  controller.abort();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(settled, true);
  assert.equal(agent.messages.at(-1)?.role, 'tool');
});

test('model receives detached history and tool metadata', async () => {
  const agent = createAgent({ system: 'Original', tools: [echo], model: { complete: async (messages, tools) => {
    messages[0].content = 'Changed';
    tools[0].parameters.type = 'Changed';
    return final;
  } } });
  await agent.run('Go');
  assert.equal(agent.messages[0].content, 'Original');
  assert.equal(echo.parameters.type, 'object');
});

test('cancellation from tool_start prevents the external action', async () => {
  const controller = new AbortController();
  let writes = 0;
  const agent = createAgent({ model: scripted(reply(call())), tools: [{ ...echo, execute: async () => ++writes }] });
  assert.equal((await agent.run('Go', { signal: controller.signal, onEvent: event => {
    if (event.type === 'tool_start') controller.abort();
  } })).status, 'cancelled');
  assert.equal(writes, 0);
  assert.equal(agent.messages.at(-1)?.role, 'tool');
});

test('model receives only tool definitions, never executable callbacks', async () => {
  const agent = createAgent({ tools: [{ ...echo, validate: () => true }], model: { complete: async (_messages, tools) => {
    assert.deepEqual(Object.keys(tools[0]).sort(), ['description', 'name', 'parameters']);
    assert.equal('execute' in tools[0], false);
    assert.equal('validate' in tools[0], false);
    return final;
  } } });
  assert.equal((await agent.run('Go')).status, 'completed');
});

test('unprintable thrown values cannot break tool result protocol', async () => {
  for (const error of [Object.create(null), { toString() { throw new Error('No string'); } }]) {
    const agent = createAgent({ model: scripted(reply(call()), final), tools: [{ ...echo, execute: async () => { throw error; } }] });
    assert.equal((await agent.run('Go')).status, 'completed');
    assert.equal(JSON.parse(agent.messages.find(m => m.role === 'tool')!.content!).error, 'Unknown error');
  }
});

test('nonfunction optional validators fail before session creation', () => {
  for (const validate of [null, true, 'validate', {}]) {
    const invalid = { ...echo, validate } as unknown as Tool;
    assert.throws(() => createAgent({ model: scripted(final), tools: [invalid] }), /requires a validate function/);
  }
});

test('failed validation never invokes the tool or emits tool_start', async () => {
  let writes = 0;
  const events: string[] = [];
  const agent = createAgent({ model: scripted(reply(call()), final), tools: [{ ...echo,
    validate: () => false, execute: async () => ++writes,
  }] });
  assert.equal((await agent.run('Go', { onEvent: event => { events.push(event.type); } })).status, 'completed');
  assert.equal(writes, 0);
  assert.equal(events.includes('tool_start'), false);
  assert.match(agent.messages.find(message => message.role === 'tool')!.content!, /Invalid arguments/);
});

test('only explicit true validates, not truthy accidental validator returns', async () => {
  let writes = 0;
  const agent = createAgent({ model: scripted(reply(call()), final), tools: [{ ...echo,
    validate: (() => 'yes') as unknown as Tool['validate'], execute: async () => ++writes,
  }] });
  assert.equal((await agent.run('Go')).status, 'completed');
  assert.equal(writes, 0);
});

test('opaque provider continuation data survives tool turns without shared mutable state', async () => {
  let turn = 0;
  const envelope = { kind: 'test.provider', data: { items: [{ id: 'continuation-1' }] } };
  const agent = createAgent({ model: { complete: async (messages) => {
    if (turn++ === 0) return { role: 'assistant', content: null, providerData: envelope,
      tool_calls: [{id:'opaque-call',type:'function',function:{name:'unknown',arguments:'{}'}}] };
    assert.deepEqual(messages.find(m => m.role === 'assistant')?.providerData, envelope);
    return { role: 'assistant', content: 'finished' };
  } } });
  assert.equal((await agent.run('test')).status, 'completed');
  envelope.data.items[0].id = 'mutated';
  const saved = agent.messages.find(m => m.role === 'assistant')?.providerData;
  assert.deepEqual(saved, { kind: 'test.provider', data: { items: [{ id: 'continuation-1' }] } });
});

for (const outcome of ['completed', 'blocked', 'cancelled'] as const) {
  test(`unawaited deltas drain in order before ${outcome}, ignoring late callbacks`, { timeout: 2000 }, async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const observing = new Promise<void>(resolve => { entered = resolve; });
    let callback!: NonNullable<Parameters<Model['complete']>[3]>;
    const abort = new AbortController();
    const events: string[] = [];
    let finished = false;
    const agent = createAgent({ model: {
      async complete(_messages, _tools, _signal, onTextDelta) {
        callback = onTextDelta!;
        void callback('first');
        void callback('second');
        if (outcome === 'blocked') throw new Error('model failed');
        if (outcome === 'cancelled') abort.abort();
        return final;
      },
    } });
    const run = agent.run('Go', { signal: abort.signal, onEvent: async event => {
      if (event.type === 'assistant_delta' && event.text === 'first') {
        entered(); await gate;
      }
      events.push(event.type === 'assistant_delta' ? event.text : event.type);
      if (event.type === 'assistant_delta') throw new Error('observer failed');
    } }).then(result => { finished = true; return result; });
    await observing;
    // Allow the model promise to settle while the first observer remains suspended.
    await new Promise<void>(resolve => setImmediate(resolve));
    await callback('late while draining');
    assert.equal(finished, false);
    assert.deepEqual(events, ['model_start']);
    release();
    assert.equal((await run).status, outcome);
    assert.deepEqual(events, ['model_start', 'first', 'second', ...(outcome === 'completed' ? ['assistant'] : []), 'done']);
    await callback('late after done');
    assert.equal(events.at(-1), 'done');
    assert.equal(agent.messages.filter(message => message.role === 'assistant').length, outcome === 'completed' ? 1 : 0);
  });
}
