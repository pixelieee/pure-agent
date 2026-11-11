import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAgentSnapshot } from '../src/core.ts';

// Persistence fixtures only. This file creates no agent, model, response, or network request.
function storedHistory(data: unknown) {
  const stored = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'stored-1', type: 'function', function: { name: 'stored_tool', arguments: '{}' } }],
    providerData: { kind: 'snapshot-test', data },
  };
  return {
    stored,
    snapshot: {
      version: 1,
      messages: [
        { role: 'user', content: 'Stored request' },
        stored,
        { role: 'tool', tool_call_id: 'stored-1', content: '{"stored":true}' },
      ],
    },
  };
}

const cycle: Record<string, unknown> = {};
cycle.self = cycle;
const invalidValues: [string, unknown][] = [
  ['undefined', undefined],
  ['bigint', 1n],
  ['function', () => null],
  ['symbol', Symbol('value')],
  ['NaN', NaN],
  ['infinity', Infinity],
  ['negative zero', -0],
  ['date', new Date(0)],
  ['map', new Map()],
  ['cycle', cycle],
  ['sparse array', new Array(1)],
  ['array with extra property', Object.assign([1], { extra: true })],
];

for (const [name, data] of invalidValues) {
  test(`snapshot validation rejects ${name} in retained data`, () => {
    const { snapshot } = storedHistory(data);
    assert.throws(() => validateAgentSnapshot(snapshot), /Invalid snapshot JSON/);
  });
}

for (const targetName of ['continuation data', 'provider envelope', 'tool call', 'tool function'] as const) {
  for (const defect of ['symbol key', 'non-enumerable field', 'custom prototype'] as const) {
    test(`snapshot validation rejects ${targetName} with ${defect}`, () => {
      const { snapshot, stored } = storedHistory({ stable: 1 });
      const target =
        targetName === 'continuation data'
          ? stored.providerData.data
          : targetName === 'provider envelope'
            ? stored.providerData
            : targetName === 'tool call'
              ? stored.tool_calls[0]
              : stored.tool_calls[0].function;
      assert.ok(target && typeof target === 'object');
      if (defect === 'symbol key') Object.defineProperty(target, Symbol('hidden'), { value: 1, enumerable: true });
      else if (defect === 'non-enumerable field') Object.defineProperty(target, 'hidden', { value: 1 });
      else Object.setPrototypeOf(target, { inherited: true });
      assert.throws(() => validateAgentSnapshot(snapshot), /Invalid snapshot JSON/);
    });
  }
}

for (const field of ['content', 'providerData', 'data', 'stable', 'arguments'] as const) {
  test(`snapshot validation rejects retained ${field} accessor without evaluating it`, () => {
    const { snapshot, stored } = storedHistory({ stable: 1 });
    const target =
      field === 'data'
        ? stored.providerData
        : field === 'stable'
          ? stored.providerData.data
          : field === 'arguments'
            ? stored.tool_calls[0].function
            : stored;
    assert.ok(target && typeof target === 'object');
    let reads = 0;
    Object.defineProperty(target, field, {
      enumerable: true,
      get() {
        reads++;
        return 'unexpected getter evaluation';
      },
    });
    assert.throws(() => validateAgentSnapshot(snapshot), /Invalid snapshot JSON property/);
    assert.equal(reads, 0);
  });
}

test('valid retained snapshot data is detached and JSON round-trips without loss', () => {
  const { snapshot, stored } = storedHistory({ items: [null, true, false, 0, 1.5, 'stored', { nested: ['value'] }] });
  const accepted = validateAgentSnapshot(snapshot);
  assert.deepEqual(accepted, snapshot);
  assert.notStrictEqual(accepted, snapshot);
  assert.notStrictEqual(accepted.messages[1].providerData, stored.providerData);
  assert.deepEqual(validateAgentSnapshot(JSON.parse(JSON.stringify(accepted))), accepted);
  stored.providerData.data = { changed: true };
  stored.tool_calls[0].function.name = 'changed';
  assert.notDeepEqual(accepted.messages[1].providerData, stored.providerData);
  assert.equal(accepted.messages[1].tool_calls?.[0].function.name, 'stored_tool');
});
