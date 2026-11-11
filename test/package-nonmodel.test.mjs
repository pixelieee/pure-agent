import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installOfflinePackage } from './package-install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;

function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60000 });
  if (result.error || result.status !== 0) throw new Error('Package preflight subprocess failed.');
  return result.stdout;
}

test('installed package exports and CLI preflight work without a model', (t) => {
  assert.ok(npmCli, 'Run with npm run test:package:nonmodel');
  const consumer = mkdtempSync(join(tmpdir(), 'pure package nonmodel-'));
  t.after(() => rmSync(consumer, { recursive: true, force: true }));
  const [packed] = JSON.parse(
    run([npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', consumer], root),
  );
  const paths = packed.files.map((file) => file.path);
  assert.ok(paths.includes('dist/index.js'));
  assert.ok(paths.includes('dist/index.d.ts'));
  assert.ok(paths.includes('dist/cli.js'));
  assert.ok(
    paths.every(
      (path) =>
        path === 'package.json' ||
        path === 'README.md' ||
        path.startsWith('dist/') ||
        /^docs\/[^/]+\.(md|svg)$/.test(path),
    ),
  );
  assert.ok(!paths.some((path) => /(^|\/)(\.env[^/]*|node_modules|\.private)(\/|$)/i.test(path)));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const sourceLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  assert.deepEqual(sourceLock.packages[''].dependencies, manifest.dependencies);
  const dependencies = { [manifest.name]: `file:${packed.filename}` };
  const runtimePackages = Object.fromEntries(
    Object.entries(sourceLock.packages).filter(([path, entry]) => path !== '' && !entry.dev),
  );
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies,
      scripts: { 'preflight:pure': 'pure --help', 'preflight:alias': 'pure-agent --help' },
    }),
  );
  writeFileSync(
    join(consumer, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { dependencies },
        ...runtimePackages,
        [`node_modules/${manifest.name}`]: {
          version: manifest.version,
          resolved: `file:${packed.filename}`,
          integrity: packed.integrity,
          dependencies: manifest.dependencies,
          bin: manifest.bin,
          engines: manifest.engines,
        },
      },
    }),
  );
  installOfflinePackage(npmCli, consumer, (message) => t.diagnostic(message));
  for (const [path, entry] of Object.entries(runtimePackages)) {
    assert.equal(JSON.parse(readFileSync(join(consumer, path, 'package.json'), 'utf8')).version, entry.version);
  }
  const imports = Object.keys(manifest.exports).map((path) =>
    path === '.' ? manifest.name : `${manifest.name}/${path.slice(2)}`,
  );
  // Importing the real entrypoints does not instantiate a model or execute a request.
  const script = `import assert from 'node:assert/strict';
    for (const name of ${JSON.stringify(imports)}) assert.ok(Object.keys(await import(name)).length > 0);
    console.log('Package exports loaded.');`;
  assert.equal(run(['--input-type=module', '-e', script], consumer), 'Package exports loaded.\n');
  const typedEntry = join(consumer, 'consumer.mts');
  writeFileSync(
    typedEntry,
    `import type { Model, Tool } from 'pure-agent';
     import type { Model as CoreModel } from 'pure-agent/core';
     import type { DeveloperAgentOptions } from 'pure-agent/runtime';
     import { createFileTools } from 'pure-agent/tools/filesystem';
     declare const model: Model;
     const sameContract: CoreModel = model;
     const options: DeveloperAgentOptions = { model: sameContract, root: '.' };
     const tools: Tool[] = createFileTools({ root: '.' });
     void options;
     void tools;`,
  );
  // Compile consumer declarations only. The declared model is never constructed or invoked.
  run(
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--strict',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--typeRoots',
      join(root, 'node_modules/@types'),
      '--noEmit',
      typedEntry,
    ],
    consumer,
  );
  const primary = run([npmCli, 'run', '--silent', 'preflight:pure'], consumer);
  const alias = run([npmCli, 'run', '--silent', 'preflight:alias'], consumer);
  assert.equal(primary, alias);
  assert.match(primary, /OPENAI_API_KEY/);
  assert.match(primary, /Commands are NOT sandboxed/);
});
