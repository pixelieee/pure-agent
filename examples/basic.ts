import { createAgent } from '../src/index.ts';
import type { Model, Tool } from '../src/index.ts';

// Fully offline example. Replace only `model` to connect a real provider.
const sum: Tool = {
  name: 'sum',
  description: 'Add two finite numbers.',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
    additionalProperties: false,
  },
  validate: (value: unknown) => {
    const args = value as { a?: number; b?: number };
    return Number.isFinite(args.a) && Number.isFinite(args.b);
  },
  execute: async ({ a, b }) => ({ sum: a + b }),
};
const model: Model = {
  async complete(messages) {
    const last = messages.at(-1);
    if (!last) throw new Error('Expected a conversation message');
    if (last.role === 'tool') {
      if (last.content === null) throw new Error('Expected tool result content');
      return { role: 'assistant', content: `The result is ${JSON.parse(last.content).sum}.` };
    }
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'sum-1', type: 'function', function: { name: 'sum', arguments: '{"a":2,"b":3}' } }],
    };
  },
};
const agent = createAgent({ model, tools: [sum], system: 'Use only the supplied tools.' });
const result = await agent.run('What is 2 + 3?');
console.log(result);
