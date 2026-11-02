import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { createAgent } from '../core.ts';
import type { SessionView } from './view.ts';
import type { Output } from './view.ts';

type Agent = ReturnType<typeof createAgent>;
export interface SessionOptions {
  defaultSystem: string;
  modeLabel?: string;
  helpNote?: string;
  configurationNote?: string;
}
export class SessionController {
  private agent: Agent;
  private factory: (system: string) => Agent;
  private view: SessionView;
  private abort?: AbortController;
  private options: SessionOptions;
  closed = false;
  constructor(factory: (system: string) => Agent, view: SessionView, options: SessionOptions = { defaultSystem: '' }) {
    this.factory = factory; this.view = view; this.options = { ...options };
    this.agent = factory(options.defaultSystem);
  }
  get busy() { return !!this.abort; }
  interrupt() {
    if (this.abort) { this.abort.abort(); this.view.panel('STATUS', 'Cancellation requested. Waiting for the current operation to stop.'); }
    else this.closed = true;
  }
  async submit(raw: string) {
    if (this.closed) return;
    const input = raw.trim();
    if (!input) return;
    if (this.busy) { this.view.panel('ERROR', 'A run is already active. Cancel it before submitting another input or command.'); return; }
    if (input === '/quit' || input === '/exit') { this.closed = true; return; }
    if (input === '/help') {
      this.view.panel('STATUS', '/create <description>  Set system instructions; start a fresh session\n/new                   Reset session and default instructions\n/help                  Show commands\n/quit                  Exit' + (this.options.helpNote ? `\n${this.options.helpNote}` : ''));
      return;
    }
    if (input === '/new') {
      this.agent = this.factory(this.options.defaultSystem);
      this.view.reset?.();
      this.view.panel('STATUS', 'New session. History cleared; default instructions restored.'); return;
    }
    if (input === '/create' || input.startsWith('/create ')) {
      const system = input.slice(7).trim();
      if (!system) { this.view.panel('ERROR', 'Usage: /create <plain-language agent instructions>'); return; }
      this.agent = this.factory(system);
      this.view.reset?.();
      this.view.panel('STATUS', `Agent configured; history cleared.\nSystem instruction: ${system}\nThis sets configuration, not a generated workflow.${this.options.configurationNote ? `\n${this.options.configurationNote}` : ''}`); return;
    }
    if (input.startsWith('/')) { this.view.panel('ERROR', 'Unknown command. Try /help.'); return; }
    this.abort = new AbortController();
    this.view.panel('USER', input);
    try {
      const result = await this.agent.run(input, {
        signal: this.abort.signal,
        onEvent: (event) => this.view.event(event, this.options.modeLabel),
      });
      this.view.finish(result);
      return result;
    } catch (error) {
      this.view.panel('ERROR', error instanceof Error ? error.message : String(error));
      return;
    } finally { this.abort = undefined; }
  }
}

/** Serializes piped/typed input while allowing SIGINT to cancel an active operation. */
export async function interactive(controller: SessionController, input: Readable, output: Output) {
  const terminal = !!(input as Readable & { isTTY?: boolean }).isTTY && !!output.isTTY;
  const rl = createInterface({ input, ...(terminal ? { output: output as NodeJS.WritableStream } : {}), terminal });
  rl.setPrompt('YOU › ');
  let queue = Promise.resolve();
  let ended = false;
  const interrupt = () => { controller.interrupt(); if (controller.closed) rl.close(); };
  rl.on('SIGINT', interrupt);
  process.on('SIGINT', interrupt);
  const done = new Promise<void>((resolve) => {
    rl.on('line', (line) => {
      queue = queue.then(async () => {
        await controller.submit(line);
        if (controller.closed) rl.close();
        else if (terminal && !ended) rl.prompt();
      });
    });
    rl.once('close', () => { ended = true; resolve(); });
  });
  if (terminal) rl.prompt();
  try { await done; await queue; }
  finally { process.off('SIGINT', interrupt); rl.close(); }
}
