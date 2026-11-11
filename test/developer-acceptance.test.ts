import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgent, validateAgentSnapshot } from '../src/core.ts';
import type { AgentSnapshot, Message, Tool, ToolCall } from '../src/core.ts';
import { createDeveloperAgent } from '../src/developer-agent.ts';
import type { DeveloperAgentOptions } from '../src/developer-agent.ts';
import { createSessionStore } from '../src/session.ts';
import { createFileTools } from '../src/tools/filesystem.ts';
import { createProcessTools } from '../src/tools/process.ts';
import type { ProcessExecutionResult, ProcessReadResult } from '../src/tools/process.ts';

// Deterministic provider fixtures prove real local effects, never live model reasoning quality.
const context = () => ({ signal: new AbortController().signal });
const quote = (value: string) => (process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`);
const node = (file: string, args: string[] = []) => [quote(process.execPath), ...args, quote(file)].join(' ');
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const call = (name: string, args: unknown, id = name): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (...calls: ToolCall[]): Message => ({ role: 'assistant', content: null, tool_calls: calls });
const final = (): Message => ({ role: 'assistant', content: 'Offline fixture completed.' });
const result = <T>(messages: Message[], id: string): T => {
  const message = messages.findLast((item) => item.role === 'tool' && item.tool_call_id === id);
  assert.ok(message?.content, `Missing tool result: ${id}`);
  return JSON.parse(message.content) as T;
};
async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pure acceptance 空间-')));
  const root = join(parent, 'workspace');
  await mkdir(root);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { root, parent };
}
function invoke<T = Record<string, unknown>>(tools: Tool[], name: string, args: unknown, ctx = context()): Promise<T> {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `Missing public tool: ${name}`);
  return tool.execute(args, ctx) as Promise<T>;
}

// No installed npm packages or network are required by the disposable project.
const broken = 'export function sum(a, b) { return a - b; }\n';
const corrected = 'export function sum(a, b) { return a + b; }\n';
const projectTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import { sum } from '../src/sum.mjs';
test('addition acceptance sentinel', () => assert.equal(sum(2, 3), 5));
`;

test('independent product E2E: create a real project, fail a real test, exact-fix, pass, persist and resume without replay', {
  timeout: 20_000,
}, async (t) => {
  const { root, parent } = await workspace(t);
  const sentinel = join(parent, 'outside.txt');
  await writeFile(sentinel, 'outside must not change');
  const testCommand = node('test/sum.test.mjs', ['--test', '--test-reporter=tap']);
  let step = 0;
  const seen: string[] = [];
  const runtime = createDeveloperAgent({
    root,
    authorize: ({ name }) => {
      seen.push(name);
      return true;
    },
    model: {
      async complete(messages, tools) {
        assert.ok(tools.some((tool) => tool.name === 'exec_command'));
        assert.ok(tools.every((tool) => !Object.hasOwn(tool, 'execute')));
        switch (step++) {
          case 0:
            return reply(
              call('write', { path: 'package.json', content: '{"private":true,"type":"module"}\n' }, 'package'),
              call('write', { path: 'src/sum.mjs', content: broken }, 'source'),
              call('write', { path: 'test/sum.test.mjs', content: projectTest }, 'test'),
            );
          case 1:
            return reply(call('exec_command', { command: testCommand }, 'failing-test'));
          case 2: {
            const failure = result<ProcessExecutionResult>(messages, 'failing-test');
            assert.equal(failure.exitCode, 1);
            assert.match(failure.output, /not ok 1 - addition acceptance sentinel/);
            assert.match(failure.output, /# tests 1/);
            assert.match(failure.output, /# fail 1/);
            return reply(
              call('read', { path: 'src/sum.mjs' }, 'read-source'),
              call('grep', { pattern: 'return a - b', literal: true }, 'search-source'),
              call('find', { pattern: '**/*.mjs' }, 'find-source'),
              call('ls', {}, 'list-root'),
            );
          }
          case 3: {
            const read = result<{ content: string; hash: string }>(messages, 'read-source');
            assert.equal(read.content, broken);
            assert.equal(read.hash, digest(broken));
            assert.equal(
              result<{ matches: { path: string }[] }>(messages, 'search-source').matches[0].path,
              'src/sum.mjs',
            );
            assert.deepEqual(result<{ files: string[] }>(messages, 'find-source').files, [
              'src/sum.mjs',
              'test/sum.test.mjs',
            ]);
            return reply(
              call(
                'edit',
                {
                  path: 'src/sum.mjs',
                  expectedHash: read.hash,
                  edits: [{ oldText: 'return a - b;', newText: 'return a + b;' }],
                },
                'fix-source',
              ),
            );
          }
          case 4:
            return reply(call('exec_command', { command: testCommand }, 'passing-test'));
          case 5: {
            const passing = result<ProcessExecutionResult>(messages, 'passing-test');
            assert.equal(passing.status, 'exited');
            assert.equal(passing.exitCode, 0);
            assert.match(passing.output, /ok 1 - addition acceptance sentinel/);
            assert.match(passing.output, /# tests 1/);
            assert.match(passing.output, /# pass 1/);
            assert.match(passing.output, /# fail 0/);
            return final();
          }
          default:
            throw new Error('Unexpected provider replay');
        }
      },
    },
  });
  t.after(() => runtime.dispose());
  const completed = await runtime.agent.run(
    'Create and test the disposable addition project, then fix its actual failure.',
  );
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(step, 6);
  assert.equal(await readFile(join(root, 'src/sum.mjs'), 'utf8'), corrected);
  assert.equal(await readFile(sentinel, 'utf8'), 'outside must not change');
  const isolatedEnv = { ...process.env };
  delete isolatedEnv.NODE_TEST_CONTEXT;
  const verified = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/sum.test.mjs'], {
    cwd: root,
    env: isolatedEnv,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /# tests 1/);
  assert.match(verified.stdout, /# pass 1/);
  assert.equal(seen.filter((name) => name === 'write').length, 3);
  assert.equal(seen.filter((name) => name === 'edit').length, 1);
  assert.equal(seen.filter((name) => name === 'exec_command').length, 2);

  const identity = { provider: 'offline-fixture', model: 'deterministic', workspaceRoot: root };
  const path = join(parent, 'sessions', 'project.json');
  const store = createSessionStore({ path, identity });
  await store.save(runtime.agent.snapshot(), { status: completed.status });
  await runtime.dispose();
  const savedSource = await stat(join(root, 'src/sum.mjs'));
  const loaded = await createSessionStore({ path, identity }).load();
  let resumedStep = 0;
  const resumedCalls: string[] = [];
  const resumed = createDeveloperAgent({
    root,
    authorize: ({ name }) => {
      resumedCalls.push(name);
      return name === 'read';
    },
    model: {
      async complete(messages) {
        assert.equal(messages.filter((item) => item.role === 'tool' && item.tool_call_id === 'fix-source').length, 1);
        assert.equal(result<ProcessExecutionResult>(messages, 'passing-test').exitCode, 0);
        if (resumedStep++ === 0) return reply(call('read', { path: 'src/sum.mjs' }, 'read-after-resume'));
        assert.equal(result<{ content: string }>(messages, 'read-after-resume').content, corrected);
        return final();
      },
    },
  });
  t.after(() => resumed.dispose());
  resumed.agent.restore(loaded.snapshot);
  assert.equal((await resumed.agent.run('Read the fixed source from this restored session.')).status, 'completed');
  assert.deepEqual(resumedCalls, ['read']);
  assert.equal((await stat(join(root, 'src/sum.mjs'))).mtimeMs, savedSource.mtimeMs);
  assert.equal(await readFile(sentinel, 'utf8'), 'outside must not change');
});

test('independent product policy: denial prevents every mutation and unclassified injected tool, while reads work', async (t) => {
  const { root } = await workspace(t);
  await writeFile(join(root, 'source.txt'), 'original');
  let injected = 0;
  const custom: Tool = {
    name: 'custom_effect',
    description: 'QA effect counter',
    parameters: { type: 'object' },
    execute: async () => {
      injected++;
    },
  };
  let step = 0;
  const runtime = createDeveloperAgent({
    root,
    tools: [custom],
    authorize: ({ name }) => name === 'read',
    model: {
      async complete(messages) {
        if (step++ === 0)
          return reply(
            call('write', { path: 'new/nested.txt', content: 'forbidden' }),
            call('edit', { path: 'source.txt', edits: [{ oldText: 'original', newText: 'forbidden' }] }),
            call('exec_command', { command: 'echo forbidden' }),
            call('start_process', { command: 'echo forbidden' }),
            call('write_process', { id: 'forbidden', chars: 'forbidden' }),
            call('custom_effect', {}),
            call('read', { path: 'source.txt' }),
          );
        for (const name of ['write', 'edit', 'exec_command', 'start_process', 'write_process', 'custom_effect']) {
          assert.match(result<{ error: string }>(messages, name).error, /Permission denied/);
        }
        assert.equal(result<{ content: string }>(messages, 'read').content, 'original');
        return final();
      },
    },
  });
  t.after(() => runtime.dispose());
  const finished = await runtime.agent.run('Attempt operations under host-owned read-only permission.');
  assert.equal(finished.status, 'completed', finished.error);
  assert.deepEqual(await readdir(root), ['source.txt']);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'original');
  assert.equal(injected, 0);
});

test('independent product policy: approval is explicit true, not an accidentally truthy JavaScript value', async (t) => {
  const { root } = await workspace(t);
  const accidental = (() => 'allow') as unknown as DeveloperAgentOptions['authorize'];
  let step = 0;
  const runtime = createDeveloperAgent({
    root,
    authorize: accidental,
    model: {
      complete: async () =>
        step++ === 0 ? reply(call('write', { path: 'should-not-exist.txt', content: 'x' })) : final(),
    },
  });
  t.after(() => runtime.dispose());
  await runtime.agent.run('An invalid approval result must deny effects.');
  assert.deepEqual(await readdir(root), []);
});

test('independent exact-edit acceptance: stale, ambiguous, missing and overlapping edits leave original bytes unchanged', async (t) => {
  const { root } = await workspace(t);
  const tools = createFileTools({ root });
  const path = join(root, 'source.txt');
  const initial = '\uFEFFline one\r\nrepeat repeat\n尾部\r\n';
  await writeFile(path, initial);
  for (const args of [
    { expectedHash: '0'.repeat(64), edits: [{ oldText: 'line one', newText: 'changed' }] },
    { edits: [{ oldText: 'repeat', newText: 'changed' }] },
    { edits: [{ oldText: 'absent', newText: 'changed' }] },
    {
      edits: [
        { oldText: 'line one', newText: 'changed' },
        { oldText: 'one', newText: 'again' },
      ],
    },
  ]) {
    await assert.rejects(invoke(tools, 'edit', { path: 'source.txt', ...args }));
    assert.deepEqual(await readFile(path), Buffer.from(initial));
  }
  await chmod(path, 0o751);
  const beforeMode = (await stat(path)).mode;
  await invoke(tools, 'edit', {
    path: 'source.txt',
    expectedHash: digest(initial),
    edits: [{ oldText: 'line one', newText: 'first line' }],
  });
  assert.deepEqual(await readFile(path), Buffer.from(initial.replace('line one', 'first line')));
  assert.equal((await stat(path)).mode, beforeMode);
  assert.deepEqual(await readdir(root), ['source.txt']);
});

test('independent filesystem containment: escaping symlink/parent paths cannot read, write or create outside directories', async (t) => {
  const { root, parent } = await workspace(t);
  const outside = join(parent, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'evidence.txt'), 'outside sentinel');
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const tools = createFileTools({ root });
  for (const path of ['../outside/evidence.txt', join(outside, 'evidence.txt'), 'escape/evidence.txt']) {
    await assert.rejects(invoke(tools, 'read', { path }));
    await assert.rejects(invoke(tools, 'write', { path, content: 'forbidden' }));
    await assert.rejects(
      invoke(tools, 'edit', { path, edits: [{ oldText: 'outside sentinel', newText: 'forbidden' }] }),
    );
  }
  await assert.rejects(invoke(tools, 'write', { path: 'escape/new/child.txt', content: 'forbidden' }));
  assert.equal(await readFile(join(outside, 'evidence.txt'), 'utf8'), 'outside sentinel');
  assert.deepEqual(await readdir(outside), ['evidence.txt']);
  const preAborted = AbortSignal.abort(new Error('QA pre-abort'));
  await assert.rejects(
    invoke(tools, 'write', { path: 'new/sub/file.txt', content: 'forbidden' }, { signal: preAborted }),
  );
  assert.deepEqual(await readdir(root), ['escape']);
});

test('independent filesystem discovery: useful hidden config, ignore rules and synthetic secret exclusion coexist', async (t) => {
  const { root } = await workspace(t);
  await mkdir(join(root, '.github'));
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, '.github', 'build.yml'), 'public needle\n');
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(root, 'source.txt'), 'public needle\n');
  await writeFile(join(root, 'ignored.txt'), 'ignored needle\n');
  await writeFile(join(root, 'node_modules', 'dependency.js'), 'ignored needle\n');
  // Only a generated non-secret sentinel. Never reads the user's real environment file.
  await writeFile(join(root, '.env'), 'SYNTHETIC_QA_ONLY=needle\n');
  const tools = createFileTools({ root });
  const found = await invoke<{ files: string[] }>(tools, 'find', { pattern: '**/*' });
  assert.deepEqual(found.files, ['.github/build.yml', '.gitignore', 'source.txt']);
  const searched = await invoke<{ matches: { path: string; content: string }[] }>(tools, 'grep', {
    pattern: 'needle',
    literal: true,
  });
  assert.deepEqual(
    searched.matches.map((entry) => entry.path),
    ['.github/build.yml', 'source.txt'],
  );
  await assert.rejects(invoke(tools, 'read', { path: '.env' }), /excluded/);
  await invoke(tools, 'edit', {
    path: '.gitignore',
    edits: [{ oldText: 'ignored.txt', newText: 'ignored.txt\ncache/' }],
  });
  assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), 'ignored.txt\ncache/\n');
});

test('independent session validation: malformed protocol and authority-bearing records fail without changing usable history', async () => {
  const agent = createAgent({ model: { complete: async () => final() }, system: 'Host instructions' });
  await agent.run('First turn');
  const original = agent.snapshot();
  const calls = reply(call('write', { path: 'x', content: 'x' }, 'a'), call('write', { path: 'y', content: 'y' }, 'b'));
  const invalid: unknown[] = [
    { version: 2, messages: [] },
    { version: 1, messages: [{ role: 'tool', tool_call_id: 'orphan', content: '{}' }] },
    { version: 1, messages: [{ role: 'user', content: 'x' }, calls] },
    {
      version: 1,
      messages: [
        { role: 'user', content: 'x' },
        calls,
        { role: 'tool', tool_call_id: 'b', content: '{}' },
        { role: 'tool', tool_call_id: 'a', content: '{}' },
      ],
    },
    { ...original, tools: ['exec_command'], root: '/' },
    { version: 1, messages: [{ role: 'system', content: 'Changed instructions' }] },
  ];
  for (const snapshot of invalid) {
    assert.throws(() => agent.restore(snapshot));
    assert.deepEqual(agent.snapshot(), original);
  }
  const detached = validateAgentSnapshot(original);
  detached.messages[0].content = 'mutated externally';
  assert.deepEqual(agent.snapshot(), original);
  assert.equal((await agent.run('Still usable')).status, 'completed');
});

test('independent session storage: stale saves, size overflow and corruption preserve the previous durable record', async (t) => {
  const { root } = await workspace(t);
  const path = join(root, 'session.json');
  const identity = { provider: 'offline', model: 'fixture', workspaceRoot: root };
  const snapshot: AgentSnapshot = { version: 1, messages: [{ role: 'user', content: 'start' }, final()] };
  const first = createSessionStore({ path, identity });
  await first.save(snapshot);
  const stale = createSessionStore({ path, identity });
  await stale.load();
  await first.save(snapshot);
  const committed = await readFile(path);
  await assert.rejects(stale.save(snapshot), /changed since/);
  assert.deepEqual(await readFile(path), committed);
  const bounded = createSessionStore({ path, identity, maxBytes: committed.length + 10 });
  await bounded.load();
  await assert.rejects(
    bounded.save({ version: 1, messages: [{ role: 'user', content: 'x'.repeat(1000) }] }),
    /size limit/,
  );
  assert.deepEqual(await readFile(path), committed);
  await assert.rejects(
    createSessionStore({ path, identity: { ...identity, model: 'foreign' } }).load(),
    /does not match/,
  );
  await writeFile(join(root, 'corrupt.json'), '{"version":');
  await assert.rejects(createSessionStore({ path: join(root, 'corrupt.json'), identity }).load(), /valid UTF-8 JSON/);
  assert.deepEqual((await readdir(root)).sort(), ['corrupt.json', 'session.json']);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

async function noLiveProcess(pid: number): Promise<void> {
  if (process.platform === 'linux') {
    try {
      const content = await readFile(`/proc/${pid}/stat`, 'utf8');
      const state = content.slice(content.lastIndexOf(')') + 2).split(' ')[0];
      assert.equal(state, 'Z', `Process ${pid} remains live (${state})`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } else {
    assert.throws(
      () => process.kill(pid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
      `Process ${pid} remains live`,
    );
  }
}
async function ready(tools: Tool[], id: string, marker: RegExp) {
  let output = '';
  let cursor = 0;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const page = await invoke<ProcessReadResult>(tools, 'read_process', { id, cursor, waitMs: 200 });
    output += page.output;
    cursor = page.nextCursor;
    if (marker.test(output)) return output;
    assert.equal(page.status, 'running', `Process exited before readiness: ${output}`);
  }
  assert.fail(`No process readiness before deadline: ${output}`);
}

for (const action of ['cancel', 'kill', 'dispose'] as const) {
  test(`independent process acceptance: ${action} stops real descendants and their background writes`, {
    timeout: 15_000,
  }, async (t) => {
    const { root } = await workspace(t);
    const marker = join(root, 'ticks.txt');
    await writeFile(
      join(root, 'leaf.cjs'),
      `const fs=require('node:fs');process.on('SIGTERM',()=>{});console.log('leaf:'+process.pid);setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),20);`,
    );
    await writeFile(
      join(root, 'parent.cjs'),
      `const {spawn}=require('node:child_process');console.log('parent:'+process.pid);spawn(process.execPath,['leaf.cjs'],{stdio:'inherit'});setInterval(()=>{},1000);`,
    );
    const set = createProcessTools({ root, killGraceMs: 40 });
    t.after(() => set.dispose());
    const abort = new AbortController();
    const start = await invoke<ProcessExecutionResult>(
      set.tools,
      'start_process',
      { command: node('parent.cjs') },
      { signal: abort.signal },
    );
    const output = await ready(set.tools, start.id, /leaf:\d+/);
    if (action === 'dispose') await set.dispose();
    else if (action === 'kill') await invoke(set.tools, 'kill_process', { id: start.id });
    else {
      abort.abort();
      let page = await invoke<ProcessReadResult>(set.tools, 'read_process', { id: start.id });
      while (page.status === 'running')
        page = await invoke<ProcessReadResult>(set.tools, 'read_process', {
          id: start.id,
          cursor: page.nextCursor,
          waitMs: 200,
        });
    }
    const status = await invoke<ProcessExecutionResult>(set.tools, 'process_status', { id: start.id });
    assert.notEqual(status.status, 'running');
    assert.equal(
      status.terminationReason,
      action === 'kill' ? 'killed' : action === 'dispose' ? 'disposed' : 'cancelled',
    );
    for (const match of output.matchAll(/(?:parent|leaf):(\d+)/g)) await noLiveProcess(Number(match[1]));
    assert.ok(start.pid);
    assert.throws(
      () => process.kill(start.pid as number, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
    );
    const before = await readFile(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return Buffer.alloc(0);
    });
    await delay(100);
    const after = await readFile(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return Buffer.alloc(0);
    });
    assert.deepEqual(after, before, 'Descendant kept writing after terminal result');
    if (action !== 'dispose') {
      await writeFile(join(root, 'after.cjs'), 'console.log("subsequent command works")');
      const next = await invoke<ProcessExecutionResult>(set.tools, 'exec_command', { command: node('after.cjs') });
      assert.equal(next.exitCode, 0);
      assert.match(next.output, /subsequent command works/);
    }
  });
}

test('independent process acceptance: a real test runner is not disabled by parent test-runner environment', {
  timeout: 10_000,
}, async (t) => {
  const { root } = await workspace(t);
  await writeFile(
    join(root, 'failure.test.cjs'),
    `require('node:test')('independent failure sentinel',()=>require('node:assert/strict').equal(1,2));`,
  );
  const set = createProcessTools({ root });
  t.after(() => set.dispose());
  const execution = await invoke<ProcessExecutionResult>(set.tools, 'exec_command', {
    command: node('failure.test.cjs', ['--test', '--test-reporter=tap']),
  });
  assert.equal(execution.exitCode, 1);
  assert.match(execution.output, /not ok 1 - independent failure sentinel/);
  assert.match(execution.output, /# tests 1/);
  assert.match(execution.output, /# fail 1/);
});

test('independent process acceptance: timeout stops ready descendants before the foreground promise settles', {
  timeout: 15_000,
}, async (t) => {
  const { root } = await workspace(t);
  await writeFile(
    join(root, 'leaf.cjs'),
    `process.on('SIGTERM',()=>{});console.log('leaf:'+process.pid);setInterval(()=>{},1000);`,
  );
  await writeFile(
    join(root, 'parent.cjs'),
    `const {spawn}=require('node:child_process');console.log('parent:'+process.pid);spawn(process.execPath,['leaf.cjs'],{stdio:'inherit'});setInterval(()=>{},1000);`,
  );
  const set = createProcessTools({ root, killGraceMs: 40 });
  t.after(() => set.dispose());
  const execution = await invoke<ProcessExecutionResult>(set.tools, 'exec_command', {
    command: node('parent.cjs'),
    timeoutMs: 2000,
  });
  assert.equal(execution.terminationReason, 'timeout');
  assert.match(execution.output, /leaf:\d+/);
  for (const match of execution.output.matchAll(/(?:parent|leaf):(\d+)/g)) await noLiveProcess(Number(match[1]));
});

test('independent process acceptance: parent exiting first does not leave a live inherited-pipe writer', {
  timeout: 15_000,
}, async (t) => {
  const { root } = await workspace(t);
  await writeFile(
    join(root, 'leaf.cjs'),
    `process.on('SIGTERM',()=>{});process.send(process.pid);setInterval(()=>process.stdout.write('tick\\n'),20);`,
  );
  await writeFile(
    join(root, 'parent.cjs'),
    `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['leaf.cjs'],{stdio:['ignore','inherit','inherit','ipc']});child.once('message',pid=>{console.log('leaf:'+pid);process.exit(0)});`,
  );
  const set = createProcessTools({ root, killGraceMs: 40 });
  t.after(() => set.dispose());
  const execution = await invoke<ProcessExecutionResult>(set.tools, 'exec_command', { command: node('parent.cjs') });
  const child = execution.output.match(/leaf:(\d+)/);
  assert.ok(child, execution.output);
  const pid = Number(child[1]);
  // If an implementation fails, still avoid leaving the synthetic fixture running.
  t.after(async () => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  });
  await noLiveProcess(pid);
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.cleanupWarning, undefined);
});

test('independent process acceptance: bounded output stays complete in raw logs and reports deliberate output termination', {
  timeout: 10_000,
}, async (t) => {
  const { root } = await workspace(t);
  await writeFile(
    join(root, 'output.cjs'),
    `process.stdout.write('a'.repeat(20000));process.stderr.write('b'.repeat(20000));`,
  );
  const set = createProcessTools({ root, maxOutputBytes: 100, maxLogBytes: 50000, killGraceMs: 40 });
  t.after(() => set.dispose());
  const execution = await invoke<ProcessExecutionResult>(set.tools, 'exec_command', { command: node('output.cjs') });
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.totalOutputBytes, 40000);
  assert.equal(execution.stdoutBytes, 20000);
  assert.equal(execution.stderrBytes, 20000);
  assert.ok(Buffer.byteLength(execution.output) <= 100);
  assert.equal(execution.truncated, true);
  assert.equal((await readFile(join(root, execution.logPath))).length, 40000);
  await writeFile(join(root, 'flood.cjs'), `setInterval(()=>process.stdout.write('x'.repeat(10000)),1);`);
  const flooded = await invoke<ProcessExecutionResult>(set.tools, 'exec_command', { command: node('flood.cjs') });
  assert.equal(flooded.terminationReason, 'output_limit');
  assert.ok(flooded.logBytes <= 50000);
  assert.ok(flooded.pid);
  await noLiveProcess(flooded.pid);
});

test('independent product policy: invalid hook types fail at construction and nonboolean results cannot authorize', async (t) => {
  const { root } = await workspace(t);
  for (const value of [false, null, 'allow', {}]) {
    assert.throws(
      () =>
        createDeveloperAgent({
          root,
          model: { complete: async () => final() },
          authorize: value as unknown as DeveloperAgentOptions['authorize'],
        }),
      /authorize must be a function/,
    );
    let step = 0;
    const runtime = createDeveloperAgent({
      root,
      authorize: (() => value) as unknown as DeveloperAgentOptions['authorize'],
      model: {
        complete: async () => (step++ === 0 ? reply(call('write', { path: 'denied.txt', content: 'x' })) : final()),
      },
    });
    t.after(() => runtime.dispose());
    await runtime.agent.run('Check invalid permission callback result.');
    assert.deepEqual(await readdir(root), []);
  }
});

test('independent product policy: caller mutations cannot change the authorization workspace or callback', async (t) => {
  const { root, parent } = await workspace(t);
  let step = 0;
  const decisions: string[] = [];
  const options: DeveloperAgentOptions = {
    root,
    model: {
      complete: async () =>
        step++ === 0 ? reply(call('write', { path: 'safe.txt', content: 'original args' })) : final(),
    },
    authorize: (request) => {
      decisions.push(request.workspaceRoot);
      assert.equal(request.workspaceRoot, root);
      (request.args as { content: string }).content = 'mutated approval args';
      return false;
    },
  };
  const runtime = createDeveloperAgent(options);
  t.after(() => runtime.dispose());
  options.root = parent;
  options.authorize = () => true;
  await runtime.agent.run('Host decisions retain original authority.');
  assert.deepEqual(decisions, [root]);
  assert.deepEqual(await readdir(root), []);
});

test('optional root paths reach authorization as originally validated, without argument normalization', async (t) => {
  const { root } = await workspace(t);
  await writeFile(join(root, 'sentinel.txt'), 'needle');
  const calls: { name: string; args: { path?: string; pattern?: string } }[] = [];
  for (const name of ['find', 'ls', 'grep']) {
    for (const path of [undefined, '', '.', './']) {
      const args = { ...(name === 'ls' ? {} : { pattern: name === 'find' ? '*.txt' : 'needle' }) };
      calls.push({ name, args: path === undefined ? args : { ...args, path } });
    }
  }
  const invalid = [
    call('find', { path: null, pattern: '*' }, 'bad-find'),
    call('ls', { path: false }, 'bad-ls'),
    call('grep', { path: 0, pattern: 'needle' }, 'bad-grep'),
    call('read', { path: '' }, 'bad-read'),
    call('write', { path: '', content: 'changed' }, 'bad-write'),
    call('edit', { path: '', edits: [{ oldText: 'needle', newText: 'changed' }] }, 'bad-edit'),
  ];
  const seen: { name: string; args: unknown }[] = [];
  let step = 0;
  const runtime = createDeveloperAgent({
    root,
    authorize: ({ name, args }) => {
      seen.push({ name, args: structuredClone(args) });
      return true;
    },
    model: {
      async complete(messages) {
        if (step++ === 0) return reply(...calls.map(({ name, args }, i) => call(name, args, `ok-${i}`)), ...invalid);
        for (let i = 0; i < calls.length; i++) {
          const payload = result<{ path: string; error?: string }>(messages, `ok-${i}`);
          assert.equal(payload.error, undefined);
          assert.equal(payload.path, '.');
        }
        for (const { id } of invalid) {
          const payload = result<{ ok: boolean; error: string }>(messages, id);
          assert.equal(payload.ok, false);
          assert.match(payload.error, /Invalid tool arguments/u);
        }
        return final();
      },
    },
  });
  t.after(() => runtime.dispose());
  const completed = await runtime.agent.run('Search the fixture using equivalent root paths.');
  assert.equal(completed.status, 'completed', completed.error);
  assert.deepEqual(seen, calls);
  assert.equal(await readFile(join(root, 'sentinel.txt'), 'utf8'), 'needle');
});

test('host authorization can distinguish and deny an empty discovery path', async (t) => {
  const { root } = await workspace(t);
  await writeFile(join(root, 'sentinel.txt'), 'needle');
  const seen: unknown[] = [];
  let step = 0;
  const runtime = createDeveloperAgent({
    root,
    authorize: ({ args }) => {
      seen.push(structuredClone(args));
      return !Object.hasOwn(args as object, 'path');
    },
    model: {
      async complete(messages) {
        if (step++ === 0) return reply(call('ls', {}, 'omitted'), call('ls', { path: '' }, 'empty'));
        assert.equal(result<{ path: string }>(messages, 'omitted').path, '.');
        const denied = result<{ ok: boolean; error: string; entries?: unknown }>(messages, 'empty');
        assert.equal(denied.ok, false);
        assert.match(denied.error, /Permission denied/u);
        assert.equal(denied.entries, undefined);
        return final();
      },
    },
  });
  t.after(() => runtime.dispose());
  assert.equal((await runtime.agent.run('Inspect only explicitly authorized discovery calls.')).status, 'completed');
  assert.deepEqual(seen, [{}, { path: '' }]);
});
