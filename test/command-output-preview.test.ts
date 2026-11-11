import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProcessTools } from '../src/tools/process.ts';
import type { ProcessExecutionResult, ProcessReadResult } from '../src/tools/process.ts';
import { TerminalView } from '../src/ui/view.ts';

// Actual subprocesses and pure renderer inputs only. No agent, model, or HTTP client is created.
function capture() {
  let text = '';
  return {
    view: new TerminalView({ write: (part) => (text += part) }, false),
    text: () => text,
  };
}

async function processFixture(t: test.TestContext, script: string, maxOutputBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), 'pure-command-preview-'));
  const processes = createProcessTools({ root, inheritEnv: false, maxOutputBytes });
  t.after(async () => {
    await processes.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'check.mjs'), script);
  const run = async (name: string, args: unknown) => {
    const tool = processes.tools.find((item) => item.name === name);
    assert.ok(tool);
    return tool.execute(args, { signal: new AbortController().signal });
  };
  return { root, processes, run };
}

test('actual command output stays visible when process metadata exceeds the plain preview limit', async (t) => {
  const { root, processes, run } = await processFixture(
    t,
    "process.stderr.write('Command preview stderr\\nSecond diagnostic line\\n'); process.exitCode = 1;",
  );
  // Ignored script arguments reproduce long metadata without relying on host path lengths.
  const command = `"${process.execPath}" check.mjs ${'fixture-argument-'.repeat(40)}`;
  const result = (await run('exec_command', { command })) as ProcessExecutionResult;
  assert.equal(result.exitCode, 1);
  assert.equal(result.output, 'Command preview stderr\nSecond diagnostic line\n');
  const source = JSON.stringify(result);
  assert.ok(source.indexOf('"output"') > 600, 'This must reproduce metadata crowding out stdout/stderr');
  const out = capture();
  const event = { type: 'tool_end', id: 'check', name: 'exec_command', result: source } as const;
  out.view.event(event);
  assert.match(out.text(), /← exec_command\nResult: Status: exited; exit code: 1/);
  assert.match(out.text(), /Output:\nCommand preview stderr\nSecond diagnostic line\n/);
  assert.ok(out.text().includes(`Log (complete): ${result.logPath}`));
  assert.equal(event.result, source);
  assert.equal(await readFile(join(root, result.logPath), 'utf8'), result.output);

  // Recorded rendering works even after command and logs are removed. It does not execute either.
  await processes.dispose();
  await rm(join(root, 'artifacts'), { recursive: true });
  await rm(join(root, 'check.mjs'));
  const recorded = capture();
  recorded.view.historyTool('exec_command', JSON.stringify({ command }), source);
  assert.match(recorded.text(), /Recorded: exec_command/);
  assert.match(recorded.text(), /Output:\nCommand preview stderr\nSecond diagnostic line/);
  assert.doesNotMatch(recorded.text(), /← exec_command|running/);
});

test('actual retained-tail reads preserve omitted bytes, continuation cursor and tool truncation', async (t) => {
  const output = 'prefix that will not fit in the tail\n0123456789abcdefghijklmnop';
  const { run } = await processFixture(t, `process.stdout.write(${JSON.stringify(output)});`, 24);
  const execution = (await run('exec_command', {
    command: `"${process.execPath}" check.mjs`,
  })) as ProcessExecutionResult;
  assert.equal(execution.output, output.slice(-24));
  assert.equal(execution.truncated, true);
  const first = capture();
  first.view.event({ type: 'tool_end', id: 'exec', name: 'exec_command', result: JSON.stringify(execution) });
  assert.ok(first.text().includes(`Output:\n${output.slice(-24)}`));
  assert.match(first.text(), /process output truncated by tool/);

  const result = (await run('read_process', { id: execution.id, cursor: 0, maxBytes: 8 })) as ProcessReadResult;
  assert.equal(result.omittedBytes, Buffer.byteLength(output) - 24);
  assert.equal(result.output, output.slice(-24, -16));
  assert.equal(result.nextCursor, result.omittedBytes + 8);
  assert.equal(result.hasMore, true);
  const out = capture();
  out.view.historyTool(
    'read_process',
    JSON.stringify({ id: execution.id, cursor: 0, maxBytes: 8 }),
    JSON.stringify(result),
  );
  assert.ok(out.text().includes(`Output:\n${result.output}`));
  assert.ok(out.text().includes(`[${result.omittedBytes} output bytes omitted from retained tail]`));
  assert.ok(out.text().includes(`Next cursor: ${result.nextCursor}; more output: yes`));
  const remainder = (await run('read_process', { id: execution.id, cursor: result.nextCursor })) as ProcessReadResult;
  assert.equal(remainder.hasMore, false);
  assert.equal(result.output + remainder.output, execution.output);
});

test('display data preserves partial-output warnings and sanitizes decoded terminal controls', () => {
  // Plain display data, not an execution record or a simulated model response.
  const source = JSON.stringify({
    id: 'display-only-process',
    status: 'terminated',
    exitCode: null,
    signal: 'SIGTERM',
    terminationReason: 'output_limit',
    error: 'write failed\u001b[2J',
    cleanupWarning: 'Check descendants',
    output: `first line\n\u001b]0;unsafe-title\u0007${'x'.repeat(1000)}HIDDEN_TAIL`,
    truncated: true,
    omittedBytes: 12,
    nextCursor: 1012,
    hasMore: true,
    logPath: 'artifacts/process.log',
    logComplete: false,
  });
  const out = capture();
  out.view.historyTool('read_process', '{}', source);
  assert.match(out.text(), /Status: terminated; exit code: unavailable/);
  assert.match(out.text(), /Output:\nfirst line\n/);
  assert.match(out.text(), /truncated display only/);
  assert.match(out.text(), /process output truncated by tool/);
  assert.match(out.text(), /12 output bytes omitted/);
  assert.match(out.text(), /Next cursor: 1012; more output: yes/);
  assert.match(
    out.text(),
    /Signal: SIGTERM\nTermination: output_limit\nError: write failed\nCleanup warning: Check descendants/,
  );
  assert.match(out.text(), /Log \(incomplete\): artifacts\/process.log/);
  assert.doesNotMatch(out.text(), /HIDDEN_TAIL|unsafe-title/);
  assert.equal(out.text().includes('\u001b'), false);
});

test('non-process output, failures and malformed process display data retain the bounded fallback', () => {
  const source = JSON.stringify({ status: 'exited', exitCode: 0, output: 'do not reinterpret custom output' });
  const custom = capture();
  custom.view.historyTool('custom', '{}', source);
  assert.ok(custom.text().includes(`Result: ${source}`));
  for (const source of [
    '{"error":"Permission denied"}',
    'invalid JSON',
    'null',
    '[]',
    JSON.stringify({ status: 'exited', output: 'no exit code' }),
    JSON.stringify({ status: 'unknown', exitCode: 0, output: 'unrecognized status' }),
    JSON.stringify({ status: 'exited', exitCode: 0.5, output: 'invalid exit code' }),
  ]) {
    const out = capture();
    out.view.historyTool('exec_command', '{}', source);
    assert.ok(out.text().includes(`Result: ${source}`));
  }
  const out = capture();
  out.view.historyTool('exec_command', '{}', 'x'.repeat(601));
  assert.ok(out.text().endsWith(`${'x'.repeat(600)}\n[... truncated display only]\n`));
});

test('live and recorded renderer paths never split Unicode graphemes at the preview limit', () => {
  for (const grapheme of ['😀', 'e\u0301', '🇨🇳', '👨‍👩‍👧‍👦']) {
    const prefix = 'x'.repeat(599);
    const source = JSON.stringify({ status: 'exited', exitCode: 1, output: `${prefix}${grapheme}HIDDEN_TAIL` });
    const event = { type: 'tool_end', id: 'display-only', name: 'exec_command', result: source } as const;
    const live = capture();
    live.view.event(event);
    const recorded = capture();
    recorded.view.historyTool('exec_command', '{}', source);
    for (const out of [live, recorded]) {
      assert.ok(out.text().includes(`Output:\n${prefix}\n[... truncated display only]`));
      assert.doesNotMatch(out.text(), /HIDDEN_TAIL/);
      assert.equal(out.text().includes(grapheme), false);
    }
    assert.equal(event.result, source);
    assert.equal(JSON.parse(source).output, `${prefix}${grapheme}HIDDEN_TAIL`);
    const fallback = capture();
    fallback.view.historyTool('custom', '{}', `${prefix}${grapheme}HIDDEN_TAIL`);
    assert.ok(fallback.text().includes(`Result: ${prefix}\n[... truncated display only]`));
  }
});

test('process previews keep the 600-code-unit limit, fitting graphemes and empty output', () => {
  for (const [output, expected] of [
    ['', ''],
    [`${'x'.repeat(598)}😀`, `${'x'.repeat(598)}😀`],
    [`${'x'.repeat(598)}😀HIDDEN_TAIL`, `${'x'.repeat(598)}😀\n[... truncated display only]`],
    ['x'.repeat(601), `${'x'.repeat(600)}\n[... truncated display only]`],
  ]) {
    for (const name of ['exec_command', 'start_process', 'read_process', 'kill_process']) {
      const out = capture();
      out.view.historyTool(name, '{}', JSON.stringify({ status: 'exited', exitCode: 0, output }));
      assert.equal(
        out.text(),
        `[TOOL] Recorded: ${name}\nArguments (raw): {}\nResult: Status: exited; exit code: 0\nOutput:\n${expected}\n`,
      );
    }
  }
});

test('sanitization precedes the display cap, so long terminal controls do not crowd out output', () => {
  const output = `\u001b]0;${'hidden-title'.repeat(100)}\u0007${'x'.repeat(598)}😀`;
  const out = capture();
  out.view.historyTool('exec_command', '{}', JSON.stringify({ status: 'exited', exitCode: 0, output }));
  assert.ok(out.text().endsWith(`Output:\n${'x'.repeat(598)}😀\n`));
  assert.doesNotMatch(out.text(), /hidden-title|truncated/);
  assert.equal(out.text().includes('\u001b'), false);
});

test('unexpectedly long metadata fields stay bounded independently of process output', () => {
  const result = {
    status: 'exited',
    exitCode: 0,
    output: 'Useful output',
    id: 'i'.repeat(1000),
    signal: 's'.repeat(1000),
    terminationReason: 't'.repeat(1000),
    error: 'e'.repeat(1000),
    cleanupWarning: 'w'.repeat(1000),
    logPath: 'p'.repeat(1000),
  };
  const out = capture();
  out.view.historyTool('exec_command', '{}', JSON.stringify(result));
  assert.match(out.text(), /Output:\nUseful output/);
  for (const character of ['i', 's', 't', 'e', 'w', 'p']) {
    assert.ok(out.text().includes(character.repeat(600)));
    assert.ok(!out.text().includes(character.repeat(601)));
  }
  assert.ok(out.text().length < 4200);
});
