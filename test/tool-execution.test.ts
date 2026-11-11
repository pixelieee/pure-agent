import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentEvent, Tool, ToolCall, ToolHooks } from '../src/core.ts';
import { validateAgentSnapshot } from '../src/core.ts';
import { authorizeTool } from '../src/tool-authorization.ts';
import { executeToolCalls, registerTools, validateToolConcurrency } from '../src/tool-execution.ts';
import { createProcessTools } from '../src/tools/process.ts';
import { createFileTools } from '../src/tools/filesystem.ts';

const parameters = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: false,
};
const call = (id: string, name = 'file', path = id): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify({ path }) },
});
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Direct tool-boundary inputs and real temporary files; no model or HTTP responses.
test('bounded overlap, completion events, ordered results and serial barriers', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-parallel-'));
  const entered = [gate(), gate(), gate()];
  const release = [gate(), gate(), gate()];
  let active = 0;
  let maximum = 0;
  const events: AgentEvent[] = [];
  const thirdEnded = gate();
  const tool: Tool = {
    name: 'file',
    description: 'Write independent test files',
    parameters,
    parallelSafe: true,
    async execute({ path }: { path: string }) {
      const index = Number(path);
      active++;
      maximum = Math.max(maximum, active);
      await writeFile(join(root, path), path);
      entered[index]?.resolve();
      await release[index]?.promise;
      active--;
      return readFile(join(root, path), 'utf8');
    },
  };
  const barrier: Tool = {
    name: 'barrier',
    description: 'Inspect completed group',
    parameters,
    async execute() {
      assert.equal(active, 0);
      assert.deepEqual((await readdir(root)).sort(), ['0', '1', '2']);
      await writeFile(join(root, 'barrier'), 'done');
      return 'barrier';
    },
  };
  try {
    const calls = [call('0'), call('1'), call('2'), call('b', 'barrier')];
    const pending = executeToolCalls(
      calls,
      registerTools([tool, barrier]),
      new AbortController().signal,
      async (event) => {
        events.push(event);
        if (event.type === 'tool_end' && event.id === '2') thirdEnded.resolve();
      },
      2,
    );
    await Promise.all([entered[0]?.promise, entered[1]?.promise]);
    assert.equal(active, 2);
    assert.deepEqual((await readdir(root)).sort(), ['0', '1']);
    release[1]?.resolve();
    await entered[2]?.promise;
    release[2]?.resolve();
    await thirdEnded.promise;
    release[0]?.resolve();
    const results = await pending;
    assert.equal(maximum, 2);
    assert.deepEqual(
      results.map((result) => JSON.parse(result)),
      ['0', '1', '2', 'barrier'],
    );
    assert.deepEqual(
      events.filter((event) => event.type === 'tool_end').map((event) => event.id),
      ['1', '2', '0', 'b'],
    );
    validateAgentSnapshot({
      version: 1,
      messages: [
        { role: 'user', content: 'Boundary test' },
        { role: 'assistant', content: null, tool_calls: calls },
        ...calls.map((item, index) => ({ role: 'tool', tool_call_id: item.id, content: results[index] })),
      ],
    });
  } finally {
    for (const item of release) item.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test('abort drains started tools, preserves late success and does not execute pending work', {
  timeout: 5000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-cancel-'));
  const started = gate();
  const cleanup = gate();
  const controller = new AbortController();
  let settled = false;
  const events: AgentEvent[] = [];
  const tool: Tool = {
    name: 'file',
    description: 'Delayed real write',
    parameters,
    parallelSafe: true,
    async execute({ path }: { path: string }) {
      await writeFile(join(root, path), 'once');
      started.resolve();
      await cleanup.promise; // A non-cooperative tool must still be awaited.
      return readFile(join(root, path), 'utf8');
    },
  };
  try {
    const pending = executeToolCalls(
      [call('0'), call('1'), call('2', 'unknown')],
      registerTools([tool]),
      controller.signal,
      async (event) => {
        events.push(event);
      },
    );
    void pending.then(() => {
      settled = true;
    });
    await started.promise;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    cleanup.resolve();
    const results = (await pending).map((result) => JSON.parse(result));
    assert.equal(results[0], 'once');
    assert.deepEqual(results.slice(1), Array(2).fill({ ok: false, error: 'Cancelled before execution' }));
    assert.deepEqual(await readdir(root), ['0']);
    assert.equal(events.filter((event) => event.type === 'tool_start').length, 1);
    assert.equal(events.filter((event) => event.type === 'tool_end').length, 3);
  } finally {
    cleanup.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test('defaults serialize, registry snapshots metadata, validation and observer errors never retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-errors-'));
  let count = 0;
  let active = 0;
  const tool: Tool = {
    name: 'file',
    description: 'Append one real file per execution',
    parameters,
    parallelSafe: true,
    async execute({ path }: { path: string }) {
      assert.equal(active++, 0);
      await writeFile(join(root, path), String(++count));
      active--;
      if (path === 'fail') throw new Error('After write');
      return readFile(join(root, path), 'utf8');
    },
  };
  try {
    const registry = registerTools([tool]);
    tool.parallelSafe = false;
    assert.equal(registry.get('file')?.parallelSafe, true);
    const invalid = call('bad');
    invalid.function.arguments = '{"path":42}';
    const results = await executeToolCalls(
      [call('ok'), call('fail'), invalid, call('missing', 'unknown')],
      registry,
      new AbortController().signal,
      async () => {
        throw new Error('Observer');
      },
    );
    assert.equal(count, 2);
    assert.deepEqual((await readdir(root)).sort(), ['fail', 'ok']);
    assert.equal(JSON.parse(results[0] as string), '1');
    assert.match(results[1] as string, /After write/);
    assert.equal(JSON.parse(results[2] as string).ok, false);
    assert.match(results[3] as string, /Unknown tool/);
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => validateToolConcurrency(value));
    assert.throws(() => registerTools([{ ...tool, parallelSafe: 'yes' as unknown as boolean }]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real built-in reads are opt-in safe; writes remain serial barriers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-builtins-'));
  try {
    const tools = createFileTools({ root });
    assert.deepEqual(
      tools.filter((tool) => tool.parallelSafe).map((tool) => tool.name),
      ['read', 'find', 'ls', 'grep'],
    );
    const calls = [
      {
        ...call('w', 'write'),
        function: { name: 'write', arguments: JSON.stringify({ path: 'a.txt', content: 'hello' }) },
      },
      call('r1', 'read', 'a.txt'),
      call('r2', 'read', 'a.txt'),
    ];
    const results = await executeToolCalls(
      calls,
      registerTools(tools),
      new AbortController().signal,
      async () => {},
      2,
    );
    assert.equal(results.length, 3);
    assert.equal(JSON.parse(results[1] as string).content, 'hello');
    assert.equal(JSON.parse(results[2] as string).content, 'hello');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parallel cancellation waits for both started calls and skips queued calls', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-drain-'));
  const entered = [gate(), gate()];
  const release = [gate(), gate()];
  const controller = new AbortController();
  let settled = false;
  const tool: Tool = {
    name: 'file',
    description: 'Independent writes with cleanup gates',
    parameters,
    parallelSafe: true,
    async execute({ path }: { path: string }, { signal }) {
      const index = Number(path);
      await writeFile(join(root, path), 'started');
      entered[index]?.resolve();
      await release[index]?.promise;
      await writeFile(join(root, path), 'cleaned');
      signal.throwIfAborted();
      return 'done';
    },
  };
  try {
    const pending = executeToolCalls(
      [call('0'), call('1'), call('2')],
      registerTools([tool]),
      controller.signal,
      async () => {},
      2,
    );
    void pending.then(() => {
      settled = true;
    });
    await Promise.all(entered.map((item) => item.promise));
    controller.abort(new Error('Stop'));
    release[0]?.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    release[1]?.resolve();
    const results = await pending;
    assert.deepEqual(
      results.map((result) => JSON.parse(result)),
      [
        { ok: false, error: 'Stop' },
        { ok: false, error: 'Stop' },
        { ok: false, error: 'Cancelled before execution' },
      ],
    );
    assert.deepEqual((await readdir(root)).sort(), ['0', '1']);
    for (const path of ['0', '1']) assert.equal(await readFile(join(root, path), 'utf8'), 'cleaned');
  } finally {
    for (const item of release) item.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime captures callable, name and safety declaration while preserving receiver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-capture-'));
  const decisions: string[] = [];
  const extension: Tool = {
    name: 'file',
    description: 'Captured real file operation',
    parallelSafe: true,
    parameters: structuredClone(parameters),
    async execute({ path }: { path: string }) {
      assert.equal(this, extension);
      await writeFile(join(root, path), 'original');
      return readFile(join(root, path), 'utf8');
    },
  };
  try {
    const wrapped = authorizeTool(extension, root, ({ name }) => {
      decisions.push(name);
      return true;
    });
    const denied = authorizeTool(extension, root, () => false);
    extension.name = 'replacement';
    extension.parallelSafe = false;
    extension.execute = async () => {
      await writeFile(join(root, 'replacement'), 'wrong');
    };
    assert.equal(wrapped.name, 'file');
    assert.equal(wrapped.parallelSafe, true);
    const result = await executeToolCalls(
      [call('original')],
      registerTools([wrapped]),
      new AbortController().signal,
      async () => {},
      2,
    );
    assert.deepEqual(
      result.map((item) => JSON.parse(item)),
      ['original'],
    );
    assert.deepEqual(decisions, ['file']);
    await assert.rejects(
      denied.execute({ path: 'denied' }, { signal: new AbortController().signal }),
      /Permission denied for file/,
    );
    assert.deepEqual(await readdir(root), ['original']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime supports prototype and non-enumerable execute methods with original receivers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-method-'));
  class FileTool implements Tool {
    name = 'file';
    description = 'Real prototype file tool';
    parameters = parameters;
    parallelSafe = true;
    marker = 'prototype';
    async execute({ path }: { path: string }) {
      assert.ok(this instanceof FileTool);
      await writeFile(join(root, path), this.marker);
      return readFile(join(root, path), 'utf8');
    }
  }
  try {
    const prototype = new FileTool();
    const hidden = new FileTool();
    hidden.marker = 'non-enumerable';
    Object.defineProperty(hidden, 'execute', { value: hidden.execute, enumerable: false });
    for (const original of [prototype, hidden]) {
      const wrapped = authorizeTool(original, root, () => true);
      const results = await executeToolCalls(
        [call(original.marker)],
        registerTools([wrapped]),
        new AbortController().signal,
        async () => {},
        2,
      );
      assert.deepEqual(
        results.map((result) => JSON.parse(result)),
        [original.marker],
      );
    }
    assert.deepEqual((await readdir(root)).sort(), ['non-enumerable', 'prototype']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Hooks exercise the production runner, with real filesystem effects and no model.
test('hooks validate first, veto without start, detach inputs and transform completed results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-hooks-'));
  const events: AgentEvent[] = [];
  const before: string[] = [];
  const after: string[] = [];
  const tool: Tool = {
    name: 'file',
    description: 'Write',
    parameters,
    async execute(args: { path: string }) {
      await writeFile(join(root, args.path), args.path);
      args.path = 'tool mutation';
      return { stored: true };
    },
  };
  try {
    const invalid = call('invalid');
    invalid.function.arguments = '{}';
    const results = await executeToolCalls(
      [invalid, call('blocked'), call('allowed')],
      registerTools([tool]),
      new AbortController().signal,
      async (event) => {
        events.push(event);
      },
      1,
      {
        beforeToolCall(input) {
          before.push(input.id);
          (input.args as { path: string }).path = 'hook mutation';
          if (input.id === 'blocked') return { block: true, reason: 'Host veto' };
          return undefined;
        },
        afterToolCall(input) {
          after.push(input.id);
          assert.equal(input.outcome, 'returned');
          assert.deepEqual(input.args, { path: 'allowed' });
          assert.deepEqual(input.result, { stored: true });
          return { result: { summary: 'Stored' } };
        },
      },
    );
    assert.deepEqual(before, ['blocked', 'allowed']);
    assert.deepEqual(after, ['allowed']);
    assert.match(results[1] ?? '', /Host veto/);
    assert.deepEqual(JSON.parse(results[2] ?? ''), { summary: 'Stored' });
    assert.deepEqual(await readdir(root), ['allowed']);
    assert.deepEqual(
      events.filter((e) => e.type === 'tool_start').map((e) => e.id),
      ['allowed'],
    );
    assert.equal(events.filter((e) => e.type === 'tool_end').length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('after hook failure preserves real writes and original success/error/serialization outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-hooks-'));
  const outcomes: string[] = [];
  const events: AgentEvent[] = [];
  const tool: Tool = {
    name: 'file',
    description: 'Write then return or throw',
    parameters,
    async execute({ path }: { path: string }) {
      await writeFile(join(root, path), 'executed once');
      if (path === 'throw') throw new Error('Failed after write');
      if (path === 'circular') {
        const result: { self?: unknown } = {};
        result.self = result;
        return result;
      }
      return { saved: path };
    },
  };
  try {
    const results = await executeToolCalls(
      ['success', 'throw', 'circular'].map((id) => call(id)),
      registerTools([tool]),
      new AbortController().signal,
      async (event) => {
        events.push(event);
      },
      2,
      {
        afterToolCall(input) {
          outcomes.push(input.outcome);
          if (input.result && typeof input.result === 'object') Object.assign(input.result, { corrupted: true });
          throw new Error('Audit unavailable');
        },
      },
    );
    assert.deepEqual(outcomes, ['returned', 'threw', 'serialization_error']);
    assert.deepEqual(JSON.parse(results[0] ?? ''), { saved: 'success' });
    assert.match(results[1] ?? '', /Failed after write/);
    assert.match(results[2] ?? '', /circular/i);
    assert.deepEqual((await readdir(root)).sort(), ['circular', 'success', 'throw']);
    for (const event of events) if (event.type === 'tool_end') assert.equal(event.hookError, 'afterToolCall failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('before hook errors and malformed decisions fail closed; malformed replacements preserve result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-hooks-'));
  const tool: Tool = {
    name: 'file',
    description: 'Write',
    parameters,
    async execute({ path }: { path: string }) {
      await writeFile(join(root, path), 'done');
      return 'done';
    },
  };
  try {
    for (const beforeToolCall of [
      () => {
        throw new Error('Preflight failed');
      },
      () => false,
    ]) {
      const result = await executeToolCalls(
        [call('blocked')],
        registerTools([tool]),
        new AbortController().signal,
        async () => {},
        1,
        {
          // @ts-expect-error Deliberate invalid JavaScript hook contract.
          beforeToolCall,
        },
      );
      assert.equal(JSON.parse(result[0] ?? '').ok, false);
      assert.deepEqual(await readdir(root), []);
    }
    const events: AgentEvent[] = [];
    const result = await executeToolCalls(
      [call('written')],
      registerTools([tool]),
      new AbortController().signal,
      async (event) => {
        events.push(event);
      },
      1,
      { afterToolCall: () => ({ result: 1n }) },
    );
    assert.equal(result[0], '"done"');
    assert.equal(await readFile(join(root, 'written'), 'utf8'), 'done');
    assert.ok(events.some((e) => e.type === 'tool_end' && e.hookError));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parallel hooks occupy bounded slots, drain after abort and retain ordered pairing', {
  timeout: 5000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-hooks-'));
  const controller = new AbortController();
  const started = gate();
  const release = gate();
  const before: string[] = [];
  const after: string[] = [];
  let settled = false;
  const tool: Tool = {
    name: 'file',
    description: 'Write',
    parameters,
    parallelSafe: true,
    async execute({ path }: { path: string }) {
      await writeFile(join(root, path), 'done');
      return path;
    },
  };
  try {
    const pending = executeToolCalls(
      [call('0'), call('1'), call('2')],
      registerTools([tool]),
      controller.signal,
      async () => {},
      2,
      {
        beforeToolCall(input) {
          before.push(input.id);
        },
        async afterToolCall(input, { signal }) {
          after.push(input.id);
          if (after.length === 2) started.resolve();
          await release.promise;
          assert.equal(signal.aborted, true);
          return { result: { saved: input.result } };
        },
      },
    ).then((results) => {
      settled = true;
      return results;
    });
    await started.promise;
    assert.deepEqual(before, ['0', '1']);
    controller.abort();
    assert.equal(settled, false);
    release.resolve();
    const results = await pending;
    assert.deepEqual(
      results.slice(0, 2).map((r) => JSON.parse(r)),
      [{ saved: '0' }, { saved: '1' }],
    );
    assert.match(results[2] ?? '', /Cancelled before execution/);
    assert.deepEqual((await readdir(root)).sort(), ['0', '1']);
  } finally {
    release.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test('abort during before hook drains hook but does not start the tool', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const entered = gate();
  const release = gate();
  const events: AgentEvent[] = [];
  const tool: Tool = {
    name: 'file',
    description: 'Must not run',
    parameters,
    async execute() {
      assert.fail('Cancelled invocation executed');
    },
  };
  const pending = executeToolCalls(
    [call('0')],
    registerTools([tool]),
    controller.signal,
    async (event) => {
      events.push(event);
    },
    1,
    {
      async beforeToolCall() {
        entered.resolve();
        await release.promise;
      },
      afterToolCall() {
        assert.fail('Unexecuted tool reached after hook');
      },
    },
  );
  await entered.promise;
  controller.abort();
  release.resolve();
  assert.match((await pending)[0] ?? '', /Cancelled before execution/);
  assert.deepEqual(
    events.map((e) => e.type),
    ['tool_end'],
  );
});

test('hooks cannot bypass runtime authorization or filesystem containment; process effects survive after failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-hooks-real-'));
  const processes = createProcessTools({ root, inheritEnv: false });
  const trace: string[] = [];
  try {
    const denied = authorizeTool(processes.tools[0] as Tool, root, () => {
      trace.push('authorize');
      return false;
    });
    const command: ToolCall = {
      id: 'command',
      type: 'function',
      function: {
        name: 'exec_command',
        arguments: JSON.stringify({ command: 'printf done > effect.txt' }),
      },
    };
    const hooks = {
      beforeToolCall() {
        trace.push('before');
      },
      afterToolCall() {
        trace.push('after');
        throw new Error('private hook details');
      },
    };
    const result = await executeToolCalls(
      [command],
      registerTools([denied]),
      new AbortController().signal,
      async () => {},
      1,
      hooks,
    );
    assert.match(result[0] ?? '', /Permission denied/);
    assert.deepEqual(trace, ['before', 'authorize', 'after']);
    assert.ok(!(await readdir(root)).includes('effect.txt'));
    const allowed = authorizeTool(processes.tools[0] as Tool, root, () => true);
    const executed = await executeToolCalls(
      [command],
      registerTools([allowed]),
      new AbortController().signal,
      async () => {},
      1,
      hooks,
    );
    assert.equal(JSON.parse(executed[0] ?? '').exitCode, 0);
    assert.equal(await readFile(join(root, 'effect.txt'), 'utf8'), 'done');
    const escaped: ToolCall = {
      id: 'escape',
      type: 'function',
      function: {
        name: 'read',
        arguments: JSON.stringify({ path: '../outside' }),
      },
    };
    const rejected = await executeToolCalls(
      [escaped],
      registerTools(createFileTools({ root })),
      new AbortController().signal,
      async () => {},
      1,
      { beforeToolCall() {} },
    );
    assert.equal(JSON.parse(rejected[0] ?? '').ok, false);
    assert.match(rejected[0] ?? '', /outside|escape/i);
  } finally {
    await processes.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('hook configuration is checked and callback references are captured before scheduling', async () => {
  const entered = gate();
  const release = gate();
  const controller = new AbortController();
  let seen = 0;
  const hooks = {
    async beforeToolCall() {
      seen++;
      entered.resolve();
      await release.promise;
      return { block: true as const };
    },
  };
  const tool: Tool = {
    name: 'file',
    description: 'Never enters after veto',
    parameters,
    async execute() {
      assert.fail('Vetoed tool ran');
    },
  };
  await assert.rejects(
    executeToolCalls(
      [],
      registerTools([]),
      controller.signal,
      async () => {},
      1,
      // @ts-expect-error Invalid JavaScript configuration must fail before scheduling.
      { afterToolCall: true },
    ),
    /afterToolCall must be a function/,
  );
  const pending = executeToolCalls(
    [call('0'), call('1')],
    registerTools([tool]),
    controller.signal,
    async () => {},
    1,
    hooks,
  );
  await entered.promise;
  hooks.beforeToolCall = async () => {
    assert.fail('Replacement callback used');
  };
  release.resolve();
  await pending;
  assert.equal(seen, 2);
});

test('before hook exceptions never expose arbitrary exception text', async () => {
  const sentinel = 'TEST_ONLY_PRIVATE_HOOK_SENTINEL';
  const tool: Tool = {
    name: 'file',
    description: 'Must not execute',
    parameters,
    async execute() {
      assert.fail('Failed hook allowed execution');
    },
  };
  const hooks: ToolHooks[] = [
    {
      beforeToolCall() {
        throw new Error(sentinel);
      },
    },
    {
      async beforeToolCall() {
        throw sentinel;
      },
    },
    {
      beforeToolCall() {
        return {
          block: true,
          get reason(): string {
            throw new Error(sentinel);
          },
        };
      },
    },
  ];
  for (const hook of hooks) {
    const events: AgentEvent[] = [];
    const result = await executeToolCalls(
      [call('0')],
      registerTools([tool]),
      new AbortController().signal,
      async (event) => {
        events.push(event);
      },
      1,
      hook,
    );
    assert.deepEqual(
      result.map((value) => JSON.parse(value)),
      [{ ok: false, error: 'beforeToolCall failed' }],
    );
    assert.ok(!JSON.stringify(events).includes(sentinel));
    assert.deepEqual(
      events.map((event) => event.type),
      ['tool_end'],
    );
  }
});

test('hooks cannot overwrite captured callbacks through their receiver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-hook-receiver-'));
  const seen: string[] = [];
  const receivers: unknown[] = [];
  const hooks: ToolHooks = {
    beforeToolCall(this: ToolHooks | undefined, input) {
      receivers.push(this);
      if (this)
        this.afterToolCall = () => {
          assert.fail('Receiver replaced after callback');
        };
      seen.push(`before:${input.id}`);
    },
    afterToolCall(this: ToolHooks | undefined, input) {
      receivers.push(this);
      if (this)
        this.beforeToolCall = () => {
          assert.fail('Receiver replaced before callback');
        };
      seen.push(`after:${input.id}`);
    },
  };
  const tool: Tool = {
    name: 'file',
    description: 'Write real files',
    parameters,
    async execute({ path }: { path: string }) {
      await writeFile(join(root, path), 'done');
      return path;
    },
  };
  try {
    const result = await executeToolCalls(
      [call('0'), call('1')],
      registerTools([tool]),
      new AbortController().signal,
      async () => {},
      1,
      hooks,
    );
    assert.deepEqual(
      result.map((value) => JSON.parse(value)),
      ['0', '1'],
    );
    assert.deepEqual(seen, ['before:0', 'after:0', 'before:1', 'after:1']);
    assert.deepEqual(receivers, [undefined, undefined, undefined, undefined]);
    assert.deepEqual((await readdir(root)).sort(), ['0', '1']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
