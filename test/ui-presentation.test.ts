import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessTools, type ProcessExecutionResult, type ProcessReadResult } from '../src/tools/process.ts';
import { spawnSync } from 'node:child_process';
import type { Terminal, ProgramStatus } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import { PureAgentTUI } from '../src/ui/tui.ts';
import { TerminalView, safeText } from '../src/ui/view.ts';
import { deco } from '../src/ui/theme.ts';
import { commandOutput, renderCommandOutput } from '../src/ui/command-output.ts';

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

test('actual subprocess stderr remains accessible in minimal recorded tool details', (t) => {
  const { terminal, ui, screen } = presentation();
  t.after(() => ui.stop());
  const script = "process.stderr.write('Actual subprocess diagnostic'); process.exitCode = 2;";
  const executed = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000, env: {} });
  assert.ifError(executed.error);
  assert.equal(executed.status, 2);
  assert.equal(executed.stderr, 'Actual subprocess diagnostic');
  // Plain recorded display data sourced from the real subprocess above, not an agent execution.
  const source = JSON.stringify({
    command: 'long display metadata '.repeat(40),
    status: 'exited',
    exitCode: executed.status,
    output: executed.stderr,
  });
  assert.ok(source.indexOf('"output"') > 600);
  ui.historyTool('exec_command', '{}', source);
  assert.match(screen().join('\n'), /exec_command.*recorded: exit 2/);
  assert.match(screen().join('\n'), /Actual subprocess/);
  terminal.input?.('\x0f');
  assert.match(screen().join('\n'), /Actual subprocess diagnostic/);
  terminal.input?.('\x0f');
  terminal.columns = 24;
  terminal.resize?.();
  assert.match(screen().join('\n'), /Actual subprocess/);
  assert.ok(screen().every((line) => visibleWidth(line) <= 24));
  terminal.columns = 100;
  terminal.resize?.();
  terminal.input?.('\x0f');
  assert.match(screen().join('\n'), /Actual subprocess diagnostic/);
  assert.equal(JSON.parse(source).output, executed.stderr);
});

test('interactive command cards use real tool results across live, recorded, resize and details paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pure-interactive-card-'));
  const processes = createProcessTools({ root, inheritEnv: false });
  const { terminal, ui, screen } = presentation();
  t.after(async () => {
    ui.stop();
    await processes.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    join(root, 'command.mjs'),
    "process.stdout.write('First output line\\nSecond output line\\n'); process.stderr.write('Actual diagnostic\\n'); process.exitCode = 3;",
  );
  const tool = processes.tools.find((item) => item.name === 'exec_command');
  assert.ok(tool);
  const args = { command: `"${process.execPath}" command.mjs` };
  ui.event({ type: 'tool_start', id: 'actual-command', name: tool.name, args });
  assert.match(screen().join('\n'), /exec_command.*running/);
  const result = (await tool.execute(args, { signal: new AbortController().signal })) as ProcessExecutionResult;
  assert.equal(result.exitCode, 3);
  const source = JSON.stringify(result);
  ui.event({ type: 'tool_end', id: 'actual-command', name: tool.name, result: source });
  let text = screen().join('\n');
  assert.match(text, /exec_command.*exit 3/);
  assert.match(text, /stdout \+ stderr \(combined\)/);
  assert.match(text, /First output line\s*\n.*Second output line/);
  assert.match(text, /Actual diagnostic/);
  assert.doesNotMatch(text, /"output"|Raw result/);
  ui.editor.setText('keep this draft 你好');
  for (const width of [100, 40, 24, 12, 8, 80]) {
    terminal.columns = width;
    terminal.resize?.();
    for (let toggle = 0; toggle < 2; toggle++) {
      terminal.input?.('\x0f');
      const lines = screen();
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.equal(ui.editor.getText(), 'keep this draft 你好');
    }
  }
  terminal.columns = 100;
  terminal.rows = 70;
  terminal.resize?.();
  terminal.input?.('\x0f');
  text = screen().join('\n');
  assert.match(text, /Raw result \(JSON\)/);
  assert.match(text, /"stdoutBytes":/);
  assert.match(text, /First output line\s*\n.*Second output line/);
  assert.equal(JSON.stringify(result), source);
  terminal.input?.('\x0f');
  ui.reset();
  ui.historyTool(tool.name, JSON.stringify(args), source);
  assert.match(screen().join('\n'), /recorded: exit 3/);
  assert.match(screen().join('\n'), /Actual diagnostic/);
});

test('real retained-tail cards disclose tool loss, continuation, display clipping and sanitized controls', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pure-interactive-tail-'));
  const processes = createProcessTools({ root, inheritEnv: false, maxOutputBytes: 128 });
  const { terminal, ui, screen } = presentation();
  t.after(async () => {
    ui.stop();
    await processes.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const output = `discarded prefix ${'x'.repeat(100)}\n\x1b]0;unsafe-title\x07${'readable output\n'.repeat(10)}\x1b]0;unsafe-title\x07`;
  await writeFile(join(root, 'output.mjs'), `process.stdout.write(${JSON.stringify(output)});`);
  const exec = processes.tools.find((item) => item.name === 'exec_command');
  const read = processes.tools.find((item) => item.name === 'read_process');
  assert.ok(exec && read);
  const context = { signal: new AbortController().signal };
  const result = (await exec.execute(
    { command: `"${process.execPath}" output.mjs` },
    context,
  )) as ProcessExecutionResult;
  assert.equal(result.truncated, true);
  ui.historyTool(exec.name, '{}', JSON.stringify(result));
  assert.match(screen().join('\n'), /output truncated by tool/);
  assert.match(screen().join('\n'), /preview clipped/);
  assert.doesNotMatch(screen().join('\n'), /unsafe-title/);
  ui.reset();
  const first = (await read.execute({ id: result.id, cursor: 0, maxBytes: 20 }, context)) as ProcessReadResult;
  assert.ok(first.omittedBytes > 0);
  assert.equal(first.hasMore, true);
  ui.historyTool(read.name, '{}', JSON.stringify(first));
  assert.match(screen().join('\n'), new RegExp(`${first.omittedBytes} bytes omitted`));
  assert.match(screen().join('\n'), new RegExp(`cursor ${first.nextCursor} · more output: yes`));
  terminal.input?.('\x0f');
  assert.ok(screen().every((line) => visibleWidth(line) <= terminal.columns));
});

test('command projection bounds decoded controls and graphemes without altering raw details', () => {
  for (const grapheme of ['😀', 'e\u0301', '🇨🇳', '👨‍👩‍👧‍👦']) {
    const source = JSON.stringify({
      status: 'failed',
      exitCode: null,
      output: `\x1b]0;${'hidden'.repeat(500)}\x07${'x'.repeat(23_999)}${grapheme}TAIL`,
      error: 'failure\x1b[2J',
      logPath: 'logs/output',
      logComplete: false,
    });
    const result = commandOutput('exec_command', source);
    assert.ok(result);
    const rendered = renderCommandOutput(result, 80, true).map(safeText).join('\n');
    assert.match(rendered, /failed · exit unavailable/);
    assert.match(rendered, /display truncated; raw result unchanged/);
    assert.match(rendered, /log \(incomplete\)/);
    assert.doesNotMatch(rendered, /hidden|TAIL/);
    assert.ok(!rendered.includes(grapheme));
    assert.equal(JSON.stringify(result), source);
  }
  for (const source of [
    'null',
    '[]',
    'bad JSON',
    '{"error":"permission denied"}',
    '{"status":"unknown","exitCode":0,"output":"text"}',
    '{"status":"exited","exitCode":0.5,"output":"text"}',
  ]) {
    assert.equal(commandOutput('exec_command', source), undefined);
  }
  assert.equal(commandOutput('custom', '{"status":"exited","exitCode":0,"output":"text"}'), undefined);
});

test('actual background process stays running until a real termination result arrives', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pure-interactive-running-'));
  const processes = createProcessTools({ root, inheritEnv: false });
  const { ui, screen } = presentation();
  t.after(async () => {
    ui.stop();
    await processes.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'wait.mjs'), 'setInterval(() => {}, 1000);');
  const start = processes.tools.find((item) => item.name === 'start_process');
  const kill = processes.tools.find((item) => item.name === 'kill_process');
  assert.ok(start && kill);
  const context = { signal: new AbortController().signal };
  const args = { command: `"${process.execPath}" wait.mjs` };
  ui.event({ type: 'tool_start', id: 'start', name: start.name, args });
  const running = (await start.execute(args, context)) as ProcessExecutionResult;
  assert.equal(running.status, 'running');
  ui.event({ type: 'tool_end', id: 'start', name: start.name, result: JSON.stringify(running) });
  assert.match(screen().join('\n'), /start_process.*running/);
  assert.doesNotMatch(screen().join('\n'), /done/);
  const killed = (await kill.execute({ id: running.id }, context)) as ProcessExecutionResult;
  assert.equal(killed.status, 'terminated');
  ui.reset();
  ui.historyTool(kill.name, JSON.stringify({ id: running.id }), JSON.stringify(killed));
  assert.match(screen().join('\n'), /recorded: killed/);
  assert.match(screen().join('\n'), /terminated · exit/);
});

test('expanded command cards put readable output before arguments and raw result', (t) => {
  const { terminal, ui, screen } = presentation();
  t.after(() => ui.stop());
  const executed = spawnSync(process.execPath, ['-e', "console.log('readable first')"], {
    encoding: 'utf8',
    env: {},
    timeout: 10_000,
  });
  assert.ifError(executed.error);
  assert.equal(executed.status, 0);
  ui.historyTool('exec_command', '{}', JSON.stringify({ status: 'exited', exitCode: 0, output: executed.stdout }));
  terminal.rows = 60;
  terminal.resize?.();
  terminal.input?.('\x0f');
  const text = screen().join('\n');
  assert.ok(text.indexOf('readable first') >= 0);
  assert.ok(text.indexOf('readable first') < text.indexOf('Arguments:'));
  assert.ok(text.indexOf('Arguments:') < text.indexOf('Raw result (JSON)'));
});

test('native scroll indicator, block anchoring and return to bottom preserve drafts', (t) => {
  const { terminal, ui, screen } = presentation();
  t.after(() => ui.stop());
  const source = readFileSync(new URL('../tsconfig.build.json', import.meta.url), 'utf8');
  for (let index = 0; index < 50; index++) {
    ui.historyTool('read_file', JSON.stringify({ path: `block-${index}` }), source);
  }
  ui.editor.setText('draft line one\nline two');
  screen();
  terminal.input?.('\x1b[5~'); // Pi's PageUp, not an application shortcut.
  let lines = screen();
  assert.equal(ui.tui.isFollowingOutput, false);
  assert.match(lines.join('\n'), /Back to bottom · Ctrl\+End/);
  const anchoredText = (line: string) => line.replace(/\s*│$/, '').trim();
  const anchor = anchoredText(lines[2]);
  const top = ui.tui.viewportTop;
  ui.historyTool('read_file', JSON.stringify({ path: 'new-file' }), source);
  lines = screen();
  assert.equal(anchoredText(lines[2]), anchor);
  assert.equal(ui.tui.viewportTop, top);
  assert.match(lines.join('\n'), /New output · Ctrl\+End/);
  terminal.input?.('\x0f');
  assert.equal(anchoredText(screen()[2]), anchor);
  terminal.columns = 70;
  terminal.resize?.();
  assert.equal(anchoredText(screen()[2]), anchor);
  terminal.input?.('\x0f');
  assert.equal(anchoredText(screen()[2]), anchor);
  assert.equal(ui.editor.getText(), 'draft line one\nline two');
  terminal.input?.('\x1b[1;5F'); // Pi's Ctrl+End.
  assert.doesNotMatch(screen().join('\n'), /Back to bottom|New output/);
  assert.equal(ui.tui.isFollowingOutput, true);
  terminal.input?.('\x1b[5~');
  assert.match(screen().join('\n'), /Back to bottom/);
  assert.doesNotMatch(screen().join('\n'), /New output/);
  for (const width of [24, 12, 8]) {
    terminal.columns = width;
    terminal.resize?.();
    assert.ok(screen().every((line) => visibleWidth(line) <= width));
    assert.equal(ui.editor.getText(), 'draft line one\nline two');
  }
  ui.reset();
  assert.equal(ui.tui.isFollowingOutput, true);
  assert.doesNotMatch(screen().join('\n'), /New output/);
});
