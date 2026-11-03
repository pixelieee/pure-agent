import test from 'node:test';
import assert from 'node:assert/strict';
import type { Terminal, ProgramStatus } from '@earendil-works/pi-tui';
import { safeText } from '../src/ui/view.ts';

/** Drives the same callbacks used by ProcessTerminal without a shell or live API. */
class HeadlessTerminal implements Terminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  output = '';
  stopped = false;
  title = '';
  onInput?: (data: string) => void;
  onResize?: () => void;
  start(onInput: (data: string) => void, onResize: () => void) {
    this.onInput = onInput;
    this.onResize = onResize;
  }
  stop() {
    this.stopped = true;
  }
  async drainInput() {}
  write(text: string) {
    this.output += text;
  }
  send(data: string) {
    assert.ok(this.onInput);
    this.onInput(data);
  }
  type(text: string) {
    for (const char of text) this.send(char);
  }
  resize(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.onResize?.();
  }
  moveBy(_lines: number) {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(title: string) {
    this.title = title;
  }
  setProgress(_active: boolean) {}
  setProgramStatus(_status: ProgramStatus) {}
}

async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
}

import { PureAgentTUI } from '../src/ui/tui.ts';
import { SessionController } from '../src/ui/controller.ts';
import { createAgent } from '../src/core.ts';
import { createTestAgent } from './fixtures/note-agent.ts';

function setup(factory = createTestAgent) {
  const terminal = new HeadlessTerminal();
  const ui = new PureAgentTUI({ terminal, modeLabel: 'TEST · local fixture', note: 'No network or keys' });
  const controller = new SessionController(factory, ui, { defaultSystem: 'test instructions' });
  ui.attach(controller);
  ui.start();
  const screen = () => {
    ui.tui.renderNow();
    return ui.tui.getScreenLines().map(safeText).join('\n');
  };
  screen();
  return { terminal, ui, controller, screen };
}

test('real editor handles multiline, bracketed paste, graphemes, history and repeated input', async (t) => {
  const { terminal, ui, screen } = setup();
  t.after(() => ui.stop());
  terminal.type('alpha');
  terminal.send('\n'); // Ctrl+J inserts a newline; Enter submits.
  terminal.type('beta');
  assert.equal(ui.editor.getText(), 'alpha\nbeta');
  terminal.send('\x1b[200~\n你好 👨‍👩‍👧‍👦\x1b[201~');
  assert.match(ui.editor.getExpandedText(), /beta\n你好 👨‍👩‍👧‍👦$/u);
  terminal.send('\x7f');
  assert.match(ui.editor.getExpandedText(), /beta\n你好 $/u);
  terminal.send('\r');
  await settle();
  assert.equal(ui.editor.getText(), '');
  assert.match(screen(), /alpha/);
  terminal.send('\x1b[A');
  assert.match(ui.editor.getExpandedText(), /^alpha\nbeta/u);
  terminal.send('\x1b[B');
  ui.editor.setText('');
  terminal.type('second turn');
  terminal.send('\r');
  await settle();
  assert.match(screen(), /second turn/);
  assert.equal(ui.editor.getText(), '');
});

test('resize keeps bottom editor usable and tool details expand only on demand', async (t) => {
  const { terminal, ui, screen } = setup();
  t.after(() => ui.stop());
  terminal.type('compact tool result');
  terminal.send('\r');
  await settle();
  const collapsed = screen();
  assert.match(collapsed, /format_note/);
  terminal.send('\x0f'); // Ctrl+O
  const expanded = screen();
  assert.notEqual(expanded, collapsed);
  assert.match(expanded, /compact tool result/);
  terminal.send('\x0f');
  assert.equal(screen(), collapsed);
  terminal.type('draft survives resize 你好');
  for (const [columns, rows] of [
    [48, 18],
    [120, 40],
    [32, 12],
  ]) {
    terminal.resize(columns, rows);
    const lines = screen().split('\n');
    assert.equal(lines.length, rows);
    assert.equal(ui.editor.getText(), 'draft survives resize 你好');
    assert.match(lines.slice(-8).join('\n'), /draft|survives|resize/);
  }
  terminal.send('\x01'); // Ctrl+A: native start-of-line editing
  terminal.type('prefix ');
  assert.equal(ui.editor.getText(), 'prefix draft survives resize 你好');
});

test('slash completion is contextual and reset explains its destructive effect', async (t) => {
  const { terminal, ui, screen } = setup();
  t.after(() => ui.stop());
  terminal.type('/he');
  await settle();
  assert.match(screen(), /help/i);
  terminal.send('\t');
  assert.match(ui.editor.getText(), /^\/help/);
  terminal.send('\r');
  await settle();
  assert.match(screen(), /\/create/);
  ui.editor.setText('/new');
  terminal.send('\r');
  await settle();
  assert.match(screen(), /history cleared|history reset/i);
  assert.equal(ui.editor.getText(), '');
});

test('Escape cancels in place, preserves typed draft, and Ctrl+C exits only when idle', async (t) => {
  let signal: AbortSignal | undefined;
  const { terminal, ui, controller, screen } = setup((system) =>
    createAgent({
      system,
      model: {
        complete: async (_messages, _tools, currentSignal) => {
          signal = currentSignal;
          await new Promise<void>((resolve) =>
            currentSignal.addEventListener('abort', () => resolve(), { once: true }),
          );
          return { role: 'assistant', content: 'interrupted' };
        },
      },
    }),
  );
  t.after(() => ui.stop());
  terminal.type('slow request');
  terminal.send('\r');
  await settle();
  assert.equal(controller.busy, true);
  terminal.type('keep this draft');
  terminal.send('\r');
  assert.equal(ui.editor.getText(), 'keep this draft');
  terminal.send('\x1b');
  await settle();
  assert.equal(signal?.aborted, true);
  assert.equal(controller.busy, false);
  assert.equal(controller.closed, false);
  assert.equal(ui.editor.getText(), 'keep this draft');
  assert.match(screen(), /cancelled/i);
  terminal.send('\x1b');
  assert.equal(controller.closed, false);
  terminal.send('\x03');
  assert.equal(controller.closed, true);
  assert.equal(terminal.stopped, true);
});

test('Ctrl+C cancels an active run without closing the session', async (t) => {
  const { terminal, ui, controller } = setup((system) =>
    createAgent({
      system,
      model: {
        complete: async (_messages, _tools, signal) => {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          return { role: 'assistant', content: '' };
        },
      },
    }),
  );
  t.after(() => ui.stop());
  terminal.type('run');
  terminal.send('\r');
  await settle();
  terminal.send('\x03');
  await settle();
  assert.equal(controller.busy, false);
  assert.equal(controller.closed, false);
});

test('untrusted terminal escapes are sanitized before Markdown and tool rendering', (t) => {
  const { terminal, ui, screen } = setup();
  t.after(() => ui.stop());
  terminal.output = '';
  ui.panel('AGENT', '**safe**\x1b]0;INJECTED-TITLE\x07\x1b[2J\u202e body');
  ui.event({ type: 'tool_start', id: 'safe-tool', name: 'read\x1b]0;BAD\x07', args: { path: '\x1b[2Jfile' } });
  ui.event({ type: 'tool_end', id: 'safe-tool', name: 'read', result: '{"value":"safe"}' });
  terminal.send('\x0f');
  assert.match(screen(), /safe/);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Assert injected terminal control sequences never reach output.
  assert.doesNotMatch(terminal.output, /INJECTED-TITLE|\x1b\]0;BAD|\u202e/);
});

test('long multiline drafts keep their last editing line visible after resize', (t) => {
  const { terminal, ui, screen } = setup();
  t.after(() => ui.stop());
  const draft = Array.from({ length: 24 }, (_, index) => `draft line ${index}`).join('\n');
  terminal.type(draft);
  for (const [columns, rows] of [
    [100, 40],
    [48, 18],
    [100, 50],
  ]) {
    terminal.resize(columns, rows);
    assert.match(screen(), /draft line 23/);
    assert.equal(ui.editor.getExpandedText(), draft);
  }
});

test('new and create reset the visible transcript together with model history', async (t) => {
  const { terminal, ui, screen } = setup();
  t.after(() => ui.stop());
  for (const command of ['/new', '/create replacement instructions']) {
    terminal.type('old transcript marker');
    terminal.send('\r');
    await settle();
    assert.match(screen(), /old transcript marker/);
    terminal.type(command);
    terminal.send('\r');
    await settle();
    assert.doesNotMatch(screen(), /old transcript marker|format_note/);
    assert.match(screen(), /history cleared/i);
    assert.match(screen(), /ready · new session/);
  }
});

test('collapsed tool errors remain visible without opening JSON details', (t) => {
  const { ui, screen } = setup();
  t.after(() => ui.stop());
  ui.event({ type: 'tool_start', id: 'failed', name: 'read_file', args: { path: 'missing.txt' } });
  ui.event({
    type: 'tool_end',
    id: 'failed',
    name: 'read_file',
    result: JSON.stringify({ ok: false, error: 'File not found' }),
  });
  assert.match(screen(), /! read_file.*File not found/);
  assert.doesNotMatch(screen(), /Arguments:|Result:/);
});

test('replay identity remains in fixed header after transcript scrolls and resets', (t) => {
  const terminal = new HeadlessTerminal();
  const ui = new PureAgentTUI({ terminal, modeLabel: 'REPLAY · historical-model · offline' });
  t.after(() => ui.stop());
  ui.start();
  for (let i = 0; i < 30; i++) ui.panel('AGENT', `Recorded answer ${i}`);
  ui.tui.renderNow();
  assert.match(safeText(ui.tui.getScreenLines()[0]), /REPLAY · recorded output · offline/);
  ui.reset();
  ui.tui.renderNow();
  assert.match(safeText(ui.tui.getScreenLines()[0]), /REPLAY · recorded output · offline/);
});

test('expanded file evidence is multiline and decoded terminal controls stay inert', (t) => {
  const { terminal, ui, screen } = setup();
  t.after(() => ui.stop());
  ui.event({ type: 'tool_start', id: 'file', name: 'read_project_file', args: { path: 'README.md' } });
  ui.event({
    type: 'tool_end',
    id: 'file',
    name: 'read_project_file',
    result: JSON.stringify({
      path: 'README.md',
      content: 'first line\nsecond line\x1b]0;DECODED-ATTACK\x07\x1b[2J\u202e',
      truncated: true,
    }),
  });
  terminal.output = '';
  terminal.send('\x0f');
  const frame = screen();
  assert.match(frame, /first line\s*\n.*second line/);
  assert.match(frame, /file content truncated by tool/);
  assert.doesNotMatch(frame, /\\n|DECODED-ATTACK/);
  assert.doesNotMatch(terminal.output, /DECODED-ATTACK|\u202e/);
});

test('terminal branding is set through the terminal adapter and cleared on exit', () => {
  for (const modeLabel of ['DEMO', 'REPLAY · offline']) {
    const terminal = new HeadlessTerminal();
    const ui = new PureAgentTUI({ terminal, modeLabel });
    ui.start();
    assert.equal(terminal.title, 'Pure Agent');
    ui.stop();
    assert.equal(terminal.title, 'Terminal');
  }
});

test('selected slash command has amber background and deep-ink foreground', async (t) => {
  const { terminal, ui } = setup();
  t.after(() => ui.stop());
  terminal.type('/he');
  await settle();
  ui.tui.renderNow();
  const frame = ui.tui.getScreenLines().join('\n');
  assert.match(frame, /38;2;15;17;25;48;2;226;177;91m/);
});

test('streaming updates one Markdown block, preserves drafts, and replaces partial final text', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const streamed = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const { ui, controller, screen } = setup(() =>
    createAgent({
      model: {
        async complete(_messages, _tools, _signal, onTextDelta) {
          await onTextDelta?.('unique streamed ');
          await onTextDelta?.('answer');
          ready();
          await gate;
          return { role: 'assistant', content: 'unique final answer' };
        },
      },
    }),
  );
  t.after(() => ui.stop());
  const run = controller.submit('stream this');
  await streamed;
  ui.editor.setText('next draft');
  assert.match(screen(), /unique streamed answer/);
  release();
  await run;
  const final = screen();
  assert.equal(final.split('unique final answer').length - 1, 1);
  assert.doesNotMatch(final, /unique streamed answer/);
  assert.equal(ui.editor.getText(), 'next draft');
});

test('interrupted streaming is marked and a later run uses a fresh block', async (t) => {
  const { ui, screen } = setup();
  t.after(() => ui.stop());
  ui.event({ type: 'assistant_delta', step: 1, text: 'partial fragment' });
  ui.finish({ status: 'cancelled', steps: 1, text: '' });
  assert.match(screen(), /Interrupted · partial output not saved/);
  ui.event({ type: 'assistant_delta', step: 1, text: 'fresh answer' });
  ui.event({ type: 'assistant', step: 1, text: 'fresh answer' });
  const final = screen();
  assert.match(final, /partial fragment/);
  assert.equal(final.split('fresh answer').length - 1, 1);
  ui.reset();
  assert.doesNotMatch(screen(), /partial fragment|fresh answer|Interrupted/);
});

test('stream deltas respect manual scroll and sanitize split terminal controls', (t) => {
  const { ui, screen } = setup();
  t.after(() => ui.stop());
  ui.panel('AGENT', Array.from({ length: 80 }, (_, i) => `older transcript row ${i}`).join('\n'));
  ui.event({ type: 'assistant_delta', step: 1, text: 'stream tail' });
  screen();
  ui.tui.scrollToTop();
  const before = screen();
  ui.event({ type: 'assistant_delta', step: 1, text: '\nnew tail\x1b[' });
  ui.event({ type: 'assistant_delta', step: 1, text: '31mred\x1b[0m' });
  assert.equal(screen(), before);
  ui.tui.scrollToBottom();
  const bottom = screen();
  assert.match(bottom, /new tailred/);
  assert.doesNotMatch(bottom, /31mred/);
});

test('workspace and trust remain visible after reset and process failures are visible when collapsed', async (t) => {
  const terminal = new HeadlessTerminal();
  const ui = new PureAgentTUI({ terminal, modeLabel: 'OPENAI · READ-ONLY', workspace: '/project/example' });
  const controller = new SessionController(createTestAgent, ui);
  ui.attach(controller);
  ui.start();
  t.after(() => ui.stop());
  await controller.submit('/new');
  ui.event({ type: 'tool_start', name: 'exec_command', id: 'fail', args: { command: 'node --test' } });
  ui.event({
    type: 'tool_end',
    name: 'exec_command',
    id: 'fail',
    result: JSON.stringify({ exitCode: 1, stdout: 'failed', stderr: '' }),
  });
  ui.tui.renderNow();
  const screen = ui.tui.getScreenLines().map(safeText).join('\n');
  assert.match(screen, /Workspace: \/project\/example/);
  assert.match(screen, /READ-ONLY/);
  assert.match(screen, /exec_command · exit 1/);
});
