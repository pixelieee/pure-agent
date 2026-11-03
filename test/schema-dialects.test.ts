import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgent } from '../src/core.ts';
import { compileParameters } from '../src/schema.ts';

const drafts = [
  'http://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft/2019-09/schema',
  'https://json-schema.org/draft/2020-12/schema',
];
const tuple = {
  type: 'array',
  items: [{ type: 'integer' }, { type: 'string' }],
  minItems: 2,
  additionalItems: false,
};

test('omitted dialect retains draft-07 tuple semantics', () => {
  const validate = compileParameters(tuple);
  validate([1, 'one']);
  assert.throws(() => validate(['one', 1]), /Invalid tool arguments/);
  assert.throws(() => validate([1, 'one', 2]), /Invalid tool arguments/);
});

test('explicit draft-07 and 2019-09 retain their array items semantics', () => {
  for (const $schema of drafts.slice(0, 2)) {
    const validate = compileParameters({ $schema, ...tuple });
    validate([1, 'one']);
    assert.throws(() => validate([1, 2]), /Invalid tool arguments/);
  }
});

test('2020-12 validates prefixItems and closed tuples rather than silently ignoring them', () => {
  const validate = compileParameters({
    $schema: drafts[2],
    type: 'array',
    prefixItems: [{ type: 'integer' }, { type: 'string' }],
    minItems: 2,
    items: false,
  });
  validate([1, 'one']);
  for (const args of [[1], ['one', 1], [1, 'one', 2]]) assert.throws(() => validate(args), /Invalid tool arguments/);
  assert.throws(() => compileParameters({ $schema: drafts[2], ...tuple }));
});

for (const $schema of drafts.slice(1)) {
  test(`${$schema} enforces dependentRequired and unevaluatedProperties`, () => {
    const validate = compileParameters({
      $schema,
      type: 'object',
      properties: { name: { type: 'string' }, email: { type: 'string' } },
      dependentRequired: { name: ['email'] },
      unevaluatedProperties: false,
    });
    validate({ name: 'Ada', email: 'ada@example.com' });
    assert.throws(() => validate({ name: 'Ada' }), /Invalid tool arguments/);
    assert.throws(() => validate({ extra: true }), /Invalid tool arguments/);
  });
}

for (const $schema of drafts) {
  test(`${$schema} enforces standard formats and preserves strict rejection`, () => {
    for (const [format, good, bad] of [
      ['email', 'ada@example.com', 'not an email'],
      ['uri', 'https://example.com/document', 'not a uri'],
      ['date', '2024-02-29', '2023-02-29'],
      ['date-time', '2024-02-29T12:34:56Z', 'not a date-time'],
      ['uuid', '123e4567-e89b-12d3-a456-426614174000', 'not a uuid'],
      ['ipv4', '192.0.2.1', '999.0.0.1'],
    ]) {
      const validate = compileParameters({ $schema, type: 'string', format });
      validate(good);
      assert.throws(() => validate(bad), /Invalid tool arguments/);
    }
    assert.throws(() => compileParameters({ $schema, type: 'string', format: 'made-up-format' }), /unknown format/);
    assert.throws(() => compileParameters({ $schema, type: 'object', typo: true }), /unknown keyword/);
    assert.throws(() => compileParameters({ $schema, type: 'impossible' }));
    assert.throws(() => compileParameters({ $schema, $async: true, type: 'object' }), /synchronous/);
  });

  test(`${$schema} accepts standard type unions without accepting malformed types`, () => {
    const validate = compileParameters({
      $schema,
      type: 'object',
      properties: { value: { type: ['string', 'number'] } },
      required: ['value'],
    });
    validate({ value: 'text' });
    validate({ value: 42 });
    for (const value of [true, null, {}, []]) assert.throws(() => validate({ value }), /Invalid tool arguments/);
    assert.throws(() => compileParameters({ $schema, type: ['nonsense', 'string'] }));
    assert.throws(() => compileParameters({ $schema, type: ['string', 'number'], typo: true }), /unknown keyword/);
  });

  test(`${$schema} does not coerce, default, strip, or mutate arguments`, () => {
    const validate = compileParameters({
      $schema,
      type: 'object',
      properties: { count: { type: 'integer', default: 7 } },
      additionalProperties: false,
    });
    const missing = {};
    validate(missing);
    assert.deepEqual(missing, {});
    const invalid = { count: '7', extra: true };
    assert.throws(() => validate(invalid), /Invalid tool arguments/);
    assert.deepEqual(invalid, { count: '7', extra: true });
  });
}

test('supported dialect URI spelling is normalized without mutating its source', () => {
  for (const canonical of drafts) {
    const $schema = `${canonical.replace(/^http:/, 'https:').replace(/#$/, '')}#`;
    const source = { $schema, type: 'string' };
    compileParameters(source)('text');
    assert.equal(source.$schema, $schema);
  }
  for (const $schema of ['https://example.invalid/custom-schema', 'http://json-schema.org/draft-04/schema#', 42, null])
    assert.throws(() => compileParameters({ $schema, type: 'object' }), /Unsupported.*\$schema/);
});

test('local definitions, anchors, and bundled absolute refs resolve without a shared registry', () => {
  const source = {
    $schema: drafts[2],
    $id: 'https://example.invalid/tool',
    type: 'object',
    properties: { name: { $ref: 'name' } },
    $defs: { name: { $id: 'name', $anchor: 'name', type: 'string' } },
  };
  const validate = compileParameters(source);
  validate({ name: 'Ada' });
  assert.throws(() => validate({ name: 42 }), /Invalid tool arguments/);
  const different = compileParameters({ ...source, $defs: { name: { $id: 'name', type: 'integer' } } });
  different({ name: 42 });
  assert.throws(() => different({ name: 'Ada' }), /Invalid tool arguments/);
  assert.throws(
    () => compileParameters({ $schema: drafts[2], $ref: 'https://example.invalid/name' }),
    /Unresolved.*Bundle.*remote schema loading is disabled/,
  );
  const anchored = compileParameters({
    $schema: drafts[2],
    $ref: '#name',
    $defs: { name: { $anchor: 'name', type: 'string' } },
  });
  anchored('Ada');
  assert.throws(() => anchored(42), /Invalid tool arguments/);
});

test('unresolved local and remote refs fail with an actionable error', () => {
  for (const $schema of drafts)
    for (const $ref of ['#/$defs/missing', 'https://example.invalid/missing', 'file:///missing-schema.json'])
      assert.throws(
        () => compileParameters({ $schema, $ref }),
        /Unresolved.*Bundle referenced schemas in \$defs\/definitions; remote schema loading is disabled/,
      );
});

test('cached validators are detached from caller mutation and evicted without invalidating live validators', () => {
  const source = { type: 'integer', minimum: 1 };
  const first = compileParameters(source);
  assert.equal(compileParameters({ ...source }), first);
  source.minimum = 5;
  const changed = compileParameters(source);
  assert.notEqual(changed, first);
  first(2);
  assert.throws(() => changed(2), /Invalid tool arguments/);
  for (let minimum = 100; minimum < 140; minimum++) compileParameters({ type: 'integer', minimum });
  const fresh = compileParameters({ type: 'integer', minimum: 1 });
  assert.notEqual(fresh, first);
  first(2);
  assert.throws(() => first(0), /Invalid tool arguments/);
});

test('oversized, excessively deep, cyclic, and non-JSON schemas fail before compilation', () => {
  assert.throws(() => compileParameters({ description: 'x'.repeat(256 * 1024) }), /exceeds.*bytes/);
  assert.throws(() => compileParameters({ enum: Array.from({ length: 10_001 }, (_, i) => i) }), /exceeds.*nodes/);
  let deep: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < 65; i++) deep = { type: 'array', items: deep };
  assert.throws(() => compileParameters(deep), /exceeds depth/);
  const cycle: Record<string, unknown> = {};
  cycle.properties = { loop: cycle };
  assert.throws(() => compileParameters(cycle), /cyclic objects/);
  for (const value of [undefined, () => null, Infinity, 1n, new Date()])
    assert.throws(() => compileParameters({ default: value }), /JSON/);
  let reads = 0;
  const accessor = Object.defineProperty({}, 'type', {
    enumerable: true,
    get() {
      reads++;
      return 'object';
    },
  });
  assert.throws(() => compileParameters(accessor), /accessor/);
  assert.equal(reads, 0);
});

test('core mandatory validation blocks invalid 2020-12 formatted arguments even when domain validator approves', async () => {
  let step = 0;
  let executions = 0;
  const agent = createAgent({
    tools: [
      {
        name: 'contact',
        description: 'Validate contact input',
        parameters: {
          $schema: drafts[2],
          type: 'object',
          properties: { email: { type: 'string', format: 'email' } },
          required: ['email'],
          additionalProperties: false,
        },
        validate: () => true,
        execute: async () => ++executions,
      },
    ],
    model: {
      complete: async () =>
        step++ === 0
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'a', type: 'function', function: { name: 'contact', arguments: '{"email":"bad"}' } }],
            }
          : { role: 'assistant', content: 'Done' },
    },
  });
  assert.equal((await agent.run('Go')).status, 'completed');
  assert.equal(executions, 0);
  assert.match(agent.messages.find((message) => message.role === 'tool')?.content ?? '', /Invalid tool arguments/);
});
