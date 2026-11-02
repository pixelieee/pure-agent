import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createOpenAIModel } from '../src/providers/openai.ts';
import type { OpenAIClient } from '../src/providers/openai.ts';
import { createAgent } from '../src/core.ts';
import type { Message, Tool } from '../src/core.ts';
const signal = () => new AbortController().signal;
const messages: Message[] = [{ role: 'user', content: 'Hello' }];
const text = (value = 'Hello') => ({ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value, annotations: [] }] });
const call = { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'echo', arguments: '{"text":"hi"}', status: 'completed' };
const reasoning = { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'opaque-encrypted-data' };
type Result = Awaited<ReturnType<OpenAIClient['responses']['create']>>;
const response = (output: unknown[] = [text()], extra: object = {}): Result => ({ output, status: 'completed', error: null, incomplete_details: null, usage: undefined, ...extra }) as unknown as Result;
const mock = (create: OpenAIClient['responses']['create']): OpenAIClient => ({ responses: { create } });

test('default request is stateless low-reasoning Responses, bounded, no retries or empty tools', async () => {
  const abort = signal(); let requests = 0;
  const model = createOpenAIModel({ client: mock(async (body, options) => {
    requests++;
    assert.deepEqual(body, { model: 'gpt-5.6-luna', input: messages, reasoning: { effort: 'low' }, max_output_tokens: 1024,
      stream: false, store: false, include: ['reasoning.encrypted_content'] });
    assert.deepEqual(options, { signal: abort, maxRetries: 0, timeout: 30000 });
    return response();
  }) });
  const result = await model.complete(messages, [], abort);
  assert.equal(result.content, 'Hello');
  assert.deepEqual(result.providerData, { kind: 'openai.responses', data: { output: [text()] } });
  assert.equal(requests, 1); assert.deepEqual(Object.keys(model), ['complete']);
});

test('flat function declarations exclude execute; call_id is normalized, not output id', async () => {
  let executions = 0;
  const tool: Tool = { name: 'echo', description: 'Echo', parameters: { type: 'object' }, execute: async () => executions++ };
  const model = createOpenAIModel({ model: 'test-model', reasoningEffort: 'medium', maxCompletionTokens: 256, client: mock(async body => {
    assert.equal(body.model, 'test-model'); assert.deepEqual(body.reasoning, { effort: 'medium' }); assert.equal(body.max_output_tokens, 256);
    assert.deepEqual(body.tools, [{ type: 'function', name: 'echo', description: 'Echo', parameters: { type: 'object' }, strict: false }]);
    return response([reasoning, call]);
  }) });
  const result = await model.complete(messages, [tool], signal());
  assert.deepEqual(result.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: call.arguments } }]);
  assert.equal(executions, 0);
});

test('core retains encrypted reasoning and replays exact output before function result', async () => {
  let step = 0;
  const output = [reasoning, call];
  const model = createOpenAIModel({ client: mock(async body => {
    if (step++ === 0) return response(output);
    assert.deepEqual(body.input, [...messages, ...output, { type: 'function_call_output', call_id: 'c1', output: '{"text":"hi"}' }]);
    assert.equal(body.previous_response_id, undefined);
    return response([text('Done')]);
  }) });
  const agent = createAgent({ model, tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object' }, execute: async args => args }] });
  assert.equal((await agent.run('Hello')).status, 'completed');
  assert.equal(step, 2);
});

test('shared model has no cross-session history and converts legacy assistant messages', async () => {
  const seen: unknown[] = [];
  const model = createOpenAIModel({ client: mock(async body => { seen.push(body.input); return response(); }) });
  await createAgent({ model }).run('Session A'); await createAgent({ model }).run('Session B');
  assert.deepEqual(seen, [[{ role: 'user', content: 'Session A' }], [{ role: 'user', content: 'Session B' }]]);
  await model.complete([{ role: 'system', content: 'System' }, { role: 'assistant', content: 'Old answer' }], [], signal());
  assert.deepEqual(seen[2], [{ role: 'system', content: 'System' }, { role: 'assistant', content: 'Old answer' }]);
});

for (const [name, result, code] of [
  ['truncation', response([], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 'TRUNCATED'],
  ['content filter', response([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }), 'INCOMPLETE_RESPONSE'],
  ['failed', response([], { status: 'failed', error: { message: 'private' } }), 'RESPONSE_FAILED'],
  ['pending', response([], { status: 'in_progress' }), 'INCOMPLETE_RESPONSE'],
  ['empty output', response([]), 'INVALID_RESPONSE'],
  ['only reasoning', response([reasoning]), 'INVALID_RESPONSE'],
  ['unsupported capability', response([{ type: 'web_search_call' }]), 'UNSUPPORTED_OUTPUT'],
  ['refusal', response([{ ...text(), content: [{ type: 'refusal', refusal: 'private' }] }]), 'REFUSAL'],
  ['incomplete tool', response([{ ...call, status: 'incomplete' }]), 'INCOMPLETE_RESPONSE'],
  ['partial arguments', response([{ ...call, arguments: '{' }]), 'INVALID_TOOL_CALL'],
  ['nonobject arguments', response([{ ...call, arguments: 'null' }]), 'INVALID_TOOL_CALL'],
  ['missing call ID', response([{ ...call, call_id: '' }]), 'INVALID_TOOL_CALL'],
  ['duplicate call IDs', response([call, call]), 'INVALID_TOOL_CALL'],
] as const) test(`rejects ${name}`, async () => {
  await assert.rejects(createOpenAIModel({ client: mock(async () => result) }).complete(messages, [], signal()), { message: `OPENAI_${code}` });
});

test('rejects changed/foreign provider envelope before request', async () => {
  let requests = 0;
  const model = createOpenAIModel({ client: mock(async () => { requests++; return response(); }) });
  for (const providerData of [{ kind: 'other', data: {} }, { kind: 'openai.responses', data: { output: [text('Different')] } }]) {
    await assert.rejects(model.complete([{ role: 'assistant', content: 'Hello', providerData }], [], signal()), { message: 'OPENAI_INVALID_PROVIDER_DATA' });
  }
  assert.equal(requests, 0);
});

test('abort before request, during transport and after response stays sanitized', async () => {
  for (const throws of [true, false]) {
    let requests = 0; const controller = new AbortController();
    const model = createOpenAIModel({ client: mock(async (_body, options) => {
      requests++; assert.equal(options.signal, controller.signal); controller.abort('private');
      if (throws) throw new Error('private body'); return response();
    }) });
    await assert.rejects(model.complete(messages, [], controller.signal), { message: 'OPENAI_ABORTED' });
    await assert.rejects(model.complete(messages, [], controller.signal), { message: 'OPENAI_ABORTED' });
    assert.equal(requests, 1);
  }
});

for (const [error, code] of [
  [new Error('private key'), 'REQUEST_FAILED'],
  [new OpenAI.APIError(400, { param: 'reasoning', message: 'private' }, 'private', new Headers()), 'INVALID_REQUEST_REASONING'],
  [new OpenAI.APIError(400, { param: 'private-key', message: 'private' }, 'private', new Headers()), 'INVALID_REQUEST'],
  [new OpenAI.APIError(401, {}, 'private', new Headers()), 'AUTHENTICATION'],
  [new OpenAI.APIError(404, { code: 'model_not_found' }, 'private', new Headers()), 'MODEL_UNAVAILABLE'],
  [new OpenAI.APIError(404, {}, 'private', new Headers()), 'NOT_FOUND'],
  [new OpenAI.APIError(429, {}, 'private', new Headers()), 'RATE_LIMIT'],
  [new OpenAI.APIConnectionTimeoutError(), 'TIMEOUT'],
] as const) test(`sanitized ${code}, no retries`, async () => {
  let requests = 0;
  const model = createOpenAIModel({ client: mock(async () => { requests++; throw error; }) });
  await assert.rejects(model.complete(messages, [], signal()), caught => {
    assert.equal((caught as Error).message, `OPENAI_${code}`); assert.equal((caught as Error).cause, undefined);
    assert.equal(JSON.stringify(caught).includes('private'), false); return true;
  });
  assert.equal(requests, 1);
});

test('explicit key/config bounds', () => {
  assert.throws(() => createOpenAIModel({}), { message: 'OPENAI_MISSING_API_KEY' });
  for (const maxCompletionTokens of [0, -1, 2049, 1.2, NaN]) assert.throws(() => createOpenAIModel({ maxCompletionTokens, client: mock(async () => response()) }), { message: 'OPENAI_INVALID_CONFIG' });
  assert.throws(() => createOpenAIModel({ reasoningEffort: 'high' as 'low', client: mock(async () => response()) }), { message: 'OPENAI_INVALID_CONFIG' });
});

test('numeric-only Responses usage recorded on truncation; observer failure isolated', async () => {
  const received: unknown[] = [];
  const model = createOpenAIModel({ onUsage: async usage => { received.push(usage); throw new Error('private'); }, client: mock(async () => response([], {
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 12, output_tokens: 30, total_tokens: 42,
      input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 20 }, private_value: 'private' },
  })) });
  await assert.rejects(model.complete(messages, [], signal()), { message: 'OPENAI_TRUNCATED' });
  assert.deepEqual(received, [{ promptTokens: 12, completionTokens: 30, totalTokens: 42, cachedTokens: 5, reasoningTokens: 20 }]);
});
