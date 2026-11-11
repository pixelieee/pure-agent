import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeveloperAgent, type DeveloperAgentOptions } from '../src/developer-agent.ts';
import type { Message, ToolCall } from '../src/core.ts';

const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (...tool_calls: ToolCall[]): Message => ({ role: 'assistant', content: null, tool_calls });
const done: Message = { role: 'assistant', content: 'Fixture finished.' };

for (const mode of ['omitted', 'undefined'] as const) {
  test(`SDK ${mode} policy permits registered read/write/process/custom tools`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pure-sdk-open-'));
    let customCalls = 0;
    let step = 0;
    const runtime = createDeveloperAgent({
      root,
      ...(mode === 'undefined' ? { authorize: undefined } : {}),
      tools: [
        {
          name: 'custom_effect',
          description: '',
          parameters: { type: 'object' },
          execute: async () => {
            customCalls++;
            return { fixture: true };
          },
        },
      ],
      model: {
        complete: async (messages) => {
          if (step++ === 0)
            return reply(
              call('read', 'ls', {}),
              call('write', 'write', { path: 'write.txt', content: 'write sentinel' }),
              call('exec', 'exec_command', {
                command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('exec.txt','exec sentinel')"`,
              }),
              call('custom', 'custom_effect', {}),
            );
          const results = messages.filter((message) => message.role === 'tool');
          assert.equal(results.length, 4);
          for (const result of results) assert.notEqual(JSON.parse(result.content ?? '{}').ok, false);
          assert.equal(JSON.parse(results[2].content ?? '{}').exitCode, 0);
          return done;
        },
      },
    });
    t.after(async () => {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    });
    assert.equal((await runtime.agent.run('Exercise default registered tools')).status, 'completed');
    assert.equal(step, 2);
    assert.equal(customCalls, 1);
    assert.equal(await readFile(join(root, 'write.txt'), 'utf8'), 'write sentinel');
    assert.equal(await readFile(join(root, 'exec.txt'), 'utf8'), 'exec sentinel');
  });
}

for (const rejection of ['throw', 'reject'] as const) {
  test(`SDK explicit policy ${rejection} cannot fall back to default access`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pure-sdk-policy-error-'));
    let decisions = 0;
    let step = 0;
    const runtime = createDeveloperAgent({
      root,
      authorize: () => {
        decisions++;
        if (rejection === 'throw') throw new Error('Policy unavailable');
        return Promise.reject(new Error('Policy unavailable'));
      },
      model: {
        complete: async () => (step++ ? done : reply(call('write', 'write', { path: 'denied.txt', content: 'no' }))),
      },
    });
    t.after(async () => {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    });
    assert.equal((await runtime.agent.run('Do not bypass policy')).status, 'completed');
    assert.equal(decisions, 1);
    assert.match(
      runtime.agent.messages.find((message) => message.role === 'tool')?.content ?? '',
      /Policy unavailable/,
    );
    assert.deepEqual(await readdir(root), []);
  });
}

test('SDK default access still rejects unknown tools, invalid parameters and filesystem traversal', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'pure-sdk-tool-boundaries-'));
  const root = join(parent, 'workspace');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root);
  await writeFile(join(parent, 'outside.txt'), 'untouched');
  let step = 0;
  const runtime = createDeveloperAgent({
    root,
    model: {
      complete: async () =>
        step++
          ? done
          : reply(
              call('unknown', 'not_registered', {}),
              call('schema', 'write', { path: 'invalid.txt', content: 12 }),
              call('escape', 'write', { path: '../outside.txt', content: 'changed' }),
            ),
    },
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(parent, { recursive: true, force: true });
  });
  assert.equal((await runtime.agent.run('Exercise unchanged tool boundaries')).status, 'completed');
  const results = runtime.agent.messages.filter((message) => message.role === 'tool');
  assert.equal(results.length, 3);
  for (const result of results) assert.equal(JSON.parse(result.content ?? '{}').ok, false);
  assert.deepEqual(await readdir(root), []);
  assert.equal(await readFile(join(parent, 'outside.txt'), 'utf8'), 'untouched');
});

test('SDK default access still honors cancellation before tools and disposal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pure-sdk-cancel-'));
  const abort = new AbortController();
  let effects = 0;
  const runtime = createDeveloperAgent({
    root,
    tools: [
      {
        name: 'effect',
        description: '',
        parameters: { type: 'object' },
        execute: async () => {
          effects++;
        },
      },
    ],
    model: { complete: async () => reply(call('effect', 'effect', {})) },
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(
    (
      await runtime.agent.run('Cancel before execution', {
        signal: abort.signal,
        onEvent(event) {
          if (event.type === 'tool_start') abort.abort();
        },
      })
    ).status,
    'cancelled',
  );
  assert.equal(effects, 0);
  assert.match(runtime.agent.messages.at(-1)?.content ?? '', /Cancelled/);
  await runtime.dispose();
  assert.equal((await runtime.agent.run('Disposed runtime')).status, 'cancelled');
  assert.equal(effects, 0);
});

test('SDK invalid policy values are rejected at construction rather than treated as omission', () => {
  for (const authorize of [null, false, 'allow', {}])
    assert.throws(
      () =>
        createDeveloperAgent({
          root: process.cwd(),
          model: { complete: async () => done },
          authorize: authorize as unknown as DeveloperAgentOptions['authorize'],
        }),
      /authorize must be a function/,
    );
});

test('SDK captures an explicit policy once so changing accessors cannot turn denial into omission', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pure-sdk-policy-capture-'));
  let reads = 0;
  let step = 0;
  const options: DeveloperAgentOptions = {
    root,
    model: {
      complete: async () => (step++ ? done : reply(call('write', 'write', { path: 'denied.txt', content: 'no' }))),
    },
    get authorize() {
      reads++;
      return reads < 3 ? () => false : undefined;
    },
  };
  const runtime = createDeveloperAgent(options);
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(reads, 1);
  assert.equal((await runtime.agent.run('Keep the selected policy')).status, 'completed');
  assert.match(runtime.agent.messages.find((message) => message.role === 'tool')?.content ?? '', /Permission denied/);
  assert.deepEqual(await readdir(root), []);
  assert.equal(reads, 1);
});
