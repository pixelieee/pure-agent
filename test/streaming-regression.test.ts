import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../src/core.ts';
import type { AgentEvent, Message } from '../src/core.ts';
import { createOpenAIModel } from '../src/providers/openai.ts';
import type { OpenAIClient } from '../src/providers/openai.ts';

// Independent transport fixtures: never construct a real client or use credentials.
const input: Message[] = [{ role: 'user', content: 'question' }];
const signal = () => new AbortController().signal;
const message = (text: string) => ({
  type: 'message',
  id: 'msg',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const call = (id: string) => ({
  type: 'function_call',
  id: `item-${id}`,
  call_id: id,
  name: 'effect',
  arguments: '{}',
  status: 'completed',
});
const reasoning = { type: 'reasoning', id: 'reason', summary: [], encrypted_content: 'opaque-session-A' };
const usage = {
  input_tokens: 7,
  output_tokens: 11,
  total_tokens: 18,
  input_tokens_details: { cached_tokens: 2 },
  output_tokens_details: { reasoning_tokens: 5 },
};
type Response = Awaited<ReturnType<OpenAIClient['responses']['create']>>;
const response = (output: unknown[] = [message('canonical')], extra: object = {}): Response =>
  ({ output, status: 'completed', error: null, incomplete_details: null, usage, ...extra }) as Response;
const delta = (text: string) => ({
  type: 'response.output_text.delta',
  delta: text,
  item_id: 'msg',
  output_index: 0,
  content_index: 0,
  sequence_number: 1,
});
function transport(
  events: unknown[],
  result: Response,
  hooks: { before?: () => void; streamError?: Error; seen?: unknown[] } = {},
) {
  let creates = 0,
    streams = 0,
    aborted = 0;
  const client = {
    responses: {
      create: async () => {
        creates++;
        return result;
      },
      stream: (body: unknown) => {
        streams++;
        hooks.seen?.push(structuredClone(body));
        return {
          abort() {
            aborted++;
          },
          async *[Symbol.asyncIterator]() {
            hooks.before?.();
            for (const event of events) yield event;
            if (hooks.streamError) throw hooks.streamError;
            if (
              !events.some(
                (event) =>
                  !!event &&
                  typeof event === 'object' &&
                  'type' in event &&
                  typeof event.type === 'string' &&
                  ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type),
              )
            ) {
              yield { type: `response.${result.status}`, response: result };
            }
          },
        };
      },
    },
  } as unknown as OpenAIClient;
  return { client, counts: () => ({ creates, streams, aborted }) };
}

test('streaming emits only nonempty text deltas; final canonical message remains authoritative', async () => {
  const end = response();
  const fixture = transport(
    [
      { type: 'response.created', response: { status: 'in_progress' } },
      delta(''),
      delta('draft'),
      { type: 'response.function_call_arguments.delta', delta: '{"private":' },
      { type: 'response.reasoning_summary_text.delta', delta: 'private reasoning' },
      { type: 'response.output_text.done', text: 'do not duplicate' },
      { type: 'response.completed', response: end },
    ],
    end,
  );
  const received: string[] = [],
    costs: unknown[] = [];
  const model = createOpenAIModel({
    client: fixture.client,
    onUsage: (value) => {
      costs.push(value);
    },
  });
  const result = await model.complete(input, [], signal(), async (value) => {
    await Promise.resolve();
    received.push(value);
  });
  assert.deepEqual(received, ['draft']);
  assert.equal(result.content, 'canonical');
  assert.equal(fixture.counts().creates, 0);
  assert.equal(fixture.counts().streams, 1);
  assert.equal(costs.length, 1);
});

test('throwing delta observers do not retry requests or change completed response', async () => {
  const fixture = transport([delta('one'), delta('two')], response());
  let observed = 0;
  const result = await createOpenAIModel({ client: fixture.client }).complete(input, [], signal(), async () => {
    observed++;
    throw new Error('observer-private');
  });
  assert.equal(result.content, 'canonical');
  assert.equal(observed, 2);
  assert.equal(fixture.counts().streams, 1);
  assert.equal(fixture.counts().creates, 0);
});

test('create-only injected clients retain compatibility when a delta callback is supplied', async () => {
  let requests = 0;
  const deltas: string[] = [];
  const client: OpenAIClient = {
    responses: {
      create: async (body) => {
        requests++;
        assert.equal(body.stream, false);
        return response();
      },
    },
  };
  assert.equal(
    (
      await createOpenAIModel({ client }).complete(input, [], signal(), (value) => {
        deltas.push(value);
      })
    ).content,
    'canonical',
  );
  assert.equal(requests, 1);
  assert.deepEqual(deltas, []);
});

for (const [label, output, extra, code] of [
  [
    'truncated multi-tool',
    [call('a'), call('b')],
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    'OPENAI_TRUNCATED',
  ],
  [
    'refused multi-tool',
    [call('a'), { ...message(''), content: [{ type: 'refusal', refusal: 'private refusal' }] }, call('b')],
    {},
    'OPENAI_REFUSAL',
  ],
  ['incomplete second tool', [call('a'), { ...call('b'), status: 'incomplete' }], {}, 'OPENAI_INCOMPLETE_RESPONSE'],
] as const)
  test(`streaming ${label} executes no tools, records usage once and commits no partial assistant`, async () => {
    const terminal = response([...output], extra);
    const fixture = transport([delta('uncommitted'), { type: 'response.completed', response: terminal }], terminal);
    let executions = 0,
      accounting = 0;
    const events: AgentEvent[] = [];
    const agent = createAgent({
      model: createOpenAIModel({
        client: fixture.client,
        onUsage: () => {
          accounting++;
          throw new Error('ignored');
        },
      }),
      tools: [
        {
          name: 'effect',
          description: '',
          parameters: { type: 'object' },
          execute: async () => {
            executions++;
          },
        },
      ],
    });
    const result = await agent.run('question', {
      onEvent: (event) => {
        events.push(event);
      },
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error, code);
    assert.equal(executions, 0);
    assert.equal(accounting, 1);
    assert.deepEqual(agent.messages, input);
    assert.equal(events.filter((event) => event.type === 'assistant_delta').length, 1);
    assert.equal(
      events.some((event) => event.type === 'assistant' || event.type === 'tool_start'),
      false,
    );
  });

test('pre-aborted streaming makes no request; abort in delta prevents subsequent deltas and tool commit', async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = transport([delta('first'), delta('late')], response([call('a'), call('b')]));
  const model = createOpenAIModel({ client: fixture.client });
  await assert.rejects(
    model.complete(input, [], controller.signal, () => {}),
    { message: 'OPENAI_ABORTED' },
  );
  assert.equal(fixture.counts().streams, 0);
  const during = new AbortController();
  const seen: AgentEvent[] = [];
  let executions = 0;
  const agent = createAgent({
    model,
    tools: [
      {
        name: 'effect',
        description: '',
        parameters: { type: 'object' },
        execute: async () => {
          executions++;
        },
      },
    ],
  });
  const result = await agent.run('question', {
    signal: during.signal,
    onEvent: (event) => {
      seen.push(event);
      if (event.type === 'assistant_delta') during.abort('private cancellation');
    },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(executions, 0);
  assert.deepEqual(agent.messages, input);
  assert.equal(seen.filter((event) => event.type === 'assistant_delta').length, 1);
  assert.equal(
    seen.some((event) => event.type === 'assistant'),
    false,
  );
});

test('stream finalization errors are sanitized and never promote draft into history', async () => {
  const fixture = transport([delta('draft')], response(), {
    streamError: new Error('private bearer and response body'),
  });
  const agent = createAgent({ model: createOpenAIModel({ client: fixture.client }) });
  const result = await agent.run('question');
  assert.equal(result.status, 'blocked');
  assert.equal(result.error, 'OPENAI_REQUEST_FAILED');
  assert.deepEqual(agent.messages, input);
  assert.doesNotMatch(JSON.stringify(result), /private|bearer|draft/);
});

test('encrypted final output is replayed only inside its own session, never from delta text', async () => {
  const seen: { input: unknown }[] = [];
  let request = 0;
  const client = {
    responses: {
      create: async () => {
        throw new Error('unexpected nonstream');
      },
      stream: (body: unknown) => {
        assert.ok(body && typeof body === 'object' && 'input' in body);
        seen.push(structuredClone(body));
        const result = request++ === 0 ? response([reasoning, call('a')]) : response([message('done')]);
        return {
          abort() {},
          async *[Symbol.asyncIterator]() {
            yield delta('not history');
            yield { type: 'response.completed', response: result };
          },
        };
      },
    },
  } as unknown as OpenAIClient;
  const model = createOpenAIModel({ client });
  const first = createAgent({
    model,
    tools: [{ name: 'effect', description: '', parameters: { type: 'object' }, execute: async () => 'ok' }],
  });
  assert.equal((await first.run('question')).status, 'completed');
  assert.equal((await createAgent({ model }).run('separate')).status, 'completed');
  assert.deepEqual(seen[1].input, [
    ...input,
    reasoning,
    call('a'),
    { type: 'function_call_output', call_id: 'a', output: '"ok"' },
  ]);
  assert.deepEqual(seen[2].input, [{ role: 'user', content: 'separate' }]);
  assert.doesNotMatch(JSON.stringify(first.messages), /not history/);
});

test('core sequences per-step deltas before final assistant and isolates event observer exceptions', async () => {
  const events: AgentEvent[] = [];
  let step = 0;
  let agent: ReturnType<typeof createAgent>;
  agent = createAgent({
    model: {
      complete: async (_history, _tools, _signal, onTextDelta) => {
        step++;
        await onTextDelta?.('');
        await onTextDelta?.(`draft-${step}`);
        assert.equal(
          agent.messages.some((message) => message.content === `draft-${step}`),
          false,
        );
        return step === 1
          ? {
              role: 'assistant',
              content: 'final-1',
              tool_calls: [{ id: 'a', type: 'function', function: { name: 'effect', arguments: '{}' } }],
            }
          : { role: 'assistant', content: 'final-2' };
      },
    },
    tools: [{ name: 'effect', description: '', parameters: { type: 'object' }, execute: async () => 'ok' }],
  });
  assert.equal(
    (
      await agent.run('question', {
        onEvent: (event) => {
          events.push(event);
          throw new Error('observer failure');
        },
      })
    ).status,
    'completed',
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'assistant_delta' || event.type === 'assistant'),
    [
      { type: 'assistant_delta', text: 'draft-1', step: 1 },
      { type: 'assistant', text: 'final-1', step: 1 },
      { type: 'assistant_delta', text: 'draft-2', step: 2 },
      { type: 'assistant', text: 'final-2', step: 2 },
    ],
  );
});

import { PureAgentTUI } from '../src/ui/tui.ts';
import { safeText } from '../src/ui/view.ts';
import type { Terminal } from '@earendil-works/pi-tui';
function headless() {
  let input: ((data: string) => void) | undefined;
  const terminal: Terminal = {
    columns: 100,
    rows: 35,
    kittyProtocolActive: false,
    start(onInput) {
      input = onInput;
    },
    stop() {},
    async drainInput() {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
  };
  const ui = new PureAgentTUI({ terminal, modeLabel: 'TEST · offline', note: '' });
  ui.start();
  return {
    ui,
    send: (text: string) => input?.(text),
    screen: () => {
      ui.tui.renderNow();
      return ui.tui.getScreenLines().map(safeText).join('\n');
    },
  };
}

test('TUI replaces streamed draft with canonical text once, preserves editor and clears draft on reset', (t) => {
  const { ui, screen } = headless();
  t.after(() => ui.stop());
  ui.editor.setText('my next question');
  ui.event({ type: 'model_start', step: 1 });
  ui.event({ type: 'assistant_delta', step: 1, text: 'draft-only-marker' });
  assert.match(screen(), /draft-only-marker/);
  ui.event({ type: 'assistant', step: 1, text: 'canonical-answer-marker' });
  ui.finish({ status: 'completed', text: 'canonical-answer-marker', steps: 1 });
  assert.doesNotMatch(screen(), /draft-only-marker/);
  assert.equal(screen().match(/canonical-answer-marker/g)?.length, 1);
  assert.equal(ui.editor.getText(), 'my next question');
  ui.reset();
  ui.event({ type: 'model_start', step: 1 });
  ui.event({ type: 'assistant_delta', step: 1, text: 'new-session-marker' });
  assert.match(screen(), /new-session-marker/);
  assert.doesNotMatch(screen(), /canonical-answer-marker/);
});

test('TUI interrupted stream remains visibly partial and never contaminates next completed draft', (t) => {
  const { ui, screen } = headless();
  t.after(() => ui.stop());
  ui.event({ type: 'model_start', step: 1 });
  ui.event({ type: 'assistant_delta', step: 1, text: 'cancelled-fragment' });
  ui.finish({ status: 'cancelled', text: '', steps: 1 });
  assert.match(screen(), /cancelled-fragment/);
  assert.match(screen(), /partial|interrupted|incomplete/i);
  ui.event({ type: 'model_start', step: 1 });
  ui.event({ type: 'assistant_delta', step: 1, text: 'fresh-fragment' });
  ui.event({ type: 'assistant', step: 1, text: 'fresh-complete' });
  ui.finish({ status: 'completed', text: 'fresh-complete', steps: 1 });
  const frame = screen();
  assert.equal(frame.match(/cancelled-fragment/g)?.length, 1);
  assert.equal(frame.match(/fresh-complete/g)?.length, 1);
  assert.doesNotMatch(frame, /fresh-fragment/);
});

test('TUI streamed updates preserve deliberate scroll position and typed draft', (t) => {
  const { ui, screen, send } = headless();
  t.after(() => ui.stop());
  for (let i = 0; i < 45; i++) ui.panel('AGENT', `old-message-${i}`);
  ui.event({ type: 'model_start', step: 1 });
  ui.event({ type: 'assistant_delta', step: 1, text: 'bottom-draft' });
  screen();
  send('\x1b[5~');
  send('\x1b[5~');
  ui.editor.setText('preserve me');
  const before = screen();
  ui.event({ type: 'assistant_delta', step: 1, text: '\nmore bottom output' });
  const after = screen();
  assert.equal(ui.editor.getText(), 'preserve me');
  assert.doesNotMatch(after, /more bottom output/);
  assert.equal(after.split('\n').slice(1, 15).join('\n'), before.split('\n').slice(1, 15).join('\n'));
});

import OpenAI from 'openai';
test('official SDK stream helper consumes offline SSE and retains terminal encrypted output and accounting', async () => {
  let requests = 0;
  const seen: string[] = [],
    costs: unknown[] = [];
  const completed = {
    ...response([reasoning, message('hello')]),
    id: 'resp-fixture',
    object: 'response',
    created_at: 1,
    model: 'offline-fixture',
  };
  const events = [
    { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] }, sequence_number: 0 },
    { type: 'response.output_item.added', output_index: 0, item: reasoning, sequence_number: 1 },
    { type: 'response.output_item.done', output_index: 0, item: reasoning, sequence_number: 2 },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { ...message(''), status: 'in_progress', content: [] },
      sequence_number: 3,
    },
    {
      type: 'response.content_part.added',
      item_id: 'msg',
      output_index: 1,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
      sequence_number: 4,
    },
    { ...delta('hello'), output_index: 1, sequence_number: 5, logprobs: [] },
    {
      type: 'response.output_text.done',
      item_id: 'msg',
      output_index: 1,
      content_index: 0,
      text: 'hello',
      sequence_number: 6,
      logprobs: [],
    },
    {
      type: 'response.content_part.done',
      item_id: 'msg',
      output_index: 1,
      content_index: 0,
      part: { type: 'output_text', text: 'hello', annotations: [], logprobs: [] },
      sequence_number: 7,
    },
    { type: 'response.output_item.done', output_index: 1, item: message('hello'), sequence_number: 8 },
    { type: 'response.completed', response: completed, sequence_number: 9 },
  ];
  const client = new OpenAI({
    apiKey: 'offline-fixture-not-a-key',
    maxRetries: 0,
    fetch: async (_url, init) => {
      requests++;
      assert.equal(JSON.parse(String(init?.body)).stream, true);
      return new globalThis.Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const result = await createOpenAIModel({
    client,
    onUsage: (cost) => {
      costs.push(cost);
    },
  }).complete(input, [], signal(), (text) => {
    seen.push(text);
  });
  assert.equal(requests, 1);
  assert.deepEqual(seen, ['hello']);
  assert.equal(result.content, 'hello');
  assert.equal(costs.length, 1);
  assert.ok(result.providerData);
  assert.deepEqual((result.providerData.data as { output: unknown[] }).output[0], reasoning);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

for (const [label, events, error] of [
  ['missing terminal', [delta('unfinished')], 'OPENAI_INCOMPLETE_RESPONSE'],
  ['error event', [delta('unfinished'), { type: 'error', message: 'private server detail' }], 'OPENAI_RESPONSE_FAILED'],
] as const)
  test(`stream ${label} fails closed without accepting tool-like interim data`, async () => {
    const client = {
      responses: {
        create: async () => response(),
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'response.output_item.done', item: call('a'), output_index: 0 };
            for (const event of events) yield event;
          },
        }),
      },
    } as unknown as OpenAIClient;
    let executions = 0;
    const agent = createAgent({
      model: createOpenAIModel({ client }),
      tools: [
        {
          name: 'effect',
          description: '',
          parameters: { type: 'object' },
          execute: async () => {
            executions++;
          },
        },
      ],
    });
    const result = await agent.run('question');
    assert.equal(result.error, error);
    assert.equal(executions, 0);
    assert.deepEqual(agent.messages, input);
  });

test('first terminal event is final: late deltas, duplicate usage and later tool output are ignored', async () => {
  let costs = 0;
  const seen: string[] = [];
  const fixture = transport(
    [
      delta('draft'),
      { type: 'response.completed', response: response([message('first')]) },
      delta('late'),
      { type: 'response.completed', response: response([call('unexpected')]) },
    ],
    response(),
  );
  const result = await createOpenAIModel({
    client: fixture.client,
    onUsage: () => {
      costs++;
    },
  }).complete(input, [], signal(), (text) => {
    seen.push(text);
  });
  assert.equal(result.content, 'first');
  assert.equal(result.tool_calls, undefined);
  assert.deepEqual(seen, ['draft']);
  assert.equal(costs, 1);
});

test('late model callbacks cannot write into a finished run or a later session turn', async () => {
  const callbacks: Array<(text: string) => void | Promise<void>> = [];
  const events: AgentEvent[] = [];
  const agent = createAgent({
    model: {
      complete: async (_messages, _tools, _signal, callback) => {
        assert.ok(callback);
        callbacks.push(callback);
        return { role: 'assistant', content: 'final' };
      },
    },
  });
  await agent.run('first', {
    onEvent: (event) => {
      events.push(event);
    },
  });
  await callbacks[0]('late-first');
  await agent.run('second', {
    onEvent: (event) => {
      events.push(event);
    },
  });
  await callbacks[0]('late-again');
  await callbacks[1]('late-second');
  assert.equal(events.filter((event) => event.type === 'assistant_delta').length, 0);
  assert.deepEqual(
    agent.messages.map((message) => message.content),
    ['first', 'final', 'second', 'final'],
  );
});

function sdkFixture(events: unknown[]) {
  let requests = 0;
  const client = new OpenAI({
    apiKey: 'offline-fixture-not-a-key',
    maxRetries: 0,
    fetch: async () => {
      requests++;
      return new globalThis.Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  return { client, requests: () => requests };
}
const sdkResponse = (output: unknown[], extra: object = {}) => ({
  ...response(output, extra),
  id: 'resp-sdk-failure',
  object: 'response',
  created_at: 1,
  model: 'offline-fixture',
});
const sdkCreated = () => ({
  type: 'response.created',
  sequence_number: 0,
  response: sdkResponse([], { status: 'in_progress' }),
});

test('official SDK converts SSE error to sanitized request failure without retry or tool execution', async () => {
  const fixture = sdkFixture([
    sdkCreated(),
    { type: 'error', sequence_number: 1, code: 'server_error', message: 'private response detail', param: null },
  ]);
  let executions = 0,
    costs = 0;
  const agent = createAgent({
    model: createOpenAIModel({
      client: fixture.client,
      onUsage: () => {
        costs++;
      },
    }),
    tools: [
      {
        name: 'effect',
        description: '',
        parameters: { type: 'object' },
        execute: async () => {
          executions++;
        },
      },
    ],
  });
  const result = await agent.run('question');
  assert.equal(result.status, 'blocked');
  assert.equal(result.error, 'OPENAI_REQUEST_FAILED');
  assert.equal(fixture.requests(), 1);
  assert.equal(executions, 0);
  assert.equal(costs, 0);
  assert.deepEqual(agent.messages, input);
  assert.doesNotMatch(JSON.stringify(result), /private response detail/);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('official SDK incomplete terminal preserves usage but rejects all completed-looking tools', async () => {
  const fixture = sdkFixture([
    sdkCreated(),
    {
      type: 'response.incomplete',
      sequence_number: 1,
      response: sdkResponse([reasoning, call('a'), call('b')], {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    },
  ]);
  let executions = 0;
  const costs: unknown[] = [];
  const agent = createAgent({
    model: createOpenAIModel({
      client: fixture.client,
      onUsage: (cost) => {
        costs.push(cost);
      },
    }),
    tools: [
      {
        name: 'effect',
        description: '',
        parameters: { type: 'object' },
        execute: async () => {
          executions++;
        },
      },
    ],
  });
  const result = await agent.run('question');
  assert.equal(result.status, 'blocked');
  assert.equal(result.error, 'OPENAI_TRUNCATED');
  assert.equal(fixture.requests(), 1);
  assert.equal(executions, 0);
  assert.equal(costs.length, 1);
  assert.deepEqual(agent.messages, input);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('official SDK cancellation in text callback discards buffered terminal tools and later text', async () => {
  const fixture = sdkFixture([
    sdkCreated(),
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { ...message(''), status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      sequence_number: 2,
      item_id: 'msg',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
    },
    { ...delta('first'), sequence_number: 3, logprobs: [] },
    { ...delta('late'), sequence_number: 4, logprobs: [] },
    { type: 'response.completed', sequence_number: 5, response: sdkResponse([message('firstlate'), call('a')]) },
  ]);
  const abort = new AbortController();
  let executions = 0;
  const deltas: string[] = [];
  const agent = createAgent({
    model: createOpenAIModel({ client: fixture.client }),
    tools: [
      {
        name: 'effect',
        description: '',
        parameters: { type: 'object' },
        execute: async () => {
          executions++;
        },
      },
    ],
  });
  const result = await agent.run('question', {
    signal: abort.signal,
    onEvent: (event) => {
      if (event.type === 'assistant_delta') {
        deltas.push(event.text);
        abort.abort('private abort reason');
      }
    },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(executions, 0);
  assert.equal(fixture.requests(), 1);
  assert.deepEqual(deltas, ['first']);
  assert.deepEqual(agent.messages, input);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('fire-and-forget model deltas drain asynchronous observers before final assistant and done', async () => {
  const delivered: string[] = [];
  const agent = createAgent({
    model: {
      complete: async (_messages, _tools, _signal, callback) => {
        void callback?.('first');
        void callback?.('second');
        return { role: 'assistant', content: 'final' };
      },
    },
  });
  const result = await agent.run('question', {
    onEvent: async (event) => {
      if (event.type === 'assistant_delta') {
        await new Promise<void>((resolve) => setImmediate(resolve));
        delivered.push(event.text);
      } else if (event.type === 'assistant' || event.type === 'done') delivered.push(event.type);
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(delivered, ['first', 'second', 'assistant', 'done']);
});
