import {
  Container,
  Editor,
  Markdown,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  matchesKey,
  truncateToWidth,
  type Component,
  type Terminal,
} from '@earendil-works/pi-tui';
import type { AgentEvent, RunResult } from '../core.ts';
import { safeText, type PanelKind, type SessionView } from './view.ts';
import { commandCompletion } from './commands.ts';
import { formatToolDetails } from './tool-details.ts';
import { deco, markdownTheme } from './theme.ts';

class Line implements Component {
  private value: () => string;
  constructor(value: () => string) {
    this.value = value;
  }
  invalidate() {}
  render(width: number) {
    return [truncateToWidth(this.value(), width, '')];
  }
}

class ToolSummary implements Component {
  result?: string;
  readonly id: string;
  readonly name: string;
  readonly args: string;
  private expanded: () => boolean;
  constructor(id: string, name: string, args: string, expanded: () => boolean) {
    this.id = id;
    this.name = name;
    this.args = args;
    this.expanded = expanded;
  }
  invalidate() {}
  render(width: number) {
    let target = '';
    try {
      const args = JSON.parse(this.args) as Record<string, unknown>;
      const value = args.path ?? args.file ?? args.query ?? args.command ?? args.id;
      if (typeof value === 'string') target = `  ${safeText(value)}`;
    } catch {
      /* Tool payload remains available in details. */
    }
    let error: string | undefined;
    if (this.result !== undefined) {
      try {
        const result: unknown = JSON.parse(this.result);
        if (result && typeof result === 'object') {
          if ('error' in result && result.error) error = safeText(result.error).replace(/\n/g, ' ');
          else if ('exitCode' in result && typeof result.exitCode === 'number' && result.exitCode !== 0)
            error = `exit ${result.exitCode}`;
          else if ('terminationReason' in result && result.terminationReason)
            error = safeText(result.terminationReason);
          else if (('ok' in result && result.ok === false) || ('isError' in result && result.isError === true))
            error = 'tool failed';
        }
      } catch {
        /* Non-JSON results remain neutral completed entries. */
      }
    }
    const label = `${error !== undefined ? '!' : this.result === undefined ? '◌' : '·'} ${this.name}${error !== undefined ? ` · ${error}` : ''}${target}`;
    const lines = [truncateToWidth((error !== undefined ? deco.red : deco.muted)(`  ${label}`), width, '…')];
    if (this.expanded()) {
      const detail = new Text(
        deco.muted(
          `Arguments:\n${formatToolDetails(this.args)}\nResult:\n${this.result === undefined ? 'running…' : formatToolDetails(this.result)}`,
        ),
        4,
        0,
      );
      lines.push(...detail.render(width));
    }
    return lines;
  }
}

export interface SessionActions {
  readonly busy: boolean;
  readonly closed: boolean;
  submit(text: string): Promise<unknown>;
  interrupt(): void;
}

/** Presentation adapter only. Execution and model configuration belong to the controller. */
export class PureAgentTUI implements SessionView {
  readonly tui: TuiAltScreen;
  readonly editor: Editor;
  private readonly transcript = new Container();
  private readonly tools = new Map<string, ToolSummary>();
  private controller?: SessionActions;
  private expanded = false;
  private status = 'ready';
  private streaming?: { step: number; text: string; block: Markdown };
  private resolveClosed?: () => void;
  private started = false;
  private pulse?: ReturnType<typeof setInterval>;
  private frame = 0;
  private readonly mode: string;
  private readonly signalHandler = () => this.interrupt();

  constructor(options: { terminal?: Terminal; modeLabel: string; note?: string; workspace?: string }) {
    this.mode = safeText(options.modeLabel);
    this.tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal(), true, undefined, { mouse: false });
    this.editor = new Editor(
      this.tui,
      {
        borderColor: deco.amber,
        selectList: {
          selectedPrefix: deco.amber,
          selectedText: deco.selected,
          description: deco.muted,
          scrollInfo: deco.muted,
          noMatch: deco.muted,
        },
      },
      { paddingX: 1, autocompleteMaxVisible: 4 },
    );
    this.editor.setAutocompleteProvider(commandCompletion);
    this.editor.onSubmit = (text) => {
      void this.submit(text);
    };
    const scroll = new ScrollView(this.transcript, { follow: 'end', primary: true, scrollbar: 'auto' });
    this.tui.setLayoutRoot(
      new VStack([
        {
          component: new Line(() =>
            deco.ink(
              ` ${deco.amber(deco.bold('PURE / AGENT'))}  ${deco.muted(this.mode.startsWith('REPLAY') ? 'REPLAY · recorded output · offline' : 'Developer edition · 001')}`,
            ),
          ),
          shrink: 0,
        },
        ...(options.workspace
          ? [
              {
                component: new Line(() => deco.muted(` Workspace: ${safeText(options.workspace)} · ${this.mode}`)),
                shrink: 0,
              },
            ]
          : []),
        { component: scroll, grow: 1, basis: 0, minSize: 1 },
        {
          component: new Line(() =>
            deco.muted(` ${this.controller?.busy ? ['◐', '◓', '◑', '◒'][this.frame % 4] : '·'} ${this.status}`),
          ),
          shrink: 0,
        },
        { component: this.editor, shrink: 0 },
        {
          component: new Line(() => deco.muted(` ${this.mode}  ·  Enter send · Shift+Enter / Ctrl+J newline`)),
          shrink: 0,
        },
        {
          component: new Line(() =>
            deco.muted(
              ` / commands · Ctrl+O tools ${this.expanded ? 'open' : 'closed'} · PgUp/Dn scroll · Esc cancel · Ctrl+C ${this.controller?.busy ? 'cancel' : 'exit'}`,
            ),
          ),
          shrink: 0,
        },
      ]),
    );
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+o')) {
        this.expanded = !this.expanded;
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+c')) {
        this.interrupt();
        return { consume: true };
      }
      if (matchesKey(data, 'escape') && this.controller?.busy) {
        this.interrupt();
        return { consume: true };
      }
      return undefined;
    });
    this.panel('STATUS', options.note ?? 'One session. Explicit tools. /help to begin.');
  }
  attach(controller: SessionActions) {
    this.controller = controller;
  }
  start() {
    if (this.started) return;
    this.started = true;
    process.on('SIGINT', this.signalHandler);
    this.tui.start();
    this.tui.terminal.setTitle('Pure Agent');
    this.pulse = setInterval(() => {
      if (this.controller?.busy) {
        this.frame++;
        this.tui.requestRender();
      }
    }, 180);
  }
  stop() {
    if (!this.started) return;
    this.started = false;
    clearInterval(this.pulse);
    process.off('SIGINT', this.signalHandler);
    this.tui.stop();
    this.tui.terminal.setTitle('Terminal');
    this.resolveClosed?.();
  }
  async run() {
    if (!this.controller) throw new Error('Attach a session controller before running the TUI');
    const closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.start();
    try {
      await closed;
    } finally {
      this.stop();
    }
  }
  private interrupt() {
    this.controller?.interrupt();
    if (this.controller?.closed) this.stop();
    this.tui.requestRender();
  }
  private async submit(text: string) {
    if (!this.controller || this.controller.busy || !text.trim()) return;
    this.editor.addToHistory(text);
    // Pi clears the submitted value itself. New typing during a run stays in the editor.
    this.editor.disableSubmit = true;
    try {
      await this.controller.submit(text);
    } catch (error) {
      this.panel('ERROR', error instanceof Error ? error.message : String(error));
    } finally {
      this.editor.disableSubmit = false;
      if (this.controller.closed) this.stop();
      else this.tui.requestRender();
    }
  }
  reset() {
    this.streaming = undefined;
    this.transcript.clear();
    this.tools.clear();
    this.tui.resetTextSelection();
    this.tui.scrollToBottom();
    this.status = 'ready · new session';
    this.tui.requestRender();
  }
  panel(kind: PanelKind, content: unknown) {
    const text = safeText(content);
    if (kind === 'STATUS' && text.startsWith('Cancellation requested')) this.status = text;
    else if (kind === 'AGENT') {
      this.transcript.addChild(new Text(deco.amber('  AGENT'), 0, 0));
      this.transcript.addChild(new Markdown(text, 2, 1, markdownTheme, { color: deco.ivory }, { renderLatex: false }));
    } else if (kind === 'USER') {
      this.tools.clear();
      this.transcript.addChild(new Text(`${deco.amber('YOU ›')} ${deco.ivory(text)}`, 1, 1));
    } else {
      this.transcript.addChild(new Text((kind === 'ERROR' ? deco.red : deco.muted)(text), 2, 1));
    }
    this.tui.requestRender();
  }
  event(event: AgentEvent) {
    if (event.type === 'model_start') this.status = `working · model step ${event.step} · Esc to cancel`;
    if (event.type === 'assistant_delta' && event.text) {
      if (!this.streaming || this.streaming.step !== event.step) {
        const block = new Markdown('', 2, 1, markdownTheme, { color: deco.ivory }, { renderLatex: false });
        this.transcript.addChild(new Text(deco.amber('  AGENT'), 0, 0));
        this.transcript.addChild(block);
        this.streaming = { step: event.step, text: '', block };
      }
      this.streaming.text += event.text;
      // Sanitize the accumulated text: control sequences may span delta boundaries.
      this.streaming.block.setText(safeText(this.streaming.text));
    }
    if (event.type === 'assistant') {
      if (this.streaming?.step === event.step) {
        this.streaming.block.setText(safeText(event.text));
        this.streaming = undefined;
      } else if (event.text) this.panel('AGENT', event.text);
    }
    if (event.type === 'tool_start') {
      const tool = new ToolSummary(
        event.id,
        safeText(event.name),
        safeText(JSON.stringify(event.args)),
        () => this.expanded,
      );
      this.tools.set(event.id, tool);
      this.transcript.addChild(tool);
      this.status = `running ${safeText(event.name)} · Esc to cancel`;
    }
    if (event.type === 'tool_end') {
      const tool = this.tools.get(event.id);
      if (tool) tool.result = safeText(event.result);
      else {
        const failed = new ToolSummary(event.id, safeText(event.name), '(unavailable)', () => this.expanded);
        failed.result = safeText(event.result);
        this.transcript.addChild(failed);
      }
    }
    this.tui.requestRender();
  }
  finish(result: RunResult) {
    if (this.streaming) {
      this.streaming.block.setText(`${safeText(this.streaming.text)}\n\n[Interrupted · partial output not saved]`);
      this.streaming = undefined;
    }
    this.status = `${result.status} · ${result.steps} model step${result.steps === 1 ? '' : 's'}`;
    if (result.error) this.panel('ERROR', result.error);
    this.tui.requestRender();
  }
}
