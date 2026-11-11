import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentEvent, Tool, ToolCall } from '../src/core.ts';
import { validateAgentSnapshot } from '../src/core.ts';
import { authorizeTool } from '../src/tool-authorization.ts';
import { executeToolCalls, registerTools, validateToolConcurrency } from '../src/tool-execution.ts';
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
