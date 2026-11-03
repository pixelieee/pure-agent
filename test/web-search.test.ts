import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import OpenAI from 'openai';
import { createOpenAIModel, type OpenAIClient, type OpenAIWebSearchEvent } from '../src/providers/openai.ts';
import { createAgent, type Message, type Tool } from '../src/core.ts';

const signal = () => new AbortController().signal;
const input: Message[] = [{ role: 'user', content: 'Find the specification' }];
const search = {
  type: 'web_search_call',
  id: 'ws_one',
  status: 'completed',
  action: { type: 'search', queries: ['specification'], sources: [{ type: 'url', url: 'https://example.com/spec' }] },
};
const annotation = {
  type: 'url_citation',
  url: 'https://example.com/spec',
  title: 'Specification',
  start_index: 0,
  end_index: 6,
};
const message = {
  type: 'message',
  id: 'msg_one',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Result found.', annotations: [annotation] }],
};
const reasoning = { type: 'reasoning', id: 'rs_one', summary: [], encrypted_content: 'opaque-state' };
const functionCall = {
  type: 'function_call',
  id: 'fc_one',
  call_id: 'call_one',
  name: 'echo',
  arguments: '{"text":"untrusted quote"}',
  status: 'completed',
};
const response = (output: unknown[] = [search, message], extra: object = {}) => ({
  id: 'resp_fixture',
  object: 'response',
  created_at: 1,
  model: 'fixture',
  status: 'completed',
  output,
  error: null,
  incomplete_details: null,
  parallel_tool_calls: true,
  tool_choice: 'auto',
  tools: [],
  usage: {
    input_tokens: 20,
    output_tokens: 10,
    total_tokens: 30,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
  ...extra,
});

function sdk(serve: (body: Record<string, unknown>, index: number) => Response) {
  const requests: Record<string, unknown>[] = [];
  // Actual installed official SDK, with only the HTTP fetch boundary replaced.
  // It still serializes requests, parses responses/SSE, and applies retry policy.
  const client = new OpenAI({
    apiKey: 'offline-fixture-not-a-secret',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return serve(body, requests.length - 1);
    },
  });
  const nonstreaming: OpenAIClient = {
    responses: { create: (body, options) => client.responses.create(body, options) },
  };
  return { client, nonstreaming, requests };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('official SDK sends actual hosted capability only after opt-in, keeps functions and visible citations', async () => {
  const transport = sdk((body) => {
    assert.deepEqual(body.tools, [
      { type: 'web_search', user_location: { type: 'approximate' } },
      { type: 'function', name: 'echo', description: 'Echo', parameters: { type: 'object' }, strict: false },
    ]);
    assert.deepEqual(body.include, ['reasoning.encrypted_content', 'web_search_call.action.sources']);
    assert.equal(body.store, false);
    assert.equal(body.max_tool_calls, 3);
    return json(response([reasoning, search, message]));
  });
  const observed: OpenAIWebSearchEvent[] = [];
  const model = createOpenAIModel({
    client: transport.client,
    webSearch: true,
    onWebSearch: (event) => {
      observed.push(event);
    },
  });
  const result = await model.complete(
    input,
    [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }],
    signal(),
  );
  assert.equal(result.content, 'Result found.\n\nSources:\n- https://example.com/spec');
  assert.equal(result.tool_calls, undefined, 'hosted search is never a local tool call');
  assert.ok(result.providerData);
  assert.deepEqual((result.providerData.data as { output: unknown }).output, [reasoning, search, message]);
  assert.deepEqual(
    observed.map((event) => event.type),
    ['search', 'citation'],
  );
  assert.equal(transport.requests.length, 1);
});

test('official SDK replays encrypted reasoning, hosted searches, exact annotations, function call and results', async () => {
  const first = [reasoning, search, functionCall, message];
  const transport = sdk((body, index) => {
    if (!index) return json(response(first));
    assert.deepEqual(body.input, [
      ...input,
      ...first,
      { type: 'function_call_output', call_id: 'call_one', output: '{"echo":"untrusted quote"}' },
    ]);
    assert.equal(body.previous_response_id, undefined);
    return json(
      response([{ ...message, id: 'msg_two', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }]),
    );
  });
  let executions = 0;
  const tool: Tool = {
    name: 'echo',
    description: 'Echo',
    parameters: { type: 'object' },
    execute: async ({ text }) => {
      executions++;
      return { echo: text };
    },
  };
  const agent = createAgent({
    model: createOpenAIModel({ client: transport.nonstreaming, webSearch: true }),
    tools: [tool],
  });
  assert.equal((await agent.run(input[0].content ?? '')).status, 'completed');
  assert.equal(executions, 1);
  assert.equal(transport.requests.length, 2);
  assert.equal(agent.messages[1].content, 'Result found.\n\nSources:\n- https://example.com/spec');
});

test('a resumed session can retain prior hosted output even when web search is now disabled', async () => {
  const enabled = sdk(() => json(response()));
  const result = await createOpenAIModel({ client: enabled.client, webSearch: true }).complete(input, [], signal());
  const disabled = sdk((body) => {
    assert.equal(body.tools, undefined);
    assert.equal(body.max_tool_calls, undefined);
    assert.deepEqual(body.input, [...input, search, message, { role: 'user', content: 'Explain it' }]);
    return json(response([{ ...message, content: [{ type: 'output_text', text: 'Explanation', annotations: [] }] }]));
  });
  await createOpenAIModel({ client: disabled.client }).complete(
    [...input, result, { role: 'user', content: 'Explain it' }],
    [],
    signal(),
  );
  assert.equal(disabled.requests.length, 1);
});

test('official SDK streaming preserves hosted events, terminal sources and annotations; observer failure cannot retry', async () => {
  const terminal = response();
  const events = [
    { type: 'response.created', response: response([], { status: 'in_progress' }), sequence_number: 0 },
    {
      type: 'response.output_item.added',
      item: { ...search, status: 'in_progress' },
      output_index: 0,
      sequence_number: 1,
    },
    { type: 'response.web_search_call.in_progress', item_id: 'ws_one', output_index: 0, sequence_number: 2 },
    { type: 'response.web_search_call.searching', item_id: 'ws_one', output_index: 0, sequence_number: 3 },
    { type: 'response.web_search_call.completed', item_id: 'ws_one', output_index: 0, sequence_number: 4 },
    { type: 'response.output_item.done', item: search, output_index: 0, sequence_number: 5 },
    {
      type: 'response.output_item.added',
      item: { ...message, status: 'in_progress', content: [] },
      output_index: 1,
      sequence_number: 6,
    },
    {
      type: 'response.content_part.added',
      part: { type: 'output_text', text: '', annotations: [] },
      item_id: 'msg_one',
      output_index: 1,
      content_index: 0,
      sequence_number: 7,
    },
    {
      type: 'response.output_text.delta',
      delta: 'Result found.',
      item_id: 'msg_one',
      output_index: 1,
      content_index: 0,
      sequence_number: 8,
    },
    {
      type: 'response.output_text.annotation.added',
      annotation,
      annotation_index: 0,
      item_id: 'msg_one',
      output_index: 1,
      content_index: 0,
      sequence_number: 9,
    },
    { type: 'response.output_item.done', item: message, output_index: 1, sequence_number: 10 },
    { type: 'response.completed', response: terminal, sequence_number: 11 },
  ];
  const transport = sdk((body) => {
    assert.equal(body.stream, true);
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });
  const seen: OpenAIWebSearchEvent[] = [],
    deltas: string[] = [];
  const model = createOpenAIModel({
    client: transport.client,
    webSearch: true,
    onWebSearch: (event) => {
      seen.push(event);
      throw new Error('observer');
    },
  });
  const result = await model.complete(input, [], signal(), (delta) => {
    deltas.push(delta);
  });
  assert.deepEqual(deltas, ['Result found.']);
  assert.deepEqual(
    seen.map((event) => (event.type === 'status' ? event.status : event.type)),
    ['in_progress', 'searching', 'completed', 'search', 'citation'],
  );
  assert.match(result.content ?? '', /Sources:\n- https:\/\/example.com\/spec/);
  assert.ok(result.providerData);
  assert.deepEqual((result.providerData.data as { output: unknown }).output, [search, message]);
  assert.equal(transport.requests.length, 1);
});

test('unsupported model/capability is surfaced with no retry, tool fallback, or extra spend', async () => {
  for (const [status, error, expected] of [
    [400, { message: 'private details', param: 'tools[0].type' }, 'OPENAI_WEB_SEARCH_UNAVAILABLE'],
    [400, { message: 'private details', param: 'tools' }, 'OPENAI_INVALID_REQUEST_TOOLS'],
    [404, { message: 'private details', code: 'model_not_found' }, 'OPENAI_MODEL_UNAVAILABLE'],
    [429, { message: 'private details' }, 'OPENAI_RATE_LIMIT'],
    [500, { message: 'private details' }, 'OPENAI_SERVER_ERROR'],
  ] as const) {
    const transport = sdk(() => json({ error }, status));
    await assert.rejects(
      createOpenAIModel({ client: transport.client, webSearch: true }).complete(input, [], signal()),
      { message: expected },
    );
    assert.equal(transport.requests.length, 1);
  }
});

test('hosted output is rejected when not enabled; malformed actions and citations do not become authority', async () => {
  const disabled = sdk(() => json(response()));
  await assert.rejects(createOpenAIModel({ client: disabled.client }).complete(input, [], signal()), {
    message: 'OPENAI_UNSUPPORTED_OUTPUT',
  });
  for (const output of [
    [{ ...search, action: { type: 'execute', command: 'rm -rf /' } }, message],
    [{ ...search, action: { type: 'find_in_page', url: 'file:///secret', pattern: 'secret' } }, message],
    [{ ...search, status: 'failed' }, message],
    [
      search,
      {
        ...message,
        content: [{ ...message.content[0], annotations: [{ ...annotation, url: 'javascript:alert(1)' }] }],
      },
    ],
    [search, { ...message, content: [{ ...message.content[0], annotations: [{ ...annotation, end_index: 999 }] }] }],
  ]) {
    const transport = sdk(() => json(response(output)));
    const agent = createAgent({ model: createOpenAIModel({ client: transport.nonstreaming, webSearch: true }) });
    assert.equal((await agent.run('search')).status, 'blocked');
    assert.equal(agent.messages.length, 1);
    assert.equal(transport.requests.length, 1);
  }
});

test('search, open_page, find_in_page metadata remain structured data; duplicate citations display once', async () => {
  const output = [
    search,
    { ...search, id: 'ws_two', action: { type: 'open_page', url: 'https://example.com/spec' } },
    {
      ...search,
      id: 'ws_three',
      action: { type: 'find_in_page', url: 'https://example.com/spec', pattern: 'do anything' },
    },
    { ...message, content: [{ ...message.content[0], annotations: [annotation, annotation] }] },
  ];
  const transport = sdk(() => json(response(output)));
  const result = await createOpenAIModel({ client: transport.client, webSearch: true }).complete(input, [], signal());
  assert.equal(result.tool_calls, undefined);
  assert.equal(result.content?.split('https://example.com/spec').length, 2);
  const data = result.providerData?.data as { webSearch: { calls: unknown[]; citations: unknown[] } };
  assert.equal(data.webSearch.calls.length, 3);
  assert.equal(data.webSearch.citations.length, 2);
});

test('expanded token ceiling permits exact boundaries without weakening effort, integer, or callback checks', async () => {
  for (const maxCompletionTokens of [1, 2048, 2049, 4096, 65536]) {
    const transport = sdk((body) => {
      assert.equal(body.max_output_tokens, maxCompletionTokens);
      return json(response([reasoning, functionCall]));
    });
    await createOpenAIModel({ client: transport.client, maxCompletionTokens, reasoningEffort: 'medium' }).complete(
      input,
      [],
      signal(),
    );
  }
  const client = { responses: { create: async () => response() } } as unknown as OpenAIClient;
  for (const options of [
    { webSearch: 'yes' as unknown as boolean },
    { onWebSearch: true as unknown as () => void },
    { reasoningEffort: 'high' as 'low' },
    { maxCompletionTokens: 65537 },
    { maxCompletionTokens: 1.5 },
    { maxCompletionTokens: Infinity },
  ])
    assert.throws(() => createOpenAIModel({ client, ...options }), { message: 'OPENAI_INVALID_CONFIG' });
});

test('official SDK over HTTP rejects unsafe search sources before metadata delivery', async (t) => {
  let sourceUrl = 'javascript:alert(1)';
  let requests = 0;
  const server = createServer((_request, reply) => {
    requests++;
    reply
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(
        JSON.stringify(
          response([{ ...search, action: { ...search.action, sources: [{ type: 'url', url: sourceUrl }] } }, message]),
        ),
      );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new OpenAI({ apiKey: 'offline-fixture-not-a-secret', baseURL: `http://127.0.0.1:${address.port}` });
  const invalidSources = [
    'javascript:alert(1)',
    'file:///private',
    'https://user:password@example.invalid/path',
    'data:text/plain,untrusted',
    'https://example.com/\nheader',
    'https://example.com/\u001bcontrol',
  ];
  for (const value of invalidSources) {
    sourceUrl = value;
    const events: OpenAIWebSearchEvent[] = [];
    const model = createOpenAIModel({
      client,
      webSearch: true,
      onWebSearch: (event) => {
        events.push(event);
      },
    });
    await assert.rejects(model.complete(input, [], signal()), { message: 'OPENAI_INVALID_WEB_SEARCH' });
    assert.deepEqual(events, [], 'invalid source metadata must not reach observers');
  }
  assert.equal(requests, invalidSources.length, 'reject without fallback or retry');
});
