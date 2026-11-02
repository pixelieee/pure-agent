import test from 'node:test';
import assert from 'node:assert/strict';
import { compileParameters } from '../src/schema.ts';
import { createAgent } from '../src/core.ts';
import type { Tool } from '../src/core.ts';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['profile'],
  properties: { profile: { $ref: '#/definitions/profile' } },
  definitions: {
    profile: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'tier', 'age'],
      properties: {
        name: { type: 'string', minLength: 1 },
        tier: { type: 'string', enum: ['free', 'pro'] },
        age: { type: 'integer', minimum: 18, maximum: 120 },
        tags: { type: 'array', maxItems: 2, items: { type: 'string' } },
      },
    },
  },
};
const valid = { profile: { name: 'Ada', tier: 'pro', age: 30 } };

test('draft07 local refs and nested schema validate valid inputs', () => {
  assert.doesNotThrow(() => compileParameters(schema)(valid));
});

for (const [name, input] of [
  ['nested required', { profile: { name: 'Ada', tier: 'pro' } }],
  ['root required', {}],
  ['nested extras', { profile: { ...valid.profile, extra: 1 } }],
  ['root extras', { ...valid, extra: 1 }],
  ['enum', { profile: { ...valid.profile, tier: 'other' } }],
  ['minimum', { profile: { ...valid.profile, age: 17 } }],
  ['maximum', { profile: { ...valid.profile, age: 121 } }],
  ['integer', { profile: { ...valid.profile, age: 30.5 } }],
  ['string bounds', { profile: { ...valid.profile, name: '' } }],
  ['array bounds', { profile: { ...valid.profile, tags: ['a', 'b', 'c'] } }],
  ['array item type', { profile: { ...valid.profile, tags: [1] } }],
])
  test(`rejects ${name}`, () => {
    assert.throws(() => compileParameters(schema)(input), /Invalid tool arguments/);
  });

test('never coerces values, strips extras, or inserts defaults', () => {
  const validate = compileParameters({
    type: 'object',
    additionalProperties: false,
    properties: { count: { type: 'number', default: 1 } },
  });
  const missing = {};
  validate(missing);
  assert.deepEqual(missing, {});
  const stringNumber = { count: '2' };
  assert.throws(() => validate(stringNumber));
  assert.deepEqual(stringNumber, { count: '2' });
  const extra = { extra: true };
  assert.throws(() => validate(extra));
  assert.deepEqual(extra, { extra: true });
});

test('invalid schemas, unknown keywords, async and unresolved remote refs fail early', () => {
  for (const parameters of [
    undefined,
    null,
    [],
    { type: 'not-a-type' },
    { typo: true },
    { $async: true, type: 'object' },
    { $ref: 'https://example.invalid/schema' },
    { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
  ]) {
    assert.throws(() =>
      createAgent({
        model: { complete: async () => ({ role: 'assistant', content: 'unused' }) },
        tools: [{ name: 'test', description: 'Test', parameters, execute: async () => null } as unknown as Tool],
      }),
    );
  }
});

test('schema enforcement cannot be bypassed by an absent or approving domain validator', async () => {
  for (const validate of [undefined, () => true]) {
    let writes = 0;
    let step = 0;
    const events: string[] = [];
    const agent = createAgent({
      tools: [{ name: 'test', description: 'Test', parameters: schema, validate, execute: async () => ++writes }],
      model: {
        complete: async () =>
          step++ === 0
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'a', type: 'function', function: { name: 'test', arguments: '{}' } }],
              }
            : { role: 'assistant', content: 'Done' },
      },
    });
    assert.equal(
      (
        await agent.run('Go', {
          onEvent: (event) => {
            events.push(event.type);
          },
        })
      ).status,
      'completed',
    );
    assert.equal(writes, 0);
    assert.equal(events.includes('tool_start'), false);
    const message = agent.messages.find((message) => message.role === 'tool');
    assert.ok(message);
    assert.ok(message.content !== null);
    assert.match(message.content, /Invalid tool arguments/);
  }
});

test('domain validator cannot mutate schema-validated execution arguments', async () => {
  let step = 0;
  const agent = createAgent({
    tools: [
      {
        name: 'test',
        description: 'Test',
        parameters: schema,
        validate: (args) => {
          (args as typeof valid).profile.age = -1;
          return true;
        },
        execute: async (args) => {
          assert.equal(args.profile.age, 30);
          return args;
        },
      },
    ],
    model: {
      complete: async () =>
        step++ === 0
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'a', type: 'function', function: { name: 'test', arguments: JSON.stringify(valid) } }],
            }
          : { role: 'assistant', content: 'Done' },
    },
  });
  assert.equal((await agent.run('Go')).status, 'completed');
  const message = agent.messages.find((message) => message.role === 'tool');
  assert.ok(message);
  assert.ok(message.content !== null);
  assert.equal(JSON.parse(message.content).profile.age, 30);
});
