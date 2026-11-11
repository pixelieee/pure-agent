import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAgentSnapshot } from '../src/core.ts';
import type { ContextProjector, Message } from '../src/core.ts';

// Pure protocol data checks only. These fixtures are never returned by a model.
// Model-loop behavior remains pending real API acceptance.
const call = { id: 'a', type: 'function' as const, function: { name: 'read', arguments: '{}' } };
const turn: Message[] = [
  { role: 'user', content: 'Read' },
  { role: 'assistant', content: null, tool_calls: [call] },
  { role: 'tool', tool_call_id: 'a', content: 'Result' },
];

test('projection protocol accepts complete tool turns and detaches nested data', () => {
  const input = structuredClone(turn);
  input[1].providerData = { kind: 'opaque', data: { value: 'original' } };
  const output = validateAgentSnapshot({ version: 1, messages: input }).messages;
  assert.ok(input[1].tool_calls);
  input[1].tool_calls[0].function.name = 'mutated';
  (input[1].providerData.data as { value: string }).value = 'mutated';
  assert.equal(output[1].tool_calls?.[0].function.name, 'read');
  assert.deepEqual(output[1].providerData, { kind: 'opaque', data: { value: 'original' } });
});

test('projection protocol rejects orphaned, unfinished, duplicate and misordered tool data', () => {
  const other = { ...call, id: 'b' };
  for (const messages of [
    [turn[2]],
    turn.slice(0, 2),
    [turn[0], { ...turn[1], tool_calls: [call, call] }, turn[2]],
    [turn[0], { ...turn[1], tool_calls: [call, other] }, { ...turn[2], tool_call_id: 'b' }, turn[2]],
  ]) {
    assert.throws(() => validateAgentSnapshot({ version: 1, messages }));
  }
});

test('projection protocol permits empty, system-only and complete assistant-ended data', () => {
  for (const messages of [
    [],
    [{ role: 'system', content: 'Host' }],
    [turn[0], { role: 'assistant', content: 'End' }],
  ]) {
    assert.deepEqual(validateAgentSnapshot({ version: 1, messages }).messages, messages);
  }
});

test('projector type exposes live signal and step without requiring a model', async () => {
  const controller = new AbortController();
  const project: ContextProjector = async (messages, { signal, step }) => {
    assert.equal(signal, controller.signal);
    assert.equal(step, 1);
    return messages;
  };
  assert.deepEqual(await project(turn, { signal: controller.signal, step: 1 }), turn);
});
