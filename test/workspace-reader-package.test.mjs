import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Use npm's JavaScript entry rather than platform-specific shell shims.
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this test with npm run test:package');
const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd);
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });

test('independent reader E2E: installed public SDK export executes real filesystem tool through core', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'pure reader consumer-'));
  try {
    const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', consumer], root));
    assert.ok(packed.files.some((f) => f.path === 'dist/workspace-file-tool.js'));
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const dependencies = { 'pure-agent': `file:${packed.filename}` };
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }));
    writeFileSync(
      join(consumer, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { dependencies },
          ...Object.fromEntries(Object.entries(lock.packages).filter(([path, entry]) => path && !entry.dev)),
          'node_modules/pure-agent': {
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
    writeFileSync(join(consumer, 'public.txt'), 'installed fixture');
    writeFileSync(join(consumer, 'ungranted.txt'), 'synthetic forbidden marker');
    writeFileSync(
      join(consumer, 'consumer.mjs'),
      `
      import assert from 'node:assert/strict';
      import { createAgent, createWorkspaceFileTool } from 'pure-agent';
      const tool = createWorkspaceFileTool({ root: process.cwd(), allowedFiles: ['public.txt'], maxBytes: 9 });
      let step = 0;
      // Deterministic model fixture; installed SDK/core/schema/filesystem remain real.
      const agent = createAgent({ tools: [tool], model: { complete: async messages => {
        if (++step === 1) return { role: 'assistant', content: null, tool_calls: [
          { id: 'read', type: 'function', function: { name: 'read_workspace_file', arguments: '{"path":"public.txt"}' } },
          { id: 'deny', type: 'function', function: { name: 'read_workspace_file', arguments: '{"path":"ungranted.txt"}' } }
        ] };
        const results = messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
        assert.deepEqual(results[0], { path: 'public.txt', content: 'installed', truncated: true });
        assert.equal(results[1].ok, false);
        assert.ok(!JSON.stringify(results).includes('synthetic forbidden marker'));
        return { role: 'assistant', content: 'PACKAGED READER VERIFIED' };
      } } });
      assert.equal((await agent.run('Read fixture')).text, 'PACKAGED READER VERIFIED');
      console.log('PACKAGED READER VERIFIED');
    `,
    );
    assert.match(run(process.execPath, ['consumer.mjs'], consumer), /PACKAGED READER VERIFIED/);
    writeFileSync(
      join(consumer, 'consumer.ts'),
      `
      import { createWorkspaceFileTool, type WorkspaceFileToolOptions, type Tool } from 'pure-agent';
      const options: WorkspaceFileToolOptions = { root: '/synthetic', allowedFiles: ['public.txt'], maxBytes: 10 };
      const tool: Tool = createWorkspaceFileTool(options);
      void tool;
    `,
    );
    run(
      process.execPath,
      [
        resolve(root, 'node_modules/typescript/bin/tsc'),
        '--ignoreConfig',
        '--noEmit',
        '--strict',
        '--skipLibCheck',
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
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});
