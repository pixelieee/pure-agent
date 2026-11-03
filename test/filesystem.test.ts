import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { Tool } from '../src/core.ts';
import { createFileTools, type FileToolsOptions } from '../src/tools/filesystem.ts';

const context = () => ({ signal: new AbortController().signal });
async function fixture(t: { after: (run: () => Promise<void>) => void }, options: Partial<FileToolsOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pure-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map(createFileTools({ root, ...options }).map((tool) => [tool.name, tool]));
  function tool(name: string): Tool {
    const found = tools.get(name);
    assert.ok(found, `Missing tool ${name}`);
    return found;
  }
  // biome-ignore lint/suspicious/noExplicitAny: Tests exercise JSON protocol payloads and tool result assertions.
  const run = async (name: string, args: unknown): Promise<any> => tool(name).execute(args, context());
  const put = async (path: string, content: string | Uint8Array) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  return { root, tools, tool, run, put };
}

test('developer files expose six bounded, validated tools over the full workspace', async (t) => {
  const { tools, run, put } = await fixture(t);
  assert.deepEqual([...tools.keys()], ['read', 'write', 'edit', 'find', 'ls', 'grep']);
  await put('.github/workflows/build.yml', 'name: build\n');
  await put('.config/editor/settings.json', '{"theme":"dark"}');
  await put('unusual key names/secret-model.test.ts', 'legitimate project source');
  for (const path of [
    '.github/workflows/build.yml',
    '.config/editor/settings.json',
    'unusual key names/secret-model.test.ts',
  ]) {
    assert.equal((await run('read', { path })).truncated, false);
  }
  await assert.rejects(run('read', { path: 'file', offset: 0 }), /schema|minimum|invalid/iu);
  await assert.rejects(run('edit', { path: 'file', edits: [] }), /schema|minItems|invalid/iu);
  await assert.rejects(run('write', { path: 'file', content: 'x', unexpected: true }), /schema|additional|invalid/iu);
});

test('streaming read paginates lines and long Unicode lines without corruption or omission', async (t) => {
  const { run, put } = await fixture(t, { maxReadBytes: 7, maxReadLines: 2 });
  const original = '\uFEFF世界😀abcdef\r\nsecond\nthird';
  await put('text.txt', original);
  let offset = 1;
  let column = 1;
  let combined = '';
  for (let i = 0; i < 50; i++) {
    const result = await run('read', { path: 'text.txt', offset, column });
    assert.ok(Buffer.byteLength(result.content) <= 7);
    combined += result.content;
    if (!result.truncated) break;
    assert.ok(result.nextOffset > offset || result.nextColumn > column);
    offset = result.nextOffset;
    column = result.nextColumn;
  }
  assert.equal(combined, original);
  assert.equal((await run('read', { path: 'text.txt', offset: 2, limit: 1 })).content, 'second\n');
  await assert.rejects(run('read', { path: 'text.txt', offset: 10 }), /past end/iu);
});

test('read streams files larger than the mutation/search cap and returns empty files', async (t) => {
  const { run, put } = await fixture(t, { maxFileBytes: 8, maxReadBytes: 10 });
  await put('big.log', 'line\n'.repeat(20000));
  assert.equal((await run('read', { path: 'big.log', offset: 19000, limit: 1 })).content, 'line\n');
  await put('empty.txt', '');
  const empty = await run('read', { path: 'empty.txt' });
  assert.equal(empty.content, '');
  assert.equal(empty.truncated, false);
  assert.match(empty.hash, /^[a-f0-9]{64}$/u);
});

test('binary files and invalid UTF-8 fail clearly, without mutating data', async (t) => {
  const { run, put, root } = await fixture(t);
  for (const [name, data] of [
    ['binary', Buffer.from([0, 1, 2])],
    ['invalid', Buffer.from([255])],
  ] as const) {
    await put(name, data);
    await assert.rejects(run('read', { path: name }), /Binary|UTF-8/u);
    await assert.rejects(run('edit', { path: name, edits: [{ oldText: 'x', newText: 'y' }] }), /Binary|UTF-8/u);
    assert.deepEqual(await readFile(join(root, name)), data);
  }
});

test('write creates parents, overwrites atomically, preserves mode and rejects stale hashes', async (t) => {
  const { run, root } = await fixture(t);
  const written = await run('write', { path: 'new/deep/script.sh', content: '#!/bin/sh\necho hi\n' });
  assert.equal(await readFile(join(root, 'new/deep/script.sh'), 'utf8'), '#!/bin/sh\necho hi\n');
  await chmod(join(root, 'new/deep/script.sh'), 0o775);
  await run('write', { path: 'new/deep/script.sh', content: 'next', expectedHash: written.hash });
  if (process.platform !== 'win32') assert.equal((await lstat(join(root, 'new/deep/script.sh'))).mode & 0o777, 0o775);
  await assert.rejects(
    run('write', { path: 'new/deep/script.sh', content: 'stale', expectedHash: written.hash }),
    /hash mismatch/u,
  );
  assert.equal(await readFile(join(root, 'new/deep/script.sh'), 'utf8'), 'next');
  assert.deepEqual((await readdir(join(root, 'new/deep'))).sort(), ['script.sh']);
});

test('edit preserves BOM/CRLF and untouched mixed line endings using original-file batches', async (t) => {
  const { run, put, root } = await fixture(t);
  const original = '\uFEFFfirst\r\nsecond\r\nthird\nlast\r\n';
  await put('mixed.txt', original);
  const before = await run('read', { path: 'mixed.txt' });
  const result = await run('edit', {
    path: 'mixed.txt',
    expectedHash: before.hash,
    edits: [
      { oldText: 'first\nsecond', newText: 'hello\nworld' },
      { oldText: 'last', newText: 'final' },
    ],
  });
  assert.equal(await readFile(join(root, 'mixed.txt'), 'utf8'), '\uFEFFhello\r\nworld\r\nthird\nfinal\r\n');
  assert.equal(result.edits, 2);
  assert.equal(result.firstChangedLine, 1);
});

test('edit rejects missing, duplicate, overlapping, empty and no-change requests atomically', async (t) => {
  const { run, put, root } = await fixture(t);
  const original = 'alpha beta\nalpha gamma\n';
  await put('file', original);
  const cases = [
    [{ oldText: 'missing', newText: 'x' }],
    [{ oldText: 'alpha', newText: 'x' }],
    [
      { oldText: 'alpha beta', newText: 'x' },
      { oldText: 'beta', newText: 'y' },
    ],
    [
      { oldText: 'alpha beta', newText: 'x' },
      { oldText: 'alpha beta', newText: 'y' },
    ],
    [{ oldText: '', newText: 'x' }],
    [{ oldText: 'alpha beta', newText: 'alpha beta' }],
    [
      { oldText: 'beta', newText: 'changed' },
      { oldText: 'changed', newText: 'later' },
    ],
  ];
  for (const edits of cases) {
    await assert.rejects(run('edit', { path: 'file', edits }));
    assert.equal(await readFile(join(root, 'file'), 'utf8'), original);
  }
});

test('overlapping occurrences of oldText are ambiguous, adjacent edits are allowed', async (t) => {
  const { run, put, root } = await fixture(t);
  await put('file', 'aaa');
  await assert.rejects(run('edit', { path: 'file', edits: [{ oldText: 'aa', newText: 'b' }] }), /ambiguous/u);
  await put('file', 'abcdef');
  await run('edit', {
    path: 'file',
    edits: [
      { oldText: 'abc', newText: 'A' },
      { oldText: 'def', newText: 'B' },
    ],
  });
  assert.equal(await readFile(join(root, 'file'), 'utf8'), 'AB');
});

test('concurrent edits serialize across canonical and symlink aliases without losing changes', async (t) => {
  const { run, put, root } = await fixture(t);
  await put('file', 'first\nsecond\n');
  await symlink(join(root, 'file'), join(root, 'alias'));
  await Promise.all([
    run('edit', { path: 'file', edits: [{ oldText: 'first', newText: 'FIRST' }] }),
    run('edit', { path: 'alias', edits: [{ oldText: 'second', newText: 'SECOND' }] }),
  ]);
  assert.equal(await readFile(join(root, 'file'), 'utf8'), 'FIRST\nSECOND\n');
  assert.equal((await lstat(join(root, 'alias'))).isSymbolicLink(), true);
});

test('root-scoped paths reject lexical and symlink escapes and permit contained links', async (t) => {
  const { run, put, root } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'pure-files-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'other'), 'outside');
  await symlink(outside, join(root, 'escape'));
  await put('folder/inside', 'inside');
  await symlink(join(root, 'folder'), join(root, 'alias'));
  assert.equal((await run('read', { path: 'alias/inside' })).content, 'inside');
  assert.equal((await run('read', { path: join(root, 'folder/inside') })).content, 'inside');
  for (const path of ['../outside', join(outside, 'other'), 'escape/other', 'escape/new/file']) {
    await assert.rejects(run('read', { path }), /outside/u);
    await assert.rejects(run('write', { path, content: 'bad' }), /outside/u);
    await assert.rejects(run('edit', { path, edits: [{ oldText: 'outside', newText: 'bad' }] }), /outside/u);
  }
  assert.equal(await readFile(join(outside, 'other'), 'utf8'), 'outside');
  assert.deepEqual(await readdir(outside), ['other']);
});

test('exclusions are configurable and apply to canonical aliases, without a source-file allowlist', async (t) => {
  const { run, put, root } = await fixture(t, { exclude: ['credentials.fixture'] });
  await put('credentials.fixture', 'do not read');
  await put('.env.example', 'EXAMPLE=');
  await symlink(join(root, 'credentials.fixture'), join(root, 'alias'));
  await assert.rejects(run('read', { path: 'credentials.fixture' }), /excluded/u);
  await assert.rejects(run('read', { path: 'alias' }), /excluded/u);
  await assert.rejects(run('write', { path: 'credentials.fixture', content: 'changed' }), /excluded/u);
  assert.equal((await run('read', { path: '.env.example' })).content, 'EXAMPLE=');
  const custom = createFileTools({ root, exclude: [] }).find((tool) => tool.name === 'read');
  assert.ok(custom);
  const content = await custom.execute({ path: 'credentials.fixture' }, context());
  assert.equal((content as { content: string }).content, 'do not read');
});

test('find and grep honor nested gitignore negation, .ignore, globs and dot-project files', async (t) => {
  const { run, put } = await fixture(t);
  await put('.gitignore', '*.log\ncache/\n*.tmp\n');
  await put('.ignore', 'extra.txt\n');
  await put('src/.gitignore', '!keep.tmp\n');
  for (const path of [
    'a.ts',
    'src/b.ts',
    '.github/c.ts',
    'ignore.log',
    'cache/inside.ts',
    'src/keep.tmp',
    'src/drop.tmp',
    'extra.txt',
    'node_modules/dependency/index.ts',
  ]) {
    await put(path, 'needle\n');
  }
  assert.deepEqual((await run('find', { pattern: '*.ts' })).files, ['.github/c.ts', 'a.ts', 'src/b.ts']);
  assert.deepEqual((await run('find', { path: 'src', pattern: '*' })).files, ['.gitignore', 'b.ts', 'keep.tmp']);
  const search = await run('grep', { pattern: 'needle', glob: '*.ts' });
  assert.deepEqual(
    search.matches.map((match: { path: string }) => match.path),
    ['.github/c.ts', 'a.ts', 'src/b.ts'],
  );
  assert.equal(search.truncated, false);
  assert.equal((await run('read', { path: 'ignore.log' })).content, 'needle\n');
});

test('find, ls and grep return exact pagination and explicit traversal exhaustion', async (t) => {
  const { run, put } = await fixture(t);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await put(name, 'hit one\nhit two\n');
  const first = await run('find', { pattern: '*.txt', limit: 2 });
  assert.deepEqual(first.files, ['a.txt', 'b.txt']);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 2);
  assert.deepEqual((await run('find', { pattern: '*.txt', offset: 2 })).files, ['c.txt']);
  const listing = await run('ls', { limit: 1 });
  assert.deepEqual(listing.entries, [{ name: 'a.txt', type: 'file' }]);
  assert.equal(listing.nextOffset, 1);
  const search = await run('grep', { pattern: 'hit', limit: 3 });
  assert.equal(search.matches.length, 3);
  assert.equal(search.nextOffset, 3);
  const next = await run('grep', { pattern: 'hit', offset: 3, limit: 3 });
  assert.equal(next.truncated, false);
  assert.deepEqual(
    next.matches.map((item: { path: string; line: number }) => [item.path, item.line]),
    [
      ['b.txt', 2],
      ['c.txt', 1],
      ['c.txt', 2],
    ],
  );
});

test('search handles literals, case, context, invalid regex and skipped non-text files', async (t) => {
  const { run, put } = await fixture(t, { maxFileBytes: 100 });
  await put('file', 'before\nA.B\naXb\na.b\nafter\n');
  await put('binary', Buffer.from([0, 1, 2]));
  await put('large', 'x'.repeat(101));
  const result = await run('grep', { pattern: 'a.b', literal: true, ignoreCase: true, context: 1 });
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].line, 2);
  assert.deepEqual(result.matches[0].before, [{ line: 1, content: 'before' }]);
  assert.deepEqual(result.matches[0].after, [{ line: 3, content: 'aXb' }]);
  assert.equal(result.skippedFiles, 2);
  await assert.rejects(run('grep', { pattern: '[' }), /Invalid search pattern/u);
});

test('regex denial-of-service is deadline bounded and abort leaves no worker alive', async (t) => {
  const { run, put } = await fixture(t, { timeoutMs: 200 });
  await put('adversarial', `${'a'.repeat(100000)}!`);
  const start = Date.now();
  await assert.rejects(run('grep', { pattern: '(a+)+$' }), /timeout|aborted/iu);
  assert.ok(Date.now() - start < 3000);
});

test('bounded traversal signals incomplete discovery rather than claiming no matches', async (t) => {
  const { run, put } = await fixture(t, { maxTraversalEntries: 2 });
  for (const name of ['a', 'b', 'c', 'd']) await put(name, 'needle');
  const result = await run('find', { pattern: 'nothing' });
  assert.deepEqual(result.files, []);
  assert.equal(result.truncated, true);
  assert.equal(result.traversalTruncated, true);
  assert.match(result.reasons.join(' '), /traversal/u);
  assert.equal(result.nextOffset, undefined);
});

test('aborted reads and mutations fail before effects; temporary files are cleaned', async (t) => {
  const { tool, put, root } = await fixture(t);
  await put('file', 'original');
  const signal = AbortSignal.abort(new Error('cancelled'));
  for (const [name, args] of [
    ['read', { path: 'file' }],
    ['write', { path: 'new/child', content: 'data' }],
    ['edit', { path: 'file', edits: [{ oldText: 'original', newText: 'changed' }] }],
  ] as const) {
    await assert.rejects(tool(name).execute(args, { signal }), /cancelled/u);
  }
  assert.equal(await readFile(join(root, 'file'), 'utf8'), 'original');
  assert.deepEqual(await readdir(root), ['file']);
});

test('options reject invalid roots and resource budgets', () => {
  for (const options of [{ root: '.' }, { root: '/tmp', maxReadBytes: 0 }, { root: '/tmp', timeoutMs: NaN }]) {
    assert.throws(() => createFileTools(options));
  }
});

test('a small Unicode output budget errors instead of returning a non-progressing cursor', async (t) => {
  const { run, put } = await fixture(t, { maxReadBytes: 1 });
  await put('unicode', '世界');
  await assert.rejects(run('read', { path: 'unicode' }), /character exceeds/u);
});

test('oversize replacement and stale concurrent mutations leave original content intact', async (t) => {
  const { run, put, root } = await fixture(t, { maxFileBytes: 20 });
  await put('file', 'original');
  const original = await run('read', { path: 'file' });
  await assert.rejects(run('write', { path: 'new/deep/file', content: 'x'.repeat(21) }), /maxFileBytes/u);
  await assert.rejects(
    run('edit', { path: 'file', edits: [{ oldText: 'original', newText: 'x'.repeat(21) }] }),
    /operation limit/u,
  );
  assert.equal(await readFile(join(root, 'file'), 'utf8'), 'original');
  assert.deepEqual(await readdir(root), ['file']);
  const outcomes = await Promise.allSettled([
    run('write', { path: 'file', content: 'first', expectedHash: original.hash }),
    run('write', { path: 'file', content: 'second', expectedHash: original.hash }),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 1);
});

test('default exclusion policy allows environment examples and rejects sensitive path spellings without reading them', async (t) => {
  const { run, put } = await fixture(t);
  await put('nested/.env.example', 'PUBLIC_EXAMPLE=');
  await put('normal/tokenizer.ts', 'normal code');
  assert.equal((await run('read', { path: 'nested/.env.example' })).content, 'PUBLIC_EXAMPLE=');
  assert.equal((await run('read', { path: 'normal/tokenizer.ts' })).content, 'normal code');
  for (const path of ['.env', '.env.production', '.npmrc', '.ssh/id_ed25519']) {
    await assert.rejects(run('read', { path }), /excluded/u);
    await assert.rejects(run('write', { path, content: 'blocked' }), /excluded/u);
  }
});

test('glob matching includes dotfiles, brace alternatives and slash-specific paths', async (t) => {
  const { run, put } = await fixture(t);
  for (const path of ['.config.json', '.github/config.json', 'src/a.ts', 'src/test/b.js', 'src/a.txt'])
    await put(path, '{}');
  assert.deepEqual((await run('find', { pattern: '**/*.json' })).files, ['.config.json', '.github/config.json']);
  assert.deepEqual((await run('find', { pattern: 'src/**/*.{ts,js}' })).files, ['src/a.ts', 'src/test/b.js']);
});

test('discovery does not follow symlink cycles or escape directories', async (t) => {
  const { run, put, root } = await fixture(t);
  await put('inside/file.txt', 'hit');
  await symlink(root, join(root, 'inside/loop'));
  await symlink(tmpdir(), join(root, 'external'));
  assert.deepEqual((await run('find', { pattern: '*.txt' })).files, ['inside/file.txt']);
  const matches = (await run('grep', { pattern: 'hit' })).matches;
  assert.equal(matches.length, 1);
  const entries = (await run('ls', {})).entries;
  assert.deepEqual(entries, [
    { name: 'external', type: 'symlink' },
    { name: 'inside', type: 'directory' },
  ]);
});

test('inherited ignored parents cannot be re-included by a nested gitignore', async (t) => {
  const { run, put } = await fixture(t);
  await put('.gitignore', 'hidden/\n');
  await put('hidden/.gitignore', '!keep.txt\n');
  await put('hidden/keep.txt', 'hidden');
  assert.deepEqual((await run('find', { pattern: '*.txt' })).files, []);
});

test('nested ignore files can be disabled and depth exhaustion reports incompleteness', async (t) => {
  const { run, put } = await fixture(t, { respectGitignore: false, maxDepth: 1 });
  await put('.gitignore', '*.txt');
  await put('a.txt', 'visible');
  await put('one/b.txt', 'visible');
  await put('one/two/c.txt', 'too deep');
  const result = await run('find', { pattern: '*.txt' });
  assert.deepEqual(result.files, ['a.txt', 'one/b.txt']);
  assert.equal(result.traversalTruncated, true);
  assert.match(result.reasons.join(' '), /depth/u);
});

test('grep empty text is not a fabricated match and invalid patterns fail in empty trees', async (t) => {
  const { run, put } = await fixture(t);
  await assert.rejects(run('grep', { pattern: '[', path: '.' }), /Invalid search pattern/u);
  await put('empty', '');
  assert.deepEqual((await run('grep', { pattern: '' })).matches, []);
});

test('a complete read can be used verbatim as a BOM-preserving exact edit', async (t) => {
  const { run, put, root } = await fixture(t);
  await put('bom', '\uFEFForiginal\r\n');
  const original = await run('read', { path: 'bom' });
  await run('edit', { path: 'bom', edits: [{ oldText: original.content, newText: '\uFEFFchanged\n' }] });
  assert.equal(await readFile(join(root, 'bom'), 'utf8'), '\uFEFFchanged\r\n');
});

test('gitignore discovery is case-sensitive on case-sensitive platforms', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { run, put } = await fixture(t);
  await put('.gitignore', '*.log\n');
  await put('a.log', 'ignored');
  await put('b.LOG', 'visible');
  assert.deepEqual((await run('find', { pattern: '*.*' })).files, ['.gitignore', 'b.LOG']);
});
