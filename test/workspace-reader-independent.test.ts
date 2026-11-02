import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceFileTool } from '../src/workspace-file-tool.ts';
import { createProjectFileTool, PROJECT_FILES } from '../src/project-agent.ts';
import type { WorkspaceFileToolOptions } from '../src/workspace-file-tool.ts';
import type { AgentEvent, Tool } from '../src/core.ts';

const execute = (tool: Tool, args: unknown, signal = new AbortController().signal) => tool.execute(args, { signal });
async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'pure-reader-independent-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'workspace');
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'public.txt'), 'fixture public text');
  await writeFile(join(base, 'outside.txt'), 'synthetic outside marker');
  return { base, root };
}

test('independent reader: explicit root and nonempty exact allowlist required', () => {
  for (const options of [
    {},
    { root: '.' },
    { root: tmpdir(), allowedFiles: [] },
    { root: tmpdir(), allowedFiles: ['*'] },
  ]) {
    assert.throws(
      () => createWorkspaceFileTool(options as unknown as WorkspaceFileToolOptions),
      /WORKSPACE_FILE_INVALID_OPTIONS/,
    );
  }
});

test('independent reader: path spellings cannot escape or normalize scope', async (t) => {
  const { root, base } = await fixture(t);
  const paths = [
    '../outside.txt',
    '/outside.txt',
    join(base, 'outside.txt'),
    'docs/../outside.txt',
    './docs/public.txt',
    'docs//public.txt',
    'docs/public.txt/',
    'C:/outside.txt',
    'C:\\outside.txt',
    '\\\\host\\share',
    'docs\\public.txt',
    'docs/./public.txt',
    'docs/public.txt\0',
  ];
  const tool = createWorkspaceFileTool({ root, allowedFiles: ['docs/public.txt'] });
  for (const path of paths) {
    assert.throws(() => createWorkspaceFileTool({ root, allowedFiles: [path] }), /INVALID_OPTIONS/, path);
    await assert.rejects(execute(tool, { path }), /NOT_ALLOWED/, path);
  }
});

test('independent reader: private filenames rejected even explicitly allowlisted', async (t) => {
  const { root } = await fixture(t);
  for (const path of [
    '.env.local',
    '.git/config',
    'docs/.hidden',
    'credentials.json',
    'api-token.txt',
    'SECRET.txt',
    'passwords.csv',
    'id_rsa',
    'id_ed25519.pub',
    'docs/private-key.txt',
    'cert.pem',
    'store.p12',
    'cert.KEY',
    'docs/secrets/file.txt',
    'NUL.txt',
  ]) {
    assert.throws(() => createWorkspaceFileTool({ root, allowedFiles: [path] }), /INVALID_OPTIONS/, path);
  }
});

test('independent reader: conventional API/access credential names are denied', () => {
  for (const path of ['api_key.json', 'api-keys.txt', 'apikey.txt', 'access_key.txt']) {
    assert.throws(() => createWorkspaceFileTool({ root: tmpdir(), allowedFiles: [path] }), /INVALID_OPTIONS/, path);
  }
});

test('independent reader: host list and exposed schema mutations do not elevate scope', async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'extra.txt'), 'not granted');
  const allowedFiles = ['docs/public.txt'];
  const options = { root, allowedFiles, maxBytes: 4 };
  const tool = createWorkspaceFileTool(options);
  allowedFiles.push('extra.txt');
  options.root = '/';
  options.maxBytes = 999;
  (tool.parameters.properties as { path: { enum: string[] } }).path.enum.push('extra.txt');
  await assert.rejects(execute(tool, { path: 'extra.txt' }), /NOT_ALLOWED/);
  assert.deepEqual(await execute(tool, { path: 'docs/public.txt' }), {
    path: 'docs/public.txt',
    content: 'fixt',
    truncated: true,
  });
});

test('independent reader: direct invocation rejects malformed or authority-bearing arguments', async (t) => {
  const { root } = await fixture(t);
  const tool = createWorkspaceFileTool({ root, allowedFiles: ['docs/public.txt'] });
  for (const args of [
    null,
    [],
    'docs/public.txt',
    {},
    { path: 'docs/public.txt', root },
    { path: 'docs/public.txt', maxBytes: 1000000 },
    { path: ['docs/public.txt'] },
    Object.create({ path: 'docs/public.txt' }),
  ]) {
    await assert.rejects(execute(tool, args), /NOT_ALLOWED/);
  }
});

for (const level of ['root', 'ancestor', 'intermediate', 'leaf'] as const) {
  test(`independent reader: rejects ${level} symlink`, async (t) => {
    const { base, root } = await fixture(t);
    let selectedRoot = root;
    let path = 'docs/public.txt';
    if (level === 'root' || level === 'ancestor') {
      const link = join(base, 'root-link');
      await symlink(root, link, 'dir');
      selectedRoot = level === 'root' ? link : join(link, 'docs');
      if (level === 'ancestor') path = 'public.txt';
    } else if (level === 'intermediate') {
      await symlink(join(root, 'docs'), join(root, 'linked-docs'), 'dir');
      path = 'linked-docs/public.txt';
    } else {
      await symlink(join(base, 'outside.txt'), join(root, 'linked.txt'), 'file');
      path = 'linked.txt';
    }
    await assert.rejects(
      execute(createWorkspaceFileTool({ root: selectedRoot, allowedFiles: [path] }), { path }),
      /UNAVAILABLE/,
    );
  });
}

test('independent reader: missing and directory targets produce opaque failures', async (t) => {
  const { root } = await fixture(t);
  for (const path of ['missing.txt', 'docs']) {
    await assert.rejects(execute(createWorkspaceFileTool({ root, allowedFiles: [path] }), { path }), {
      message: 'WORKSPACE_FILE_UNAVAILABLE',
    });
  }
  await assert.rejects(
    execute(createWorkspaceFileTool({ root: join(root, 'missing'), allowedFiles: ['public.txt'] }), {
      path: 'public.txt',
    }),
    { message: 'WORKSPACE_FILE_UNAVAILABLE' },
  );
});

test('independent reader: UTF-8 caps omit incomplete code points and preserve BOM', async (t) => {
  const { root } = await fixture(t);
  const text = '\uFEFFaé中😀z';
  await writeFile(join(root, 'utf8.txt'), text);
  const bytes = Buffer.from(text);
  for (let maxBytes = 1; maxBytes <= bytes.length + 1; maxBytes++) {
    const result = (await execute(createWorkspaceFileTool({ root, allowedFiles: ['utf8.txt'], maxBytes }), {
      path: 'utf8.txt',
    })) as { content: string; truncated: boolean };
    let expected = '';
    for (const char of text) {
      if (Buffer.byteLength(expected + char) > maxBytes) break;
      expected += char;
    }
    assert.equal(result.content, expected, `byte cap ${maxBytes}`);
    assert.equal(result.truncated, bytes.length > maxBytes);
    assert.ok(Buffer.byteLength(result.content) <= maxBytes);
    assert.ok(!result.content.includes('\uFFFD'));
  }
});

test('independent reader: exact cap and empty file are not truncated', async (t) => {
  const { root } = await fixture(t);
  for (const content of ['', '1234']) {
    await writeFile(join(root, 'text.txt'), content);
    assert.deepEqual(
      await execute(createWorkspaceFileTool({ root, allowedFiles: ['text.txt'], maxBytes: 4 }), { path: 'text.txt' }),
      { path: 'text.txt', content, truncated: false },
    );
  }
});

test('independent reader: invalid UTF-8 fails closed', async (t) => {
  const { root } = await fixture(t);
  for (const bytes of [[0xff], [0xe2, 0x82], [0xc0, 0xaf], [0xed, 0xa0, 0x80]]) {
    await writeFile(join(root, 'invalid.txt'), Buffer.from(bytes));
    await assert.rejects(
      execute(createWorkspaceFileTool({ root, allowedFiles: ['invalid.txt'] }), { path: 'invalid.txt' }),
      /UNAVAILABLE/,
    );
  }
});

test('independent reader: byte option rejects invalid values', () => {
  for (const maxBytes of [0, -1, 0.5, NaN, Infinity, 1048577]) {
    assert.throws(
      () => createWorkspaceFileTool({ root: tmpdir(), allowedFiles: ['public.txt'], maxBytes }),
      /INVALID_OPTIONS/,
    );
  }
});

test('independent reader: pre-abort and in-flight abort preserve cancellation reason', async (t) => {
  const { root } = await fixture(t);
  const tool = createWorkspaceFileTool({ root, allowedFiles: ['docs/public.txt'] });
  for (const preAbort of [true, false]) {
    const controller = new AbortController();
    const reason = new Error(`synthetic cancellation ${preAbort}`);
    if (preAbort) controller.abort(reason);
    const result = execute(tool, { path: 'docs/public.txt' }, controller.signal);
    if (!preAbort) controller.abort(reason);
    await assert.rejects(result, (error) => error === reason);
  }
  assert.equal(
    ((await execute(tool, { path: 'docs/public.txt' })) as { content: string }).content,
    'fixture public text',
  );
});

test('independent reader: existing CLI project tool remains four-file constrained', async (t) => {
  const { root } = await fixture(t);
  assert.equal(PROJECT_FILES.length, 4);
  const tool = createProjectFileTool(root);
  assert.equal(tool.name, 'read_project_file');
  assert.deepEqual((tool.parameters.properties as { path: { enum: string[] } }).path.enum, [...PROJECT_FILES]);
  await assert.rejects(execute(tool, { path: 'docs/public.txt' }), /PROJECT_FILE_NOT_ALLOWED/);
});

test('independent reader IT: actual agent loop reads granted file and rejects model scope elevation', async (t) => {
  const { createAgent } = await import('../src/index.ts');
  const { root } = await fixture(t);
  const seen: AgentEvent[] = [];
  let calls = 0;
  // Only model output is mocked; core, schema checks, tool and filesystem are real.
  const agent = createAgent({
    tools: [createWorkspaceFileTool({ root, allowedFiles: ['docs/public.txt'] })],
    model: {
      complete: async (messages, definitions) => {
        calls++;
        assert.deepEqual(
          definitions.map((d) => d.name),
          ['read_workspace_file'],
        );
        if (calls === 1)
          return {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'allowed',
                type: 'function',
                function: { name: 'read_workspace_file', arguments: JSON.stringify({ path: 'docs/public.txt' }) },
              },
              {
                id: 'outside',
                type: 'function',
                function: { name: 'read_workspace_file', arguments: JSON.stringify({ path: '../outside.txt' }) },
              },
              {
                id: 'root-override',
                type: 'function',
                function: {
                  name: 'read_workspace_file',
                  arguments: JSON.stringify({ path: 'docs/public.txt', root: '/' }),
                },
              },
            ],
          };
        const results = messages
          .filter((m) => m.role === 'tool')
          .map((m) => {
            assert.ok(m.content !== null);
            return JSON.parse(m.content);
          });
        assert.deepEqual(results[0], { path: 'docs/public.txt', content: 'fixture public text', truncated: false });
        assert.equal(results[1].ok, false);
        assert.equal(results[2].ok, false);
        assert.ok(!JSON.stringify(results).includes('synthetic outside marker'));
        return { role: 'assistant', content: 'Fixture read verified' };
      },
    },
  });
  const result = await agent.run('Read granted fixture only', {
    onEvent: (e) => {
      seen.push(e);
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Fixture read verified');
  assert.equal(calls, 2);
  assert.equal(seen.filter((e) => e.type === 'tool_start').length, 1);
  assert.equal(seen.filter((e) => e.type === 'tool_end').length, 3);
});
