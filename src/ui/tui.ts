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
  visibleWidth,
  type Component,
  type Terminal,
} from '@earendil-works/pi-tui';
import type { AgentEvent, RunResult } from '../core.ts';
import { safeText, type PanelKind, type SessionView } from './view.ts';
import { commandCompletion } from './commands.ts';
import { formatToolDetails } from './tool-details.ts';
import { commandOutput, renderCommandOutput } from './command-output.ts';
import { deco, markdownTheme } from './theme.ts';

class Line implements Component {
  private value: (width: number) => string;
  constructor(value: (width: number) => string) {
    this.value = value;
  }
  invalidate() {}
  render(width: number) {
    return [truncateToWidth(this.value(width), width, '')];
  }
}

/** Keep the same transcript block and bounded line offset while history reflows. */
class Transcript extends Container {
  scroll?: ScrollView;
  private previous: { component: Component; start: number; height: number }[] = [];
  override clear() {
    super.clear();
    this.previous = [];
  }
  override render(width: number): string[] {
    const scroll = this.scroll;
    const top = scroll?.scrollTop ?? 0;
    const anchor = this.previous.find((item) => top >= item.start && top < item.start + item.height);
    const lines: string[] = [];
    const next = this.children.map((component) => {
      const rendered = component.render(width);
      const item = { component, start: lines.length, height: rendered.length };
      lines.push(...rendered);
      return item;
    });
    if (scroll && !scroll.isFollowingEnd && anchor) {
      const target = next.find((item) => item.component === anchor.component);
      if (target) {
        // Update bounds before seeking: expanded content may exceed the old height.
        scroll.updateLayout(lines.length, scroll.viewportHeight, () => {});
        scroll.scrollTo(target.start + Math.min(top - anchor.start, Math.max(0, target.height - 1)), {
          disableFollow: true,
        });
      }
    }
    this.previous = next;
    return lines;
  }
}

/** Preserve Pi's cursor, editing and overflow indicators; simplify only chrome. */
class MinimalEditor extends Editor {
  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    return hiddenLineCount ? super.renderBottomBorder(width, hiddenLineCount) : ' '.repeat(width);
  }
  override render(width: number): string[] {
    const lines = super.render(width);
    // Replace padding only, without moving the editor's text or cursor.
    if (width >= 3 && lines.length > 1 && lines[1].startsWith(' ')) {
      lines[1] = deco.purple('›') + lines[1].slice(1);
    }
    return lines;
  }
}

function controls(width: number, busy: boolean, cancellable: boolean): string {
  if (busy) {
    const variants = cancellable
      ? [
          ' Draft only  Ctrl+J newline  Ctrl+O details  PgUp/Dn scroll  Esc/Ctrl+C cancel',
          ' Draft only  Ctrl+O details  Esc/Ctrl+C cancel',
          ' Draft only  Ctrl+C cancel',
          ' Ctrl+C cancel',
          ' Esc cancel',
        ]
      : [
          ' Session operation in progress  Draft editing available  Please wait',
          ' Session operation in progress  Please wait',
          ' Please wait',
        ];
    return variants.find((line) => visibleWidth(line) <= width) ?? '';
  }
  const exit = busy ? 'cancel' : 'exit';
  const variants = [
    ` Enter send  Shift+Enter/Ctrl+J newline  / commands  Ctrl+O details  PgUp/Dn scroll  Ctrl+C ${exit}`,
    ` Enter send  Ctrl+J newline  / commands  Ctrl+O details  Ctrl+C ${exit}`,
    ` Enter send  /help  Ctrl+C ${exit}`,
    ` /help  Ctrl+C ${exit}`,
    ' /help',
  ];
  return variants.find((line) => visibleWidth(line) <= width) ?? '';
}

class ToolSummary implements Component {
  result?: string;
  readonly id: string;
  readonly name: string;
  readonly args: string;
  private expanded: () => boolean;
  private recorded: boolean;
  constructor(id: string, name: string, args: string, expanded: () => boolean, recorded = false) {
    this.id = id;
    this.name = name;
    this.args = args;
    this.expanded = expanded;
    this.recorded = recorded;
  }
  invalidate() {}
  render(width: number) {
    let target = '';
    try {
      const args = JSON.parse(this.args) as Record<string, unknown>;
      const value = args.path ?? args.file ?? args.query ?? args.command ?? args.id;
      if (typeof value === 'string') target = `  ${safeText(value).replace(/\n/g, ' ')}`;
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
    const command = commandOutput(this.name, this.result);
    if (!error && command && ['failed', 'terminated'].includes(command.status)) error = command.status;
    const state =
      error !== undefined
        ? `! ${this.recorded ? 'recorded: ' : ''}${error}`
        : this.recorded
          ? 'recorded'
          : this.result === undefined
            ? 'running'
            : command?.status === 'running'
              ? 'running'
              : 'done';
    // Reserve room for the state rather than letting long paths hide it.
    const shortState = truncateToWidth(state.replace(/\n/g, ' '), Math.max(1, Math.floor(width / 2)), '…');
    const subjectWidth = Math.max(0, width - visibleWidth(shortState) - 3);
    const subject = truncateToWidth(`  ${deco.bold(this.name.replace(/\n/g, ' '))}${target}`, subjectWidth, '…');
    const label = `${subject} · ${error !== undefined ? deco.red(shortState) : shortState}`;
    const lines = [truncateToWidth(label, width, '…')];
    if (command) lines.push(...renderCommandOutput(command, width, this.expanded()));
    if (this.expanded()) {
      const detail = new Text(
        deco.muted(
          `Arguments:\n${formatToolDetails(this.args)}\n${command ? 'Raw result (JSON)' : 'Result'}:\n${this.result === undefined ? 'running…' : formatToolDetails(this.result)}`,
        ),
        width >= 16 ? 4 : 0,
        0,
      );
      lines.push(...detail.render(width));
    }
    return lines;
  }
}

export interface SessionActions {
  readonly busy: boolean;
  readonly cancellable?: boolean;
  readonly closed: boolean;
  submit(text: string): Promise<unknown>;
  interrupt(): void;
}

/** Presentation adapter only. Execution and model configuration belong to the controller. */
export class PureAgentTUI implements SessionView {
  readonly tui: TuiAltScreen;
  readonly editor: Editor;
  private readonly transcript = new Transcript();
  private unseenOutput = false;
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
    this.mode = safeText(options.modeLabel).replace(/^REPLAY(?=\s|$)/, 'REPLAY · recorded output');
    this.tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal(), true, undefined, {
      mouse: false,
      scrollToEndIndicator: () => {
        const width = this.tui.terminal.columns;
        const label = this.unseenOutput ? 'New output' : 'Back to bottom';
        return width >= label.length + 14 ? `${label} · Ctrl+End` : width >= 10 ? '↓ Ctrl+End' : '↓';
      },
    });
    this.editor = new MinimalEditor(
      this.tui,
      {
        borderColor: deco.blue,
        selectList: {
          selectedPrefix: deco.purple,
          selectedText: deco.selected,
          description: deco.muted,
          scrollInfo: deco.muted,
          noMatch: deco.muted,
        },
      },
      { paddingX: 2, autocompleteMaxVisible: 4 },
    );
    this.editor.setAutocompleteProvider(commandCompletion);
    this.editor.onSubmit = (text) => {
      void this.submit(text);
    };
    const scroll = new ScrollView(this.transcript, { follow: 'end', primary: true, scrollbar: 'auto' });
    this.transcript.scroll = scroll;
    this.tui.setLayoutRoot(
      new VStack([
        {
          component: new Line(
            () => ` ${deco.bold('pure agent')}${options.workspace ? `  ${safeText(options.workspace)}` : ''}`,
          ),
          shrink: 0,
        },
        { component: new Line(() => ` ${this.mode}`), shrink: 0 },
        { component: scroll, grow: 1, basis: 0, minSize: 1 },
        {
          component: new Line(() => {
            if (this.tui.isFollowingOutput) this.unseenOutput = false;
            return deco.muted(` ${this.controller?.busy ? ['◐', '◓', '◑', '◒'][this.frame % 4] : '·'} ${this.status}`);
          }),
          shrink: 0,
        },
        { component: this.editor, shrink: 0 },
        {
          component: new Line((width) =>
            controls(
              width,
              this.controller?.busy ?? false,
              this.controller?.cancellable ?? this.controller?.busy ?? false,
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
      if (matchesKey(data, 'escape') && this.controller?.busy && this.controller.cancellable !== false) {
        this.interrupt();
        return { consume: true };
      }
      return undefined;
    });
    const note = options.note
      ?.split('\n')
      .filter((line) => line !== options.modeLabel && line !== `Workspace: ${options.workspace}`)
      .join('\n');
    if (note) this.panel('STATUS', note);
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
  private transcriptChanged() {
    this.unseenOutput = !this.tui.isFollowingOutput;
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
    this.unseenOutput = false;
    this.transcript.clear();
    this.tools.clear();
    this.tui.resetTextSelection();
    this.tui.scrollToBottom();
    this.status = 'ready · new session';
    this.tui.requestRender();
  }
  panel(kind: PanelKind, content: unknown) {
    const text = safeText(content);
    if (!(kind === 'STATUS' && text.startsWith('Cancellation requested'))) this.transcriptChanged();
    if (kind === 'STATUS' && text.startsWith('Cancellation requested')) this.status = text;
    else if (kind === 'STATUS' && text.startsWith('Session resumed:')) {
      this.status = 'ready · restored session';
      this.transcript.addChild(new Text(deco.muted(text), 2, 1));
    } else if (kind === 'AGENT') {
      this.transcript.addChild(new Markdown(text, 1, 1, markdownTheme, { color: deco.text }, { renderLatex: false }));
    } else if (kind === 'USER') {
      this.tools.clear();
      this.transcript.addChild(new Text(`› ${text}`, 1, 0, deco.band));
    } else {
      this.transcript.addChild(new Text(kind === 'ERROR' ? deco.red(`! ${text}`) : text, 2, 1));
    }
    this.tui.requestRender();
  }
  historyTool(name: string, args: string, result: string) {
    this.transcriptChanged();
    const tool = new ToolSummary('', safeText(name), safeText(args), () => this.expanded, true);
    tool.result = safeText(result);
    this.transcript.addChild(tool);
    this.tui.requestRender();
  }
  event(event: AgentEvent) {
    if (
      event.type === 'assistant_delta' ||
      event.type === 'assistant' ||
      event.type === 'tool_start' ||
      event.type === 'tool_end'
    )
      this.transcriptChanged();
    if (event.type === 'model_start') this.status = `working · model step ${event.step} · Esc to cancel`;
    if (event.type === 'assistant_delta' && event.text) {
      if (!this.streaming || this.streaming.step !== event.step) {
        const block = new Markdown('', 1, 1, markdownTheme, { color: deco.text }, { renderLatex: false });
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
  setStatus(status: string) {
    this.status = safeText(status).replace(/\n/g, ' ');
    this.tui.requestRender();
  }
  private finishStreaming() {
    if (this.streaming) {
      this.streaming.block.setText(`${safeText(this.streaming.text)}\n\n[Interrupted · partial output not saved]`);
      this.streaming = undefined;
    }
  }
  runError(error: string) {
    this.finishStreaming();
    this.setStatus('run failed · check error');
    this.panel('ERROR', error);
  }
  finish(result: RunResult) {
    this.finishStreaming();
    this.status = `${result.status} · ${result.steps} model step${result.steps === 1 ? '' : 's'}`;
    if (result.error) this.panel('ERROR', result.error);
    this.tui.requestRender();
  }
}
