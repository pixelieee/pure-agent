import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgent, type Model } from '../src/core.ts';
import {
  createProcessTools,
  type ProcessToolsOptions,
  type ProcessExecutionResult,
  type ProcessReadResult,
  type ProcessSnapshot,
} from '../src/tools/process.ts';

type TestResult = ProcessExecutionResult & ProcessReadResult & { processes: ProcessSnapshot[] };

const ctx = () => ({ signal: new AbortController().signal });
const quote = (value: string) =>
  process.platform === 'win32' ? `"${value.replaceAll('"', '\\"')}"` : `'${value.replaceAll("'", "'\\''")}'`;
const node = (source: string) => `${quote(process.execPath)} -e ${quote(source)}`;
async function fixture(t: { after: (fn: () => Promise<void>) => void }, options: Partial<ProcessToolsOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pure-process-')));
  const set = createProcessTools({ root, killGraceMs: 30, ...options });
  t.after(async () => {
    await set.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const invoke = (name: string, args: unknown, context = ctx()) => {
    const tool = set.tools.find((item) => item.name === name);
    assert.ok(tool, name);
    return tool.execute(args, context) as Promise<TestResult>;
  };
  return { root, set, invoke };
}

test('process tools compose with the tiny agent and report ordinary nonzero exits', async (t) => {
  const { invoke, set } = await fixture(t);
  const command = node('process.stdout.write("out");process.stderr.write("err");process.exitCode=7');
  const result = await invoke('exec_command', { command });
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.equal(result.stdoutBytes, 3);
  assert.equal(result.stderrBytes, 3);
  assert.match(result.output, /out/);
  assert.match(result.output, /err/);
  assert.equal(result.logComplete, true);
  const model: Model = {
    complete: async (messages) =>
      messages.at(-1)?.role === 'tool'
        ? { role: 'assistant', content: 'done' }
        : {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'exec',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ command: node('console.log("composed")') }),
                },
              },
            ],
          },
  };
  const agent = createAgent({ model, tools: set.tools });
  assert.equal((await agent.run('execute')).status, 'completed');
  assert.match(agent.messages.find((m) => m.role === 'tool')?.content ?? '', /composed/);
});

test('cwd is explicit, canonical and scoped, without claiming command sandboxing', async (t) => {
  const { root, invoke } = await fixture(t);
  await mkdir(join(root, 'nested'));
  const result = await invoke('exec_command', { command: node('console.log(process.cwd())'), cwd: 'nested' });
  assert.equal(result.output.trim(), join(root, 'nested'));
  await assert.rejects(invoke('exec_command', { command: 'echo nope', cwd: '..' }), /inside the workspace/);
  await assert.rejects(invoke('exec_command', { command: 'echo nope', cwd: 'missing' }), /ENOENT/);
  if (process.platform !== 'win32') {
    await symlink(tmpdir(), join(root, 'escape'));
    await assert.rejects(invoke('exec_command', { command: 'echo nope', cwd: 'escape' }), /workspace directory/);
    await symlink(join(root, 'nested'), join(root, 'local-link'));
    assert.equal(
      (await invoke('exec_command', { command: 'pwd', cwd: 'local-link' })).output.trim(),
      join(root, 'nested'),
    );
  }
});

test('command source supports shell syntax and configured shell, not an arbitrary allowlist', async (t) => {
  const { invoke } = await fixture(t, { shell: { command: process.execPath, args: ['-e'] } });
  const result = await invoke('exec_command', { command: 'console.log(2+3)' });
  assert.equal(result.output.trim(), '5');
});

test('bounded combined output has byte-complete raw log, per-stream counts, and cursor replay', async (t) => {
  const { root, invoke } = await fixture(t, { maxOutputBytes: 128 });
  const result = await invoke('exec_command', {
    command: node('process.stdout.write("a".repeat(20000));process.stderr.write("b".repeat(20000))'),
  });
  assert.equal(result.totalOutputBytes, 40_000);
  assert.equal(result.stdoutBytes, 20_000);
  assert.equal(result.stderrBytes, 20_000);
  assert.ok(Buffer.byteLength(result.output) <= 128);
  assert.equal(result.truncated, true);
  const log = await readFile(join(root, result.logPath));
  assert.equal(log.length, 40_000);
  assert.equal(result.logComplete, true);
  const first = await invoke('read_process', { id: result.id, maxBytes: 16 });
  assert.equal(first.omittedBytes, 40_000 - 128);
  assert.equal(first.output.length, 16);
  assert.equal(first.hasMore, true);
  const replay = await invoke('read_process', { id: result.id, maxBytes: 16 });
  assert.deepEqual(replay, first);
  const next = await invoke('read_process', { id: result.id, cursor: first.nextCursor });
  assert.equal(next.omittedBytes, 0);
  assert.equal(next.hasMore, false);
  assert.equal(next.nextCursor, 40_000);
  await assert.rejects(invoke('read_process', { id: result.id, cursor: 40_001 }), /beyond available/);
  if (process.platform !== 'win32') assert.equal((await stat(join(root, result.logPath))).mode & 0o777, 0o600);
});

test('UTF-8 output remains valid and bounded across split chunks and cursor boundaries', async (t) => {
  const { invoke } = await fixture(t, { maxOutputBytes: 9 });
  const result = await invoke('exec_command', {
    command: node(
      'const b=Buffer.from("😀世界😀");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),20)',
    ),
  });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.output) <= 9);
  assert.ok(!result.output.includes('�'));
  let page = await invoke('read_process', { id: result.id, maxBytes: 4 });
  assert.ok(!page.output.includes('�'));
  page = await invoke('read_process', { id: result.id, maxBytes: 4, cursor: page.nextCursor });
  assert.ok(!page.output.includes('�'));
});

test('invalid UTF-8 output cannot expand preview beyond its byte budget', async (t) => {
  const { invoke } = await fixture(t, { maxOutputBytes: 16 });
  const result = await invoke('exec_command', { command: node('process.stdout.write(Buffer.alloc(100,255))') });
  assert.ok(Buffer.byteLength(result.output) <= 16);
});

test('log budget terminates chatty jobs and explicitly marks the log incomplete', async (t) => {
  const { root, invoke } = await fixture(t, { maxOutputBytes: 32, maxLogBytes: 100 });
  const result = await invoke('exec_command', {
    command: node('process.stdout.write("x".repeat(1000));setInterval(()=>{},1000)'),
  });
  assert.equal(result.status, 'terminated');
  assert.equal(result.terminationReason, 'output_limit');
  assert.equal(result.logComplete, false);
  assert.equal((await stat(join(root, result.logPath))).size, 100);
  assert.ok(Buffer.byteLength(result.output) <= 32);
});

test('foreground stdin closes at EOF; background input, output polling and kill have explicit lifecycle', async (t) => {
  const { invoke } = await fixture(t);
  const echo = node('process.stdin.on("data",b=>process.stdout.write(b));process.stdin.on("end",()=>process.exit(0))');
  assert.equal((await invoke('exec_command', { command: echo, stdin: 'foreground\n' })).output, 'foreground\n');
  const started = await invoke('start_process', { command: echo });
  assert.equal(started.status, 'running');
  await invoke('write_process', { id: started.id, chars: 'hello\n' });
  let page = await invoke('read_process', { id: started.id, waitMs: 1000 });
  assert.equal(page.output, 'hello\n');
  await invoke('write_process', { id: started.id, chars: 'world\n', end: true });
  let output = page.output;
  while (page.status === 'running') {
    page = await invoke('read_process', { id: started.id, cursor: page.nextCursor, waitMs: 1000 });
    output += page.output;
  }
  assert.equal(output, 'hello\nworld\n');
  assert.equal(page.exitCode, 0);
  await assert.rejects(invoke('write_process', { id: started.id, chars: 'late' }), /closed/);
  assert.equal((await invoke('kill_process', { id: started.id })).exitCode, 0);
  assert.equal((await invoke('process_status', {})).processes.length, 2);
});

test('timeout and cancellation terminate direct child, preserve terminal status, then allow another command', async (t) => {
  const { invoke } = await fixture(t);
  const command = node('console.log("ready");setInterval(()=>{},1000)');
  const timed = await invoke('exec_command', { command, timeoutMs: 100 });
  assert.equal(timed.terminationReason, 'timeout');
  assert.equal(timed.status, 'terminated');
  // taskkill reports a native exit code, not a POSIX signal, on Windows.
  if (process.platform === 'win32') {
    assert.equal(timed.signal, null);
    assert.equal(typeof timed.exitCode, 'number');
    assert.notEqual(timed.exitCode, 0);
  } else assert.notEqual(timed.signal, null);
  assert.ok(Number.isInteger(timed.pid) && (timed.pid as number) > 0);
  assert.notEqual(timed.finishedAt, null);
  assert.throws(() => process.kill(timed.pid as number, 0), { code: 'ESRCH' });
  const controller = new AbortController();
  const pending = invoke('exec_command', { command }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 100);
  const aborted = await pending;
  clearTimeout(timer);
  assert.equal(aborted.terminationReason, 'cancelled');
  assert.equal(aborted.status, 'terminated');
  assert.ok(Number.isInteger(aborted.pid) && (aborted.pid as number) > 0);
  assert.notEqual(aborted.finishedAt, null);
  assert.throws(() => process.kill(aborted.pid as number, 0), { code: 'ESRCH' });
  assert.equal((await invoke('exec_command', { command: node('console.log("fresh")') })).output.trim(), 'fresh');
});

test('cancelling an output poll does not cancel the background process', async (t) => {
  const { invoke } = await fixture(t);
  const started = await invoke('start_process', { command: node('setInterval(()=>{},1000)') });
  const controller = new AbortController();
  const pending = invoke('read_process', { id: started.id, waitMs: 1000 }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /abort/iu);
  assert.equal((await invoke('process_status', { id: started.id })).status, 'running');
  assert.equal((await invoke('kill_process', { id: started.id })).terminationReason, 'killed');
});

test('host approval observes exact request, cannot mutate execution, and also mediates stdin', async (t) => {
  const requests: string[] = [];
  const { invoke } = await fixture(t, {
    approve: (request) => {
      requests.push(request.action);
      if (request.action === 'write') return false;
      request.command = 'exit 99';
      return true;
    },
  });
  const result = await invoke('exec_command', { command: node('console.log("original")') });
  assert.equal(result.output.trim(), 'original');
  const started = await invoke('start_process', { command: node('process.stdin.resume();setInterval(()=>{},1000)') });
  await assert.rejects(invoke('write_process', { id: started.id, chars: 'x' }), /denied/);
  assert.deepEqual(requests, ['exec', 'start', 'write']);
});

test('denied approval, pre-abort, pending approval and concurrent dispose never launch command', async (t) => {
  const denied = await fixture(t, { approve: () => false });
  await assert.rejects(denied.invoke('exec_command', { command: node('process.exit(99)') }), /denied/);
  assert.deepEqual((await denied.invoke('process_status', {})).processes, []);
  let approvalEntered: () => void = () => {};
  const entered = new Promise<void>((done) => {
    approvalEntered = done;
  });
  const waiting = await fixture(t, {
    approve: async () => {
      approvalEntered();
      await new Promise<void>(() => {});
      return true;
    },
  });
  const pending = waiting.invoke('exec_command', { command: 'echo never' });
  const rejected = assert.rejects(pending, /disposed/);
  await entered;
  await waiting.set.dispose();
  await rejected;
  await assert.rejects(waiting.invoke('exec_command', { command: 'echo never' }), /disposed/);
  assert.deepEqual((await waiting.invoke('process_status', {})).processes, []);
});

test('spawn errors are explicit failures, never null-exit success', async (t) => {
  const { invoke } = await fixture(t, { shell: { command: '/definitely-missing-pure-agent-shell', args: ['-c'] } });
  const result = await invoke('exec_command', { command: 'anything' });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, null);
  assert.match(result.error ?? '', /ENOENT/);
});

test('running concurrency cap and completed retention prevent process/log accumulation', async (t) => {
  const { root, invoke } = await fixture(t, { maxProcesses: 1, maxRetainedProcesses: 1 });
  const first = await invoke('start_process', { command: node('setInterval(()=>{},1000)') });
  await assert.rejects(invoke('start_process', { command: 'echo never' }), /Too many running/);
  await invoke('kill_process', { id: first.id });
  const next = await invoke('exec_command', { command: node('console.log("new")') });
  assert.equal((await invoke('process_status', {})).processes.length, 1);
  await assert.rejects(invoke('process_status', { id: first.id }), /Unknown or expired/);
  await assert.rejects(stat(join(root, first.logPath)), /ENOENT/);
  assert.ok((await stat(join(root, next.logPath))).isFile());
});

test('disposal owns all background jobs and is idempotent', async (t) => {
  const { invoke, set } = await fixture(t);
  const jobs = await Promise.all(
    [1, 2, 3].map(() => invoke('start_process', { command: node('setInterval(()=>{},1000)') })),
  );
  await Promise.all([set.dispose(), set.dispose()]);
  for (const job of jobs) {
    const status = await invoke('process_status', { id: job.id });
    assert.equal(status.status, 'terminated');
    assert.equal(status.terminationReason, 'disposed');
    assert.notEqual(status.finishedAt, null);
  }
});

test('host env is snapshotted; inherited credential names are removed unless explicitly granted', async (t) => {
  // Synthetic values only. Never inspect or publish real credentials in test output.
  const old = process.env.PURE_TEST_API_KEY;
  process.env.PURE_TEST_API_KEY = 'synthetic';
  try {
    const env = { PURE_TEST_MESSAGE: 'before' };
    const { invoke } = await fixture(t, { env });
    env.PURE_TEST_MESSAGE = 'after';
    const result = await invoke('exec_command', {
      command: node(
        'console.log(JSON.stringify({key:process.env.PURE_TEST_API_KEY,msg:process.env.PURE_TEST_MESSAGE}))',
      ),
    });
    assert.deepEqual(JSON.parse(result.output), { msg: 'before' });
    const explicit = await fixture(t, { inheritEnv: false, env: { PURE_TEST_API_KEY: 'granted' } });
    assert.equal(
      (
        await explicit.invoke('exec_command', { command: node('console.log(process.env.PURE_TEST_API_KEY)') })
      ).output.trim(),
      'granted',
    );
  } finally {
    if (old === undefined) delete process.env.PURE_TEST_API_KEY;
    else process.env.PURE_TEST_API_KEY = old;
  }
});

test('artifacts cannot traverse workspace directory symlinks or Windows junctions', async (t) => {
  const { root, invoke } = await fixture(t);
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'pure-process-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'sentinel.txt'), 'untouched');
  // Directory junctions do not require Windows symlink privileges.
  await symlink(outside, join(root, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(invoke('exec_command', { command: 'echo never' }), /symlinks/);
  assert.deepEqual(await readdir(outside), ['sentinel.txt']);
  assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'untouched');
  assert.deepEqual((await invoke('process_status', {})).processes, []);
});

test('public tools validate direct SDK calls and configuration eagerly', async (t) => {
  const { root, invoke } = await fixture(t);
  for (const args of [
    {},
    { command: '' },
    { command: 'x\0' },
    { command: 'x', timeoutMs: 0 },
    { command: 'x', extra: 1 },
    { command: 'x', shell: 'sh' },
  ])
    await assert.rejects(invoke('exec_command', args), /Invalid tool arguments/);
  for (const options of [
    { root: '.' },
    { root, maxOutputBytes: 0 },
    { root, maxProcesses: NaN },
    { root, artifactsDir: '..' },
    { root, env: { x: 'a\0' } },
  ])
    assert.throws(() => createProcessTools(options));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(invoke('exec_command', { command: 'never' }, { signal: aborted.signal }), /abort/iu);
});

test('no network policy or filesystem jail is implied by cwd checks', async (t) => {
  const { root, invoke } = await fixture(t);
  await writeFile(join(root, 'normal.txt'), 'allowed ordinary workspace content');
  const result = await invoke('exec_command', {
    command: node(
      'const fs=require("node:fs");console.log(fs.readFileSync("normal.txt","utf8"));console.log(typeof require("node:net").createServer)',
    ),
  });
  assert.match(result.output, /allowed ordinary workspace content\nfunction/);
});

test('inherited Node test harness markers cannot silently suppress child test execution', async (t) => {
  const { root, invoke } = await fixture(t);
  await writeFile(
    join(root, 'failing.test.cjs'),
    'const test=require("node:test");test("real child test",()=>{throw new Error("EXPECTED_CHILD_FAILURE")});',
  );
  const result = await invoke('exec_command', { command: `${quote(process.execPath)} --test failing.test.cjs` });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /EXPECTED_CHILD_FAILURE/);
  assert.doesNotMatch(result.output, /node:test run\(\) is being called recursively/);
});

test('write approval is interrupted by owner disposal without submitting stdin', async (t) => {
  let beginApproval: () => void = () => {};
  const entered = new Promise<void>((done) => {
    beginApproval = done;
  });
  const { invoke, set } = await fixture(t, {
    approve: async (request) => {
      if (request.action !== 'write') return true;
      beginApproval();
      await new Promise<void>(() => {});
      return true;
    },
  });
  const job = await invoke('start_process', { command: node('process.stdin.resume();setInterval(()=>{},1000)') });
  const write = invoke('write_process', { id: job.id, chars: 'never' });
  const rejected = assert.rejects(write, /disposed/);
  await entered;
  await set.dispose();
  await rejected;
});

test('large output drains both streams with backpressure and preserves full logs', async (t) => {
  const { root, invoke } = await fixture(t, { maxOutputBytes: 256 });
  const result = await invoke('exec_command', {
    command: node(
      'const b=Buffer.alloc(1024*1024,65);for(let i=0;i<3;i++){process.stdout.write(b);process.stderr.write(b)}',
    ),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.totalOutputBytes, 6 * 1024 * 1024);
  assert.equal(result.logBytes, result.totalOutputBytes);
  assert.equal(result.logComplete, true);
  assert.equal((await stat(join(root, result.logPath))).size, result.totalOutputBytes);
  assert.ok(Buffer.byteLength(result.output) <= 256);
});
