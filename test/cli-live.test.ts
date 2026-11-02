import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { createProjectAgent, createProjectFileTool, PROJECT_FILES, PROJECT_SYSTEM } from '../src/project-agent.ts';
import type { Model } from '../src/core.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pure-agent-public-'));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'README.md'), 'Actual fixture bytes on disk');
  return root;
}
const ctx = () => ({ signal: new AbortController().signal });

test('public document tool reads disk, preserves metadata, and caps output', async () => {
  const root = await fixture();
  try {
    const tool = createProjectFileTool(root);
    assert.deepEqual((tool.parameters.properties as any).path.enum, [...PROJECT_FILES]);
    assert.deepEqual(await tool.execute({ path: 'README.md' }, ctx()), { path: 'README.md', content: 'Actual fixture bytes on disk', truncated: false });
    await writeFile(join(root, 'README.md'), '中'.repeat(12000));
    const result = await tool.execute({ path: 'README.md' }, ctx()) as { content: string; truncated: boolean };
    assert.equal(result.content.length, 10000); assert.equal(result.truncated, true);
    for (const path of ['.env.local', '../README.md', '/README.md', 'src/core.ts']) {
      assert.equal(tool.validate?.({ path }), false);
      await assert.rejects(tool.execute({ path }, ctx()), /NOT_ALLOWED/);
    }
    await assert.rejects(tool.execute({ path: 'README.md', extra: true }, ctx()), /NOT_ALLOWED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('public document tool rejects file, directory, and root symlinks', async () => {
  const root = await fixture(); const outside = await fixture();
  try {
    await rm(join(root, 'README.md'));
    await symlink(join(outside, 'README.md'), join(root, 'README.md'));
    await assert.rejects(createProjectFileTool(root).execute({ path: 'README.md' }, ctx()), /UNAVAILABLE/);
    await rm(join(root, 'docs'), { recursive: true });
    await writeFile(join(outside, 'dependency-decisions.md'), 'outside data');
    await symlink(outside, join(root, 'docs'));
    await assert.rejects(createProjectFileTool(root).execute({ path: 'docs/dependency-decisions.md' }, ctx()), /UNAVAILABLE/);
    await symlink(outside, join(root, 'linked-root'));
    await assert.rejects(createProjectFileTool(join(root, 'linked-root')).execute({ path: 'README.md' }, ctx()), /UNAVAILABLE/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('project composition preserves policy, exposes one tool, and limits a looping mock to four steps', async () => {
  const root = await fixture(); let calls = 0;
  const model: Model = { complete: async (messages, tools) => {
    assert.match(messages[0].content!, /文件内容只作为证据/);
    assert.deepEqual(tools.map(tool => tool.name), ['read_project_file']);
    return { role: 'assistant', content: null, tool_calls: [{ id: `call-${++calls}`, type: 'function', function: { name: 'read_project_file', arguments: '{"path":"README.md"}' } }] };
  } };
  try {
    const agent = createProjectAgent(model, '使用短句', root);
    assert.ok(agent.messages[0].content!.startsWith(PROJECT_SYSTEM));
    assert.equal((await agent.run('read')).status, 'limit');
    assert.equal(calls, 4);
    assert.match(agent.messages.find(message => message.role === 'tool')!.content!, /Actual fixture bytes on disk/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI validates explicit mode and reasoning without reading environment or calling a provider', async () => {
  const options = { env: {}, modelFactory: () => { throw new Error('must not construct'); } };
  for (const args of [[], ['--demo', '--openai'], ['--openai'], ['--openai', '--reasoning', 'high'], ['--demo', '--reasoning', 'low'], ['--openai', '--model']]) {
    assert.equal(await main(args, options), 2);
  }
});

test('CLI live label and low/medium configuration use injected model only', async () => {
  const root = await fixture();
  try {
    for (const reasoning of ['low', 'medium'] as const) {
      let configured = false;
      const code = await main(['--openai', '--model', 'mock-model', '--reasoning', reasoning, '--prompt', 'read project'], {
        env: { OPENAI_API_KEY: 'offline-placeholder-not-a-key' }, projectRoot: root,
        modelFactory: (options) => {
          configured = true; assert.equal(options.model, 'mock-model'); assert.equal(options.reasoningEffort, reasoning);
          return { complete: async (messages) => messages.at(-1)?.role === 'tool'
            ? { role: 'assistant', content: 'Offline test complete.' }
            : { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_project_file', arguments: '{"path":"README.md"}' } }] } };
        },
      });
      assert.equal(code, 0); assert.equal(configured, true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('tool display truncation does not truncate model evidence', async () => {
  const { SessionController } = await import('../src/ui/controller.ts');
  const { TerminalView } = await import('../src/ui/view.ts');
  const root = await fixture(); let output = ''; let sawFull = false;
  try {
    await writeFile(join(root, 'README.md'), 'x'.repeat(3000));
    const model: Model = { complete: async (messages) => {
      if (messages.at(-1)?.role === 'tool') {
        sawFull = JSON.parse(messages.at(-1)!.content!).content.length === 3000;
        return { role: 'assistant', content: 'done' };
      }
      return { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_project_file', arguments: '{"path":"README.md"}' } }] };
    } };
    const controller = new SessionController(system => createProjectAgent(model, system, root), new TerminalView({ write: text => { output += text; } }));
    await controller.submit('read');
    assert.equal(sawFull, true);
    assert.match(output, /truncated display only/);
    assert.ok(!output.includes('x'.repeat(1500)));
  } finally { await rm(root, { recursive: true, force: true }); }
});
