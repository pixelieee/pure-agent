#!/usr/bin/env node
/** Offline visual inspection of a recorded run. Never constructs a provider or reads credentials. */
import { readFile } from 'node:fs/promises';
import { createAgent, type Message, type RunResult } from '../core.ts';
import { SessionController } from './controller.ts';
import { PureAgentTUI } from './tui.ts';

const path = process.argv[2];
if (!path) throw new Error('Usage: node src/ui/replay.ts <recorded-trace.json>');
const trace = JSON.parse(await readFile(path, 'utf8')) as {
  model: string;
  ranAt: string;
  messages: Message[];
  rounds: { result: RunResult }[];
};
if (!Array.isArray(trace.messages) || !Array.isArray(trace.rounds))
  throw new Error('Expected recorded messages and rounds');
const ui = new PureAgentTUI({
  modeLabel: `REPLAY · ${trace.model} · offline`,
  note: `RECORDED RUN · ${trace.ranAt}\nHistorical output, not a new model call. Ctrl+O expands tool evidence; PgUp/Dn scrolls.`,
});
const controller = new SessionController(
  () =>
    createAgent({
      model: {
        complete: async () => ({
          role: 'assistant',
          content:
            'This is a **read-only historical replay**, not a live model. Run `npm run demo` for the scripted interactive fixture, or the explicitly authorized live CLI separately.',
        }),
      },
    }),
  ui,
  {
    defaultSystem: '',
    modeLabel: 'REPLAY · offline',
    helpNote: 'Historical trace only. No API requests. Input returns a replay notice.',
  },
);
ui.attach(controller);
let step = 0;
for (const message of trace.messages) {
  if (message.role === 'user') {
    ui.panel('USER', message.content ?? '');
    step = 0;
  }
  if (message.role === 'assistant') {
    step++;
    if (message.content) ui.event({ type: 'assistant', text: message.content, step });
    for (const call of message.tool_calls ?? []) {
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        args = call.function.arguments;
      }
      ui.event({ type: 'tool_start', id: call.id, name: call.function.name, args });
    }
  }
  if (message.role === 'tool')
    ui.event({
      type: 'tool_end',
      id: message.tool_call_id ?? '',
      name: 'recorded tool',
      result: message.content ?? '',
    });
}
const last = trace.rounds.at(-1)?.result;
if (last) ui.finish(last);
await ui.run();
