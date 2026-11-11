import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { createAgent, RunResult, AgentSnapshot } from '../core.ts';
import type { SessionView, Output } from './view.ts';

type Agent = ReturnType<typeof createAgent>;
export interface SessionRuntime {
  agent: Agent;
  dispose?: () => void | Promise<void>;
}
export interface SessionPersistence {
  save(agent: Agent, path?: string, result?: RunResult): Promise<string | undefined>;
  load(path: string): Promise<{ snapshot: AgentSnapshot; activate?: () => void }>;
  reset(): void;
}
export interface SessionOptions {
  defaultSystem: string;
  modeLabel?: string;
  helpNote?: string;
  configurationNote?: string;
  initialSession?: SessionRuntime;
  persistence?: SessionPersistence;
  /** Host-owned selection of saved instructions; cannot alter tool or permission configuration. */
  resolveSavedInstructions?: (snapshot: AgentSnapshot) => string;
}
type SessionFactory = (system: string) => Agent | SessionRuntime;
const runtime = (value: Agent | SessionRuntime): SessionRuntime => ('agent' in value ? value : { agent: value });
const noSessionFile = new Error('No session file selected. Use /save <file>.');
const operationFailure = {
  save: 'Session save failed. History remains available in this session.',
  restore: 'Session restore failed. Check the selected file and try again.',
  reset: 'Session reset failed. Check the session and try again.',
} as const;
const operationStatus = {
  save: ['saving session · please wait', 'ready · session saved', 'save failed · retry /save'],
  restore: ['restoring session · please wait', 'ready · restored session', 'restore failed · check error'],
  reset: ['resetting session · please wait', 'ready · new session', 'session reset failed · check error'],
} as const;

/** Owns the current runtime, including process cleanup and idle-only persistence. */
export class SessionController {
  private session: SessionRuntime;
  private factory: SessionFactory;
  private view: SessionView;
  private abort?: AbortController;
  private operating = false;
  private options: SessionOptions;
  private disposed = false;
  closed = false;
  exitCode = 0;
  constructor(factory: SessionFactory, view: SessionView, options: SessionOptions = { defaultSystem: '' }) {
    this.factory = factory;
    this.view = view;
    this.options = { ...options };
    this.session = options.initialSession ?? runtime(factory(options.defaultSystem));
  }
  /** Render only persisted conversation data, never replaying model or tool calls. */
  showHistory(snapshot: AgentSnapshot, path: string) {
    this.view.panel('STATUS', `Saved conversation from ${path}:`);
    const pending = new Map<string, { name: string; args: string }>();
    for (const message of snapshot.messages) {
      if (message.role === 'user') this.view.panel('USER', message.content);
      if (message.role === 'assistant') {
        if (message.content) this.view.panel('AGENT', message.content);
        for (const call of message.tool_calls ?? [])
          pending.set(call.id, { name: call.function.name, args: call.function.arguments });
      }
      if (message.role === 'tool' && message.tool_call_id) {
        const call = pending.get(message.tool_call_id);
        if (call) {
          if (this.view.historyTool) this.view.historyTool(call.name, call.args, message.content ?? '');
          else
            this.view.panel(
              'TOOL',
              `Recorded: ${call.name}\nArguments (raw): ${call.args}\nResult: ${message.content ?? ''}`,
            );
          pending.delete(message.tool_call_id);
        }
      }
    }
    this.view.panel(
      'STATUS',
      `Session resumed: ${path}. Current workspace, tools and permissions apply. Previous tools were not rerun. Only saved conversation is shown; earlier run status and unsaved output may be unavailable.`,
    );
  }
  get busy() {
    return !!this.abort || this.operating;
  }
  get cancellable() {
    return !!this.abort && !this.operating;
  }
  interrupt() {
    if (this.operating) {
      this.view.panel('STATUS', 'Waiting for the session operation to finish.');
    } else if (this.abort) {
      this.abort.abort();
      this.view.panel('STATUS', 'Cancellation requested. Waiting for the current operation to stop.');
    } else this.closed = true;
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.closed = true;
    this.abort?.abort();
    await this.session.dispose?.();
  }
  private async replace(next: SessionRuntime) {
    try {
      await this.session.dispose?.();
    } catch (error) {
      await next.dispose?.();
      throw error;
    }
    this.session = next;
    this.view.reset?.();
  }
  private async command(operation: keyof typeof operationStatus, action: () => Promise<void>) {
    this.operating = true;
    const [active, completed, failed] = operationStatus[operation];
    let status: string = completed;
    try {
      this.view.setStatus?.(active);
      await action();
    } catch (error) {
      status = failed;
      this.exitCode = 1;
      this.view.panel('ERROR', error === noSessionFile ? noSessionFile.message : operationFailure[operation]);
    } finally {
      this.operating = false;
      this.view.setStatus?.(status);
    }
  }
  async submit(raw: string) {
    if (this.closed) return;
    const input = raw.trim();
    if (!input) return;
    if (this.busy) {
      this.view.panel(
        'ERROR',
        this.cancellable
          ? 'A run is already active. Cancel it before submitting another input or command.'
          : 'A session operation is active. Wait for it to finish before submitting another input or command.',
      );
      return;
    }
    if (input === '/quit' || input === '/exit') {
      await this.dispose();
      return;
    }
    if (input === '/help') {
      this.view.panel(
        'STATUS',
        '/create <description>  Set system instructions; start a fresh session\n/new                   Reset session and default instructions\n/save [file]           Save history to an explicit private file\n/resume <file>         Load history with current tools and permissions\n/help                  Show commands\n/quit                  Exit' +
          (this.options.helpNote ? `\n${this.options.helpNote}` : ''),
      );
      return;
    }
    if (input === '/new' || input === '/create' || input.startsWith('/create ')) {
      const system = input === '/new' ? this.options.defaultSystem : input.slice(7).trim();
      if (input !== '/new' && !system) {
        this.view.panel('ERROR', 'Usage: /create <plain-language agent instructions>');
        return;
      }
      await this.command('reset', async () => {
        await this.replace(runtime(this.factory(system)));
        this.options.persistence?.reset();
        this.view.panel(
          'STATUS',
          input === '/new'
            ? 'New session. History cleared; default instructions restored. Previous session files are unchanged.'
            : `Agent configured; history cleared.\nSystem instruction: ${system}\nThis sets configuration, not a generated workflow.${this.options.configurationNote ? `\n${this.options.configurationNote}` : ''}`,
        );
      });
      return;
    }
    if (input === '/save' || input.startsWith('/save ') || input === '/resume' || input.startsWith('/resume ')) {
      const storage = this.options.persistence;
      if (!storage) {
        this.view.panel('ERROR', 'Session persistence is available in live mode.');
        return;
      }
      const save = input === '/save' || input.startsWith('/save ');
      const path = input.slice(save ? 5 : 7).trim();
      if (!save && !path) {
        this.view.panel('ERROR', 'Usage: /resume <session file>');
        return;
      }
      await this.command(save ? 'save' : 'restore', async () => {
        if (save) {
          const saved = await storage.save(this.session.agent, path || undefined);
          if (!saved) throw noSessionFile;
          this.view.panel(
            'STATUS',
            `Session saved: ${saved}. Contains conversation and project content; keep it private.`,
          );
        } else {
          const loaded = await storage.load(path);
          const system = this.options.resolveSavedInstructions?.(loaded.snapshot) ?? this.options.defaultSystem;
          const candidate = runtime(this.factory(system));
          try {
            candidate.agent.restore(loaded.snapshot);
          } catch (error) {
            await candidate.dispose?.();
            throw error;
          }
          await this.replace(candidate);
          loaded.activate?.();
          this.showHistory(loaded.snapshot, path);
        }
      });
      return;
    }
    if (input.startsWith('/')) {
      this.view.panel('ERROR', 'Unknown command. Try /help.');
      return;
    }
    this.abort = new AbortController();
    this.view.panel('USER', input);
    try {
      const result = await this.session.agent.run(input, {
        signal: this.abort.signal,
        onEvent: (event) => this.view.event(event, this.options.modeLabel),
      });
      this.exitCode = result.status === 'cancelled' ? 130 : result.status === 'completed' ? 0 : 1;
      this.view.finish(result);
      // The done observer may run before core clears its busy flag. Save only after run resolves.
      const storage = this.options.persistence;
      if (storage) {
        this.operating = true;
        const outcome = `${result.status} · ${result.steps} model step${result.steps === 1 ? '' : 's'}`;
        let status = outcome;
        try {
          this.view.setStatus?.(`${outcome} · saving session`);
          const saved = await storage.save(this.session.agent, undefined, result);
          if (saved) status = `${outcome} · saved`;
        } catch {
          status = `${outcome} · save failed`;
          this.exitCode = 1;
          this.view.panel('ERROR', operationFailure.save);
        } finally {
          this.operating = false;
          this.view.setStatus?.(status);
        }
      }
      return result;
    } catch {
      this.exitCode = 1;
      const message = 'Run failed. Inspect the current session and any tool effects before retrying.';
      if (this.view.runError) this.view.runError(message);
      else {
        this.view.setStatus?.('run failed · check error');
        this.view.panel('ERROR', message);
      }
      return;
    } finally {
      this.abort = undefined;
    }
  }
}

/** Serializes piped/typed input while allowing SIGINT to cancel an active operation. */
export async function interactive(controller: SessionController, input: Readable, output: Output) {
  const terminal = !!(input as Readable & { isTTY?: boolean }).isTTY && !!output.isTTY;
  const rl = createInterface({ input, ...(terminal ? { output: output as NodeJS.WritableStream } : {}), terminal });
  rl.setPrompt('YOU › ');
  let queue = Promise.resolve();
  let ended = false;
  const interrupt = () => {
    controller.interrupt();
    if (controller.closed) rl.close();
  };
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
    rl.once('close', () => {
      ended = true;
      resolve();
    });
  });
  if (terminal) rl.prompt();
  try {
    await done;
    await queue;
  } finally {
    process.off('SIGINT', interrupt);
    rl.close();
    await controller.dispose();
  }
}
