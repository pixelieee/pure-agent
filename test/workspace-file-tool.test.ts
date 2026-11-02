import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWorkspaceFileTool } from '../src/index.ts';
import { createAgent, type Model } from '../src/core.ts';

const ctx = () => ({ signal: new AbortController().signal });
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'pure-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/main.ts'), 'export const hello = "世界";');
  return root;
}

test('workspace reader is explicit, immutable and bounded through SDK composition', async t => {
  const root = await fixture(t);
  const allowedFiles = ['src/main.ts'];
  const tool = createWorkspaceFileTool({ root, allowedFiles });
  allowedFiles.push('other.txt');
  (tool.parameters.properties as any).path.enum.push('other.txt');
  assert.equal(tool.validate?.({ path: 'other.txt' }), false);
  const model: Model = { complete: async messages => messages.at(-1)?.role === 'tool'
    ? { role: 'assistant', content: 'done' }
    : { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: tool.name, arguments: '{"path":"src/main.ts"}' } }] } };
  const agent = createAgent({ model, tools: [tool] });
  assert.equal((await agent.run('read')).status, 'completed');
  assert.deepEqual(JSON.parse(agent.messages.find(m => m.role === 'tool')!.content!), {
    path: 'src/main.ts', content: 'export const hello = "世界";', truncated: false,
  });
});

test('configuration rejects dangerous paths and bad bounds without filesystem access', () => {
  for (const path of ['../readme', '/readme', 'src/../readme', 'src//main', './main', '.env.fixture', '.git/config', 'src/.private/x', 'secrets.json', 'credentials.json', 'id_rsa', 'private-key.txt', 'api_key.json', 'api-keys.txt', 'apikey.txt', 'access_key.txt', 'cert.pem', 'C:/file', 'src\\file', 'file\0name', 'NUL', '*']) {
    assert.throws(() => createWorkspaceFileTool({ root: '/unused', allowedFiles: [path] }), /WORKSPACE_FILE_INVALID_OPTIONS/);
  }
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, 1048577]) {
    assert.throws(() => createWorkspaceFileTool({ root: '/unused', allowedFiles: ['ok'], maxBytes }), /INVALID_OPTIONS/);
  }
  assert.throws(() => createWorkspaceFileTool({ root: '.', allowedFiles: ['ok'] }), /INVALID_OPTIONS/);
  assert.throws(() => createWorkspaceFileTool({ root: '/unused', allowedFiles: [] }), /INVALID_OPTIONS/);
});

test('byte limits preserve UTF-8, BOM, empty and exactly sized contents', async t => {
  const root = await fixture(t);
  for (const [input, maxBytes, content, truncated] of [
    ['a世界', 4, 'a世', true], ['a世界', 3, 'a', true], ['😀z', 3, '', true],
    ['😀', 4, '😀', false], ['éx', 1, '', true], ['', 1, '', false], ['\uFEFFa', 4, '\uFEFFa', false],
  ] as const) {
    await writeFile(join(root, 'src/main.ts'), input);
    const result = await createWorkspaceFileTool({ root, allowedFiles: ['src/main.ts'], maxBytes }).execute({ path: 'src/main.ts' }, ctx());
    assert.deepEqual(result, { path: 'src/main.ts', content, truncated });
    assert.ok(Buffer.byteLength(content) <= maxBytes);
  }
  await writeFile(join(root, 'src/main.ts'), Buffer.from([0xff]));
  await assert.rejects(createWorkspaceFileTool({ root, allowedFiles: ['src/main.ts'] }).execute({ path: 'src/main.ts' }, ctx()), { message: 'WORKSPACE_FILE_UNAVAILABLE' });
});

test('rejects symlink roots, ancestors, components, leaves and directories with sanitized errors', async t => {
  const root = await fixture(t);
  await symlink(join(root, 'src'), join(root, 'linked'));
  await symlink(join(root, 'src/main.ts'), join(root, 'alias'));
  for (const [workspace, path] of [[join(root, 'linked'), 'main.ts'], [root, 'linked/main.ts'], [root, 'alias'], [root, 'src'], [root, 'missing']]) {
    await assert.rejects(createWorkspaceFileTool({ root: workspace, allowedFiles: [path] }).execute({ path }, ctx()), { message: 'WORKSPACE_FILE_UNAVAILABLE' });
  }
  await mkdir(join(root, 'src/nested'));
  await writeFile(join(root, 'src/nested/readme'), 'fixture');
  await assert.rejects(createWorkspaceFileTool({ root: join(root, 'linked/nested'), allowedFiles: ['readme'] }).execute({ path: 'readme' }, ctx()), /UNAVAILABLE/);
});

test('direct invocation guards inputs and honors cancellation before any path lookup', async t => {
  const root = await fixture(t);
  const tool = createWorkspaceFileTool({ root, allowedFiles: ['src/main.ts'] });
  for (const args of [null, [], {}, { path: 'other' }, { path: 'src/main.ts', extra: true }]) {
    await assert.rejects(tool.execute(args, ctx()), { message: 'WORKSPACE_FILE_NOT_ALLOWED' });
  }
  const signal = AbortSignal.abort(new Error('fixture cancellation'));
  await assert.rejects(tool.execute({ path: 'src/main.ts' }, { signal }), /fixture cancellation/);
});


test('host temporary root and canonical root both read the same authorized fixture', async t => {
  const root = await fixture(t);
  const canonicalRoot = await realpath(root);
  // On Windows CI tmpdir can contain an 8.3 alias. Report only synthetic paths.
  if (process.platform === 'win32') t.diagnostic(JSON.stringify({
    fixtureRoot: resolve(root), canonicalRoot, canonicalSpellingChanged: resolve(root) !== canonicalRoot,
    openFlags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    noFollow: constants.O_NOFOLLOW ?? null, nonBlock: constants.O_NONBLOCK ?? null,
  }));
  for (const workspace of [root, canonicalRoot]) {
    assert.deepEqual(await createWorkspaceFileTool({ root: workspace, allowedFiles: ['src/main.ts'] })
      .execute({ path: 'src/main.ts' }, ctx()), { path: 'src/main.ts', content: 'export const hello = "世界";', truncated: false });
  }
});
