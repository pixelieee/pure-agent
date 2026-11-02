import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// npm supplies its JS entry when invoked through npm run test:package. Running
// Node directly avoids npm.cmd / POSIX executable and shell-quoting differences.
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this test with npm run test:package');
const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd);
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1', npm_config_update_notifier: 'false' },
  });

test('private tarball installs as a JavaScript SDK and executable demo CLI', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'pure agent package-'));
  try {
    const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', consumer], root));
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
      paths.join('\n'),
    );
    assert.ok(!paths.some((path) => /(^|\/)(\.env[^/]*|node_modules|credentials)(\/|$)/i.test(path)));
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const sourceLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    assert.equal(sourceLock.lockfileVersion, 3);
    assert.deepEqual(sourceLock.packages[''].dependencies, manifest.dependencies);
    const dependencies = { [manifest.name]: `file:${packed.filename}` };
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies,
        // Static script text; npm resolves the actual platform bin shim. Keep a
        // multiword prompt to verify argument quoting, not merely entry loading.
        scripts: { 'smoke:cli': 'pure-agent --demo --prompt "Package smoke test"' },
      }),
    );
    // npm ci caches locked tarballs, not the registry packuments needed by an
    // unlocked install. Reuse the exact runtime graph (including integrity and
    // nested paths), adding the actual packed artifact as the consumer's root.
    const runtimePackages = Object.fromEntries(
      Object.entries(sourceLock.packages).filter(([path, entry]) => path !== '' && !entry.dev),
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
    npm(['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
    const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/pure-agent/package.json'), 'utf8'));
    assert.equal(installed.private, true);
    assert.deepEqual(installed.dependencies, manifest.dependencies);
    for (const [path, entry] of Object.entries(runtimePackages)) {
      assert.equal(JSON.parse(readFileSync(join(consumer, path, 'package.json'), 'utf8')).version, entry.version, path);
    }
    writeFileSync(
      join(consumer, 'smoke.mjs'),
      `
      import assert from 'node:assert/strict';
      import { createAgent } from 'pure-agent';
      const agent = createAgent({ model: { complete: async () => ({ role: 'assistant', content: 'Installed SDK works' }) } });
      assert.equal((await agent.run('Hello')).text, 'Installed SDK works');
      console.log('SDK smoke passed');
    `,
    );
    assert.match(run(process.execPath, ['smoke.mjs'], consumer), /SDK smoke passed/);
    writeFileSync(
      join(consumer, 'consumer.ts'),
      `
      import { createAgent, type Model, type RunResult } from 'pure-agent';
      const model: Model = { complete: async () => ({ role: 'assistant', content: 'Typed' }) };
      const result: RunResult = await createAgent({ model }).run('Hello');
      result.status satisfies 'completed' | 'blocked' | 'cancelled' | 'limit';
    `,
    );
    run(
      process.execPath,
      [
        join(root, 'node_modules/typescript/bin/tsc'),
        '--ignoreConfig',
        '--noEmit',
        '--strict',
        '--target',
        'ES2023',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        'consumer.ts',
      ],
      consumer,
    );
    const output = npm(['run', '--silent', 'smoke:cli'], consumer);
    assert.match(output, /DEMO/);
    assert.match(output, /Package smoke test/i);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});
