import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this test with npm test');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dependencies = realpathSync(join(root, 'node_modules'));
assert.equal(
  JSON.parse(readFileSync(join(dependencies, '@biomejs/biome/package.json'), 'utf8')).version,
  manifest.devDependencies['@biomejs/biome'],
  'Use the repository-pinned Biome, not a global installation',
);

// Copy only three real, small source files, plus the actual config and manifest.
// Quality checks syntax/style without executing these files or resolving imports.
const sources = ['src/index.ts', 'test/tool-details.test.ts', 'examples/basic.ts'];
function fixture(excluded, run) {
  const cwd = mkdtempSync(join(tmpdir(), 'pure agent quality '));
  try {
    const config = JSON.parse(readFileSync(join(root, 'biome.json'), 'utf8'));
    config.files.includes.push(...excluded.map((tree) => `!!${tree}`));
    const files = new Map([
      ['package.json', `${JSON.stringify(manifest, null, 2)}\n`],
      ['biome.json', `${JSON.stringify(config, null, 2)}\n`],
      ...sources.map((file) => [file, readFileSync(join(root, file), 'utf8')]),
    ]);
    for (const [file, contents] of files) {
      mkdirSync(dirname(join(cwd, file)), { recursive: true });
      writeFileSync(join(cwd, file), contents);
    }
    // Junctions work without Windows symlink privileges. No install or copying of
    // dependencies, private files, artifacts, or other repository content occurs.
    symlinkSync(dependencies, join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      run(cwd);
    } finally {
      for (const [file, contents] of files) {
        assert.equal(readFileSync(join(cwd, file), 'utf8'), contents, `quality must not modify ${file}`);
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function quality(cwd) {
  // npm's JS entry avoids npm.cmd and shell quoting differences on Windows.
  const result = spawnSync(process.execPath, [npmCli, 'run', 'quality'], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: '1', npm_config_update_notifier: 'false' },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'quality must finish normally');
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

test('quality accepts real source, test, and example fixtures without writing them', () => {
  fixture([], (cwd) => {
    const result = quality(cwd);
    assert.equal(result.status, 0, result.output);
  });
});

for (const tree of ['src', 'test', 'examples']) {
  test(`quality rejects an entirely excluded ${tree} tree without writing files`, () => {
    fixture([tree], (cwd) => {
      const result = quality(cwd);
      assert.notEqual(result.status, 0, result.output);
      assert.match(result.output, /No files were processed/, result.output);
    });
  });
}

test('quality rejects all source trees excluded even when root JSON files remain scannable', () => {
  fixture(['src', 'test', 'examples'], (cwd) => {
    const result = quality(cwd);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /No files were processed/, result.output);
  });
});
