import { createAgent } from './core.ts';
import type { Model, Tool } from './core.ts';

/** This deterministic fixture exercises the real loop; it is NOT an AI model. */
export const noteTool: Tool = {
  name: 'format_note',
  description: 'Format a supplied string into a short note, without external side effects.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  validate: (args) => !!args && typeof args === 'object' && !Array.isArray(args)
    && Object.keys(args).length === 1 && typeof (args as { text?: unknown }).text === 'string',
  async execute({ text }: { text: string }, { signal }) {
    signal.throwIfAborted();
    return { note: text.trim().replace(/\s+/gu, ' '), characters: [...text.trim()].length };
  },
};

export function createDemoModel(): Model {
  let sequence = 0;
  return {
    async complete(messages, _tools, signal) {
      signal.throwIfAborted();
      const last = messages.at(-1);
      if (last?.role === 'tool') {
        return { role: 'assistant', content: `DEMO · Tool returned ${last.content}\nThis is a scripted fixture, not model reasoning.` };
      }
      const text = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      return {
        role: 'assistant', content: 'DEMO · Calling the note formatter through the agent loop.',
        tool_calls: [{ id: `demo-${++sequence}`, type: 'function', function: { name: 'format_note', arguments: JSON.stringify({ text }) } }],
      };
    },
  };
}

export const DEFAULT_SYSTEM = 'You are a concise, helpful assistant.';
export function createDemoAgent(system = DEFAULT_SYSTEM) {
  return createAgent({ system, model: createDemoModel(), tools: [noteTool], maxSteps: 4 });
}
