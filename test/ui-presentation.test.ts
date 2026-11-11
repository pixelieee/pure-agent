import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Terminal, ProgramStatus } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import { PureAgentTUI } from '../src/ui/tui.ts';
import { TerminalView, safeText } from '../src/ui/view.ts';
import { deco } from '../src/ui/theme.ts';

/** Terminal transport only. These checks never create an agent or model response. */
class PresentationTerminal implements Terminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  input?: (data: string) => void;
  resize?: () => void;
  start(input: (data: string) => void, resize: () => void) {
    this.input = input;
    this.resize = resize;
  }
  stop() {}
  async drainInput() {}
  write(_text: string) {}
  moveBy(_lines: number) {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(_title: string) {}
  setProgress(_active: boolean) {}
  setProgramStatus(_status: ProgramStatus) {}
}

function presentation() {
  const terminal = new PresentationTerminal();
  const ui = new PureAgentTUI({
    terminal,
    modeLabel: 'UI inspection · no model connected',
    workspace: '/workspace/pure-agent',
    note: 'UI inspection · no model connected\nWorkspace: /workspace/pure-agent',
  });
  ui.start();
  const screen = () => {
    ui.tui.renderNow();
    return ui.tui.getScreenLines().map(safeText);
  };
  return { terminal, ui, screen };
}

test('minimal chrome keeps one title, one mode label and complete width-aware controls', (t) => {
  const { terminal, ui, screen } = presentation();
  t.after(() => ui.stop());
  for (const width of [100, 80, 60, 40, 30, 20, 12]) {
    terminal.columns = width;
    terminal.resize?.();
    const lines = screen();
    const text = lines.join('\n');
    assert.doesNotMatch(text, /Developer edition|DARK DECO|ISSUE 001|\bAGENT\b|\bYOU\b/);
    assert.equal(lines.filter((line) => line.includes('pure agent')).length, 1);
    assert.equal(lines.filter((line) => line.includes('UI inspection')).length, width >= 14 ? 1 : 0);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    const footer = lines.at(-1)?.trimEnd();
    assert.ok(footer);
    assert.match(footer, width >= 20 ? /Ctrl\+C exit$/ : /\/help$/);
  }
});

test('real editor preserves multiline drafts, grapheme deletion and resize without submission', (t) => {
  const { terminal, ui, screen } = presentation();
  t.after(() => ui.stop());
  terminal.input?.('alpha');
  terminal.input?.('\n');
  terminal.input?.('\x1b[200~beta 你好 👨‍👩‍👧‍👦\x1b[201~');
  assert.equal(ui.editor.getExpandedText(), 'alpha\nbeta 你好 👨‍👩‍👧‍👦');
  terminal.input?.('\x7f');
  assert.equal(ui.editor.getExpandedText(), 'alpha\nbeta 你好 ');
  for (const width of [100, 40, 20, 80]) {
    terminal.columns = width;
    terminal.resize?.();
    assert.ok(screen().every((line) => visibleWidth(line) <= width));
    assert.equal(ui.editor.getExpandedText(), 'alpha\nbeta 你好 ');
  }
  assert.match(screen().join('\n'), /›\s+alpha/);
});

test('command menu opens and dismisses without a model or draft loss', async (t) => {
  const { terminal, ui, screen } = presentation();
  t.after(() => ui.stop());
  terminal.input?.('/');
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.match(screen().join('\n'), /Commands and keyboard shortcuts/);
  terminal.input?.('\x1b');
  assert.doesNotMatch(screen().join('\n'), /Commands and keyboard shortcuts/);
  assert.equal(ui.editor.getText(), '/');
  terminal.columns = 30;
  terminal.resize?.();
  assert.ok(screen().every((line) => visibleWidth(line) <= 30));
});

test('actual source read is labeled recorded and toggles details without execution', (t) => {
  const { terminal, ui, screen } = presentation();
  t.after(() => ui.stop());
  const source = readFileSync(new URL('../tsconfig.build.json', import.meta.url), 'utf8');
  ui.historyTool('read_file', JSON.stringify({ path: 'tsconfig.build.json' }), source);
  assert.match(screen().join('\n'), /read_file.*recorded/);
  assert.doesNotMatch(screen().join('\n'), /Arguments:/);
  terminal.input?.('\x0f');
  assert.match(screen().join('\n'), /Arguments:/);
  terminal.input?.('\x0f');
  terminal.columns = 24;
  terminal.resize?.();
  assert.match(screen().join('\n'), /recorded/);
  assert.doesNotMatch(screen().join('\n'), /running/);
  assert.ok(screen().every((line) => visibleWidth(line) <= 24));
});

test('user bands and errors use a single text marker with no role labels', (t) => {
  const { ui, screen } = presentation();
  t.after(() => ui.stop());
  ui.panel('USER', 'Inspect the terminal layout.');
  ui.panel('ERROR', 'UI inspection stopped.');
  const text = screen().join('\n');
  assert.match(text, /› Inspect the terminal layout\./);
  assert.match(text, /! UI inspection stopped\./);
  assert.doesNotMatch(text, /YOU|AGENT|┏|┗/);
});

test('append-only color presentation removes boxes while plain output preserves labels', () => {
  for (const color of [true, false]) {
    let output = '';
    const view = new TerminalView({ columns: 50, write: (text) => (output += text) }, color);
    view.panel('USER', 'Inspect the terminal layout.');
    view.panel('ERROR', 'UI inspection stopped.');
    assert.doesNotMatch(output, /┏|┗|DARK DECO/);
    assert.match(safeText(output), color ? /› Inspect/ : /\[USER\] Inspect/);
    assert.match(safeText(output), color ? /! UI inspection/ : /\[ERROR\] UI inspection/);
  }
});

test('accent tokens are desaturated truecolor and honor NO_COLOR and dumb terminals', () => {
  const noColor = process.env.NO_COLOR;
  const term = process.env.TERM;
  try {
    delete process.env.NO_COLOR;
    process.env.TERM = 'xterm-256color';
    assert.equal(deco.blue('line'), '\x1b[38;2;101;125;165mline\x1b[39m');
    assert.equal(deco.purple('marker'), '\x1b[38;2;136;116;159mmarker\x1b[39m');
    assert.equal(deco.text('body'), 'body');
    process.env.NO_COLOR = '';
    for (const style of Object.values(deco)) assert.equal(style('text'), 'text');
    delete process.env.NO_COLOR;
    process.env.TERM = 'dumb';
    for (const style of Object.values(deco)) assert.equal(style('text'), 'text');
  } finally {
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
    if (term === undefined) delete process.env.TERM;
    else process.env.TERM = term;
  }
});
