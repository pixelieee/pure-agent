import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../src/core.ts';
import { createDeveloperAgent } from '../src/developer-agent.ts';
import { SessionController, type SessionPersistence } from '../src/ui/controller.ts';
import { TerminalView } from '../src/ui/view.ts';

function capture() {
  let output = '';
  return {
    view: new TerminalView({
      write: (text) => {
        output += text;
      },
    }),
    text: () => output,
  };
}
const model = { complete: async () => ({ role: 'assistant' as const, content: 'done' }) };

test('new, create and quit await disposal of their prior managed process owners', async () => {
  const out = capture();
  const disposed: number[] = [];
  let created = 0;
  let resets = 0;
  const controller = new SessionController(
    (system) => {
      const id = ++created;
      return {
        agent: createAgent({ system, model }),
        dispose: async () => {
          disposed.push(id);
        },
      };
    },
    out.view,
    {
      defaultSystem: 'host instructions',
      persistence: {
        save: async () => undefined,
        load: async () => ({ snapshot: { version: 1, messages: [] } }),
        reset: () => {
          resets++;
        },
      },
    },
  );
  await controller.submit('/new');
  assert.deepEqual(disposed, [1]);
  await controller.submit('/create different instructions');
  assert.deepEqual(disposed, [1, 2]);
  assert.equal(resets, 2);
  await controller.submit('/quit');
  await controller.dispose();
  assert.deepEqual(disposed, [1, 2, 3]);
  assert.equal(controller.closed, true);
});

test('autosave runs after core becomes idle and failures never replay model or tool effects', async () => {
  const out = capture();
  let effects = 0;
  let calls = 0;
  let saves = 0;
  let failSave = true;
  const controller = new SessionController(
    (system) =>
      createAgent({
        system,
        tools: [
          {
            name: 'effect',
            description: 'count',
            parameters: { type: 'object', additionalProperties: false },
            execute: async () => ({ count: ++effects }),
          },
        ],
        model: {
          complete: async () => {
            calls++;
            return calls % 2 === 1
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: `call-${calls}`, type: 'function', function: { name: 'effect', arguments: '{}' } },
                  ],
                }
              : { role: 'assistant', content: 'done' };
          },
        },
      }),
    out.view,
    {
      defaultSystem: 'host instructions',
      persistence: {
        save: async (agent, _path, result) => {
          saves++;
          assert.ok(agent.snapshot().messages.length > 0, 'snapshot must be taken only after agent.run resolves');
          if (result) assert.equal(result.status, 'completed');
          if (failSave) throw new Error('disk unavailable');
          return 'private-session.json';
        },
        load: async () => ({ snapshot: { version: 1, messages: [] } }),
        reset: () => {},
      },
    },
  );
  assert.equal((await controller.submit('first'))?.status, 'completed');
  assert.equal(controller.exitCode, 1);
  assert.equal(effects, 1);
  assert.equal(calls, 2);
  assert.equal(saves, 1);
  assert.match(out.text(), /Session save failed/);
  failSave = false;
  await controller.submit('/save');
  assert.equal(effects, 1);
  assert.equal(calls, 2);
  assert.equal(saves, 2);
  assert.equal((await controller.submit('second'))?.status, 'completed');
  assert.equal(controller.exitCode, 0);
  assert.equal(effects, 2);
  assert.equal(calls, 4);
  await controller.dispose();
});

test('failed resume keeps the active session usable and disposes only its rejected candidate', async () => {
  const out = capture();
  const disposed: number[] = [];
  const histories: string[][] = [];
  let created = 0;
  let resets = 0;
  const storage: SessionPersistence = {
    save: async () => undefined,
    load: async () => ({
      snapshot: { version: 1, messages: [{ role: 'system', content: 'incompatible host instructions' }] },
    }),
    reset: () => {
      resets++;
    },
  };
  const controller = new SessionController(
    (system) => {
      const id = ++created;
      return {
        agent: createAgent({
          system,
          model: {
            complete: async (messages) => {
              histories.push(
                messages.filter((message) => message.role === 'user').map((message) => message.content ?? ''),
              );
              return { role: 'assistant', content: 'done' };
            },
          },
        }),
        dispose: async () => {
          disposed.push(id);
        },
      };
    },
    out.view,
    { defaultSystem: 'host instructions', persistence: storage },
  );
  await controller.submit('before');
  await controller.submit('/resume corrupt.json');
  assert.deepEqual(disposed, [2]);
  assert.equal(resets, 0);
  await controller.submit('after');
  assert.deepEqual(histories, [['before'], ['before', 'after']]);
  assert.match(out.text(), /Snapshot system message is incompatible/);
  await controller.dispose();
  assert.deepEqual(disposed, [2, 1]);
});

test('save and resume operations participate in busy guards without replacing live state', async () => {
  const out = capture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let created = 0;
  const controller = new SessionController(
    (system) => {
      created++;
      return createAgent({ system, model });
    },
    out.view,
    {
      defaultSystem: 'host instructions',
      persistence: {
        save: async () => {
          await gate;
          return 'private.json';
        },
        load: async () => ({ snapshot: { version: 1, messages: [] } }),
        reset: () => {},
      },
    },
  );
  const saving = controller.submit('/save private.json');
  assert.equal(controller.busy, true);
  for (const command of ['/new', '/create changed', '/resume other.json', 'run']) await controller.submit(command);
  controller.interrupt();
  assert.equal(controller.closed, false);
  assert.equal(created, 1);
  release();
  await saving;
  assert.equal(controller.busy, false);
  assert.match(out.text(), /Waiting for the session operation/);
  assert.equal((out.text().match(/A run is already active/g) ?? []).length, 4);
  await controller.dispose();
});

test('controller cancellation stops a real managed command before accepting the next turn', async () => {
  const out = capture();
  const root = await mkdtemp(join(tmpdir(), 'pure-ui-cancel-'));
  await writeFile(
    join(root, 'writer.cjs'),
    "const fs = require('node:fs');\nfs.writeFileSync('ready.txt', 'ready');\nsetInterval(() => fs.writeFileSync('marker.txt', String(Date.now())), 10);\n",
  );
  let calls = 0;
  const controller = new SessionController(
    (system) =>
      createDeveloperAgent({
        root,
        system,
        authorize: ({ name }) => name === 'exec_command',
        model: {
          complete: async () => {
            calls++;
            return calls === 1
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'run',
                      type: 'function',
                      function: {
                        name: 'exec_command',
                        arguments: JSON.stringify({ command: `${JSON.stringify(process.execPath)} writer.cjs` }),
                      },
                    },
                  ],
                }
              : { role: 'assistant', content: 'Recovered after cancellation.' };
          },
        },
      }),
    out.view,
  );
  try {
    const running = controller.submit('start command');
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await readFile(join(root, 'marker.txt'));
        break;
      } catch {
        if (Date.now() > deadline) assert.fail('managed command did not become ready');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    controller.interrupt();
    assert.equal((await running)?.status, 'cancelled');
    const lastMarker = await readFile(join(root, 'marker.txt'), 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await readFile(join(root, 'marker.txt'), 'utf8'), lastMarker);
    assert.equal(controller.busy, false);
    assert.equal((await controller.submit('continue'))?.status, 'completed');
    assert.match(out.text(), /Recovered after cancellation/);
  } finally {
    await controller.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
