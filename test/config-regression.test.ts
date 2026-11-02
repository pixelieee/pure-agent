import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { DEFAULT_CONFIG, loadConfig, resolveConfig } from '../src/config.ts';
import { createProjectAgent, PROJECT_FILES, PROJECT_SYSTEM } from '../src/project-agent.ts';
import { SessionController } from '../src/ui/controller.ts';
import { TerminalView } from '../src/ui/view.ts';
import type { Model } from '../src/core.ts';

async function fixture(body: string | Uint8Array = '{}') {
  const root = await mkdtemp(join(tmpdir(), 'pure-config-qa-'));
  const path = join(root, 'explicit.json');
  await writeFile(path, body);
  await writeFile(join(root, 'README.md'), 'Public offline test evidence.');
  return { root, path, clean: () => rm(root, { recursive: true, force: true }) };
}
const dummyKey = 'invalid-offline-placeholder';
const secret = 'DUMMY_SENSITIVE_VALUE_DO_NOT_ECHO';

test('config defaults are explicit, bounded and immutable without mutating caller input', () => {
  const input = {
    system: '简洁回答 🧪',
    model: 'offline-model',
    reasoning: 'medium' as const,
    maxSteps: 12,
    maxOutputTokens: 2048,
  };
  const original = structuredClone(input);
  const resolved = resolveConfig(input);
  assert.deepEqual(input, original);
  assert.deepEqual(resolved, original);
  assert.notEqual(resolved, input);
  assert.equal(Object.isFrozen(resolved), true);
  input.model = 'changed-after-resolution';
  assert.equal(resolved.model, 'offline-model');
  assert.deepEqual(resolveConfig(), DEFAULT_CONFIG);
  assert.equal(DEFAULT_CONFIG.system, PROJECT_SYSTEM);
  assert.equal(DEFAULT_CONFIG.maxSteps, 4);
  assert.equal(DEFAULT_CONFIG.maxOutputTokens, 1024);
  const empty = {};
  resolveConfig(empty);
  assert.deepEqual(empty, {}, 'validation must not inject schema defaults into callers');
  const override = { model: 'explicit', reasoning: 'low' as const };
  assert.equal(resolveConfig(original, override).model, 'explicit');
  assert.equal(resolveConfig(original, override).reasoning, 'low');
  assert.deepEqual(override, { model: 'explicit', reasoning: 'low' });
});

test('config rejects type coercion, unknown fields and unsafe cap values without modifying inputs', () => {
  const invalid: unknown[] = [
    null,
    [],
    'text',
    3,
    { model: 1 },
    { model: '' },
    { model: 'bad model' },
    { system: false },
    { system: '' },
    { system: '  ' },
    { reasoning: 'high' },
    { reasoning: 'LOW' },
    { maxSteps: undefined },
    { maxOutputTokens: undefined },
    { system: undefined },
    { model: undefined },
    { reasoning: undefined },
    { maxSteps: '4' },
    { maxSteps: null },
    { maxSteps: 0 },
    { maxSteps: -1 },
    { maxSteps: 1.5 },
    { maxSteps: 13 },
    { maxSteps: Infinity },
    { maxOutputTokens: '1024' },
    { maxOutputTokens: false },
    { maxOutputTokens: 0 },
    { maxOutputTokens: -1 },
    { maxOutputTokens: 1.5 },
    { maxOutputTokens: 2049 },
    { apiKey: secret },
    { baseURL: secret },
    { tools: [] },
    { imports: secret },
    { [secret]: secret },
    JSON.parse('{"__proto__":{"model":"override"}}'),
  ];
  for (const value of invalid) {
    const before = structuredClone(value);
    assert.throws(
      () => resolveConfig(value as never),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
      `must reject ${JSON.stringify(value)}`,
    );
    assert.deepEqual(value, before);
    assert.throws(() => resolveConfig({}, value as never), 'overrides must also be validated');
  }
  assert.equal(resolveConfig({ maxSteps: 1, maxOutputTokens: 1 }).maxSteps, 1);
});

test('explicit config loading preserves Unicode and file bytes; rejects malformed, missing and nonfile inputs', async () => {
  const body = JSON.stringify({ system: '你好 🌏\n保持原文', maxSteps: 12, maxOutputTokens: 2048 });
  const f = await fixture(body);
  try {
    const loaded = await loadConfig(f.path);
    assert.equal(loaded.system, '你好 🌏\n保持原文');
    assert.equal(loaded.maxSteps, 12);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(await readFile(f.path, 'utf8'), body);
    assert.deepEqual(resolveConfig(loaded).maxOutputTokens, 2048);
    for (const invalid of [
      '{"system":"' + secret + '",',
      '{"apiKey":"' + secret + '"}',
      'null',
      '[]',
      '{"maxSteps":"4"}',
    ]) {
      await writeFile(f.path, invalid);
      await assert.rejects(loadConfig(f.path), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes(invalid), false);
        return true;
      });
    }
    await writeFile(f.path, Buffer.from([0xff, 0xfe]));
    await assert.rejects(loadConfig(f.path));
    await writeFile(f.path, ' '.repeat(65537));
    await assert.rejects(loadConfig(f.path));
    await assert.rejects(loadConfig(join(f.root, secret)));
    await assert.rejects(loadConfig(f.root));
  } finally {
    await f.clean();
  }
});

test('CLI uses defaults < explicit JSON < flags regardless of flag ordering, and never discovers config implicitly', async (t) => {
  t.mock.method(process.stdout, 'write', () => true);
  t.mock.method(process.stderr, 'write', () => true);
  const f = await fixture(
    JSON.stringify({ model: 'config-model', system: '只读中文 🧪', reasoning: 'medium', maxOutputTokens: 2048 }),
  );
  try {
    for (const args of [
      ['--config', f.path, '--model', 'explicit-model', '--reasoning', 'low'],
      ['--model', 'explicit-model', '--reasoning', 'low', '--config', f.path],
      ['--config', f.path],
      [],
    ]) {
      let calls = 0;
      const configured = args.includes('--config');
      const explicit = args.includes('--model');
      assert.equal(
        await main(['--openai', ...args, '--prompt', 'Unicode 输入 🌏'], {
          env: { OPENAI_API_KEY: dummyKey },
          projectRoot: f.root,
          modelFactory: (options) => {
            calls++;
            assert.equal(
              options.model,
              explicit ? 'explicit-model' : configured ? 'config-model' : DEFAULT_CONFIG.model,
            );
            assert.equal(options.reasoningEffort, explicit ? 'low' : configured ? 'medium' : 'low');
            assert.equal(options.maxCompletionTokens, configured ? 2048 : DEFAULT_CONFIG.maxOutputTokens);
            return {
              complete: async (messages, tools) => {
                assert.equal(messages.at(-1)?.content, 'Unicode 输入 🌏');
                assert.ok(messages[0].content?.startsWith(PROJECT_SYSTEM));
                if (configured) assert.match(messages[0].content!, /只读中文 🧪/);
                assert.deepEqual(
                  tools.map((tool) => tool.name),
                  ['read_project_file'],
                );
                assert.deepEqual((tools[0].parameters.properties as any).path.enum, [...PROJECT_FILES]);
                return { role: 'assistant', content: 'Offline success.' };
              },
            };
          },
        }),
        0,
      );
      assert.equal(calls, 1);
    }
  } finally {
    await f.clean();
  }
});

test('CLI invalid config emits safe errors before provider construction and rejects config in demo mode', async (t) => {
  let output = '';
  t.mock.method(process.stdout, 'write', (text: string) => {
    output += text;
    return true;
  });
  t.mock.method(process.stderr, 'write', (text: string) => {
    output += text;
    return true;
  });
  const f = await fixture();
  const options = {
    env: { OPENAI_API_KEY: dummyKey },
    modelFactory: () => {
      assert.fail('must not construct provider');
    },
  };
  try {
    for (const body of [
      '{"' + secret + '":"' + secret + '"}',
      '{"system":"' + secret + '",',
      '{"maxSteps":0}',
      '{"maxOutputTokens":2049}',
    ]) {
      output = '';
      await writeFile(f.path, body);
      assert.equal(await main(['--openai', '--config', f.path, '--prompt', 'test'], options), 2);
      assert.ok(output.length > 0);
      assert.equal(output.includes(secret), false);
      assert.equal(output.includes(body), false);
    }
    output = '';
    assert.equal(await main(['--openai', '--config', join(f.root, secret), '--prompt', 'test'], options), 2);
    assert.equal(output.includes(secret), false);
    assert.equal(await main(['--demo', '--config', f.path, '--prompt', 'test'], options), 2);
    assert.equal(await main(['--openai', '--config'], options), 2);
    assert.equal(await main(['--demo', '--prompt', '你好   世界 🌏'], options), 0);
    assert.match(output, /scripted fixture/);
  } finally {
    await f.clean();
  }
});

test('configured loop caps are enforced at both boundaries and /new restores resolved default instructions', async (t) => {
  t.mock.method(process.stdout, 'write', () => true);
  t.mock.method(process.stderr, 'write', () => true);
  const f = await fixture();
  try {
    for (const maxSteps of [1, 12]) {
      await writeFile(f.path, JSON.stringify({ maxSteps }));
      let calls = 0;
      assert.equal(
        await main(['--openai', '--config', f.path, '--prompt', 'read repeatedly'], {
          env: { OPENAI_API_KEY: dummyKey },
          projectRoot: f.root,
          modelFactory: () => ({
            complete: async () => ({
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `read-${++calls}`,
                  type: 'function',
                  function: { name: 'read_project_file', arguments: '{"path":"README.md"}' },
                },
              ],
            }),
          }),
        }),
        1,
      );
      assert.equal(calls, maxSteps, 'configured cap must not be silently ignored or disabled');
    }
    const systems: string[] = [];
    const model: Model = {
      complete: async (messages, tools) => {
        assert.ok(messages[0].content?.startsWith(PROJECT_SYSTEM));
        assert.deepEqual(
          tools.map((tool) => tool.name),
          ['read_project_file'],
        );
        assert.deepEqual((tools[0].parameters.properties as any).path.enum, [...PROJECT_FILES]);
        return { role: 'assistant', content: 'done' };
      },
    };
    const config = resolveConfig({ system: '配置默认 🧪' });
    const controller = new SessionController(
      (system) => {
        systems.push(system);
        const agent = createProjectAgent(model, system, f.root, { maxSteps: config.maxSteps });
        return agent;
      },
      new TerminalView({ write: () => {} }),
      { defaultSystem: config.system },
    );
    await controller.submit('/create 新的提示');
    await controller.submit('检查固定工具');
    await controller.submit('/new');
    await controller.submit('检查默认提示');
    assert.deepEqual(systems, ['配置默认 🧪', '新的提示', '配置默认 🧪']);
  } finally {
    await f.clean();
  }
});
