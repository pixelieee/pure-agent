import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgent } from '../src/core.ts';
import type { RunOptions, RunResult } from '../src/core.ts';
import { createSessionStore } from '../src/session.ts';

const badOptions: [string, () => RunOptions][] = [
  ['null options from a JavaScript caller', () => null as unknown as RunOptions],
  [
    'throwing host signal getter',
    () => ({
      get signal(): AbortSignal {
        throw new Error('Signal lookup failed');
      },
    }),
  ],
];

for (const [name, options] of badOptions) {
  for (const seeded of [false, true]) {
    test(`${name} releases the run lock with ${seeded ? 'existing' : 'empty'} history`, async () => {
      let requests = 0;
      const agent = createAgent({
        model: {
          complete: async () => {
            requests++;
            return { role: 'assistant', content: 'Completed' };
          },
        },
      });
      if (seeded) await agent.run('Earlier turn');
      const before = agent.snapshot();
      await assert.rejects(agent.run('Failed preparation', options()));
      assert.equal(requests, seeded ? 1 : 0);
      assert.deepEqual(agent.snapshot(), before);
      agent.restore(before);
      assert.equal((await agent.run('Next turn')).status, 'completed');
      assert.equal(requests, seeded ? 2 : 1);
      assert.deepEqual(agent.snapshot().messages.slice(0, before.messages.length), before.messages);
      assert.equal(
        agent.messages.some((message) => message.content === 'Failed preparation'),
        false,
      );
    });
  }
}

test('preparation remains locked against reentrant run, snapshot, and restore calls', async () => {
  let requests = 0;
  let nested: Promise<RunResult> | undefined;
  const agent = createAgent({
    model: {
      complete: async () => {
        requests++;
        return { role: 'assistant', content: 'Completed' };
      },
    },
  });
  const before = agent.snapshot();
  const options: RunOptions = {
    get signal(): AbortSignal {
      nested = agent.run('Nested run');
      // Attach a rejection handler immediately; inspect the original promise below.
      void nested.catch(() => {});
      assert.throws(() => agent.snapshot(), /while running/);
      assert.throws(() => agent.restore(before), /while running/);
      throw new Error('Signal lookup failed');
    },
  };
  await assert.rejects(agent.run('Outer run', options), /Signal lookup failed/);
  assert.ok(nested);
  await assert.rejects(nested, /already running/);
  assert.equal(requests, 0);
  assert.deepEqual(agent.snapshot(), before);
  agent.restore(before);
  assert.equal((await agent.run('Valid run')).status, 'completed');
  assert.equal(requests, 1);
});

test('a failed preparation leaves disk persistence and later tool effects usable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pure-run-lifecycle-'));
  let requests = 0;
  let effects = 0;
  const agent = createAgent({
    tools: [
      { name: 'effect', description: 'Fixture effect', parameters: { type: 'object' }, execute: async () => ++effects },
    ],
    model: {
      complete: async () =>
        ++requests === 1
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'effect-1', type: 'function', function: { name: 'effect', arguments: '{}' } }],
            }
          : { role: 'assistant', content: 'Completed' },
    },
  });
  const options = {
    path: join(root, 'session.json'),
    identity: { provider: 'fixture', model: 'offline', workspaceRoot: root },
  };
  const store = createSessionStore(options);
  try {
    const original = await store.save(agent.snapshot());
    await assert.rejects(agent.run('Not admitted', badOptions[1][1]()));
    assert.equal(effects, 0);
    const afterFailure = await store.save(agent.snapshot());
    assert.deepEqual(afterFailure.snapshot, original.snapshot);
    assert.equal((await agent.run('Perform one effect')).status, 'completed');
    assert.equal(effects, 1);
    assert.equal(requests, 2);
    const saved = await store.save(agent.snapshot(), { status: 'completed' });
    const loaded = await createSessionStore(options).load();
    assert.deepEqual(loaded.snapshot, saved.snapshot);
    agent.restore(loaded.snapshot);
    assert.equal((await agent.run('Continue without repeating effects')).status, 'completed');
    assert.equal(effects, 1);
    assert.equal(requests, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
