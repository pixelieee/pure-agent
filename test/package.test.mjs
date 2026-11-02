import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args, cwd) => execFileSync(command, args, {
  cwd, encoding: 'utf8', timeout: 60_000,
  env: { ...process.env, NO_COLOR: '1', npm_config_update_notifier: 'false' },
});

test('private tarball installs as a JavaScript SDK and executable demo CLI', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'pure-agent-package-'));
  try {
    const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', consumer], root));
    const paths = packed.files.map(file => file.path);
    assert.ok(paths.includes('dist/index.js'));
    assert.ok(paths.includes('dist/index.d.ts'));
    assert.ok(paths.includes('dist/cli.js'));
    assert.ok(paths.every(path => path === 'package.json' || path === 'README.md' || path.startsWith('dist/') || /^docs\/[^/]+\.(md|svg)$/.test(path)), paths.join('\n'));
    assert.ok(!paths.some(path => /(^|\/)(\.env[^/]*|node_modules|credentials)(\/|$)/i.test(path)));
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(consumer, packed.filename)], consumer);
    const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/pure-agent/package.json'), 'utf8'));
    assert.equal(installed.private, true);
    writeFileSync(join(consumer, 'smoke.mjs'), `
      import assert from 'node:assert/strict';
      import { createAgent } from 'pure-agent';
      const agent = createAgent({ model: { complete: async () => ({ role: 'assistant', content: 'Installed SDK works' }) } });
      assert.equal((await agent.run('Hello')).text, 'Installed SDK works');
      console.log('SDK smoke passed');
    `);
    assert.match(run(process.execPath, ['smoke.mjs'], consumer), /SDK smoke passed/);
    writeFileSync(join(consumer, 'consumer.ts'), `
      import { createAgent, type Model, type RunResult } from 'pure-agent';
      const model: Model = { complete: async () => ({ role: 'assistant', content: 'Typed' }) };
      const result: RunResult = await createAgent({ model }).run('Hello');
      result.status satisfies 'completed' | 'blocked' | 'cancelled' | 'limit';
    `);
    run(join(root, 'node_modules/.bin/tsc'), ['--ignoreConfig', '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], consumer);
    const output = run(join(consumer, 'node_modules/.bin/pure-agent'), ['--demo', '--prompt', 'Package smoke test'], consumer);
    assert.match(output, /DEMO/);
    assert.match(output, /Package smoke test/i);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});
