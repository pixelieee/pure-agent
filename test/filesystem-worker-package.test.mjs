import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const filesystemUrl = new URL('../dist/tools/filesystem.js', import.meta.url).href;

test('built filesystem grep works across caller module modes without dropping caller flags', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pure worker 空间 '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = `
    const { default: assert } = await import('node:assert/strict');
    const { createFileTools } = await import(${JSON.stringify(filesystemUrl)});
    const tools = new Map(createFileTools({ root: ${JSON.stringify(root)} }).map(tool => [tool.name, tool]));
    const run = (name, args) => tools.get(name).execute(args, { signal: new AbortController().signal });
    await run('write', { path: 'src 空间/file.txt', content: 'needle original\\n' });
    const result = await run('grep', { path: 'src 空间', pattern: 'needle' });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].path, 'src 空间/file.txt');
    const read = await run('read', { path: result.matches[0].path });
    assert.equal(read.content, 'needle original\\n');
    await run('edit', { path: result.matches[0].path, expectedHash: read.hash,
      edits: [{ oldText: 'original', newText: 'updated' }] });
    assert.equal((await run('read', { path: result.matches[0].path })).content, 'needle updated\\n');
    console.log('Real filesystem flow passed.');
  `;
  const entry = join(root, 'consumer 空间.mjs');
  writeFileSync(entry, script);
  for (const [name, args, input] of [
    ['mjs', [entry], undefined],
    ['module stdin', ['--input-type=module'], script],
    ['module eval', ['--input-type=module', '-e', script], undefined],
    [
      'commonjs stdin',
      ['--input-type=commonjs'],
      `(async () => { ${script} })().catch(error => { console.error(error); process.exitCode = 1; });`,
    ],
    ['prototype-disabled eval', ['--disable-proto=throw', '--input-type=module', '-e', script], undefined],
  ]) {
    await t.test(name, () => {
      const result = spawnSync(process.execPath, args, { input, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'Real filesystem flow passed.');
    });
  }
});
