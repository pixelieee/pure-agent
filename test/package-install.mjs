import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

const timeout = 60_000;
const logBytes = 64 * 1024;

// npm warns that its debug logs may contain secrets. Timer names are not
// inherently safe: allow only fixed npm phases and this fixture's package paths.
const timerNames = new Set([
  'npm',
  'config:load:flatten',
  'arborist:ctor',
  'npm-ci:rm',
  'command:ci',
  ...Object.entries({
    'npm:load': ['whichnode', 'configload', 'mkdirpcache', 'mkdirplogs', 'setTitle'],
    idealTree: ['init', 'userRequests', 'buildDeps', 'fixDepFlags'],
    reify: [
      'loadTrees',
      'diffTrees',
      'retireShallow',
      'createSparse',
      'loadBundles',
      'loadShrinkwraps',
      'unpack',
      'unretire',
      'build',
      'trash',
      'save',
      'audit',
    ],
    build: ['queue', 'link', 'deps', 'bundle'],
  }).flatMap(([phase, steps]) => [phase, ...steps.map((step) => `${phase}:${step}`)]),
]);

export function npmDiagnosticLines(log, packagePaths = []) {
  const allowed = new Set(timerNames);
  for (const path of packagePaths) {
    allowed.add(`reifyNode:${path}`);
    allowed.add(`build:link:${path}`);
  }
  return log
    .split(/\r?\n/)
    .map((line) => line.replace(/^(?:\d+|npm)\s+/, ''))
    .filter((line) => {
      const timing = /^timing (\S+) Completed in \d+ms$/.exec(line);
      return (
        (timing && allowed.has(timing[1])) ||
        /^(?:info using (?:npm|node)@v?[\d.]+|silly idealTree (?:buildDeps|inflate|init|userRequests)|(?:verbose|error) (?:code|exit) [A-Z0-9_-]+)$/.test(
          line,
        )
      );
    });
}

function logTail(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, logBytes));
    const length = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - logBytes));
    return buffer.toString('utf8', 0, length);
  } finally {
    closeSync(fd);
  }
}

export function installOfflinePackage(npmCli, consumer, diagnostic) {
  assert.ok(npmCli, 'Run this test with npm run test:package');
  const logs = join(consumer, '.npm-install-diagnostics');
  const start = performance.now();
  const result = spawnSync(
    process.execPath,
    [
      npmCli,
      'ci',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--timing',
      '--loglevel=verbose',
      `--logs-dir=${logs}`,
    ],
    {
      cwd: consumer,
      encoding: 'utf8',
      timeout,
      // Preserve the original pipe topology while diagnosing the Windows hang.
      stdio: 'pipe',
      env: { ...process.env, NO_COLOR: '1', npm_config_update_notifier: 'false' },
    },
  );
  const elapsedMs = Math.round(performance.now() - start);
  const failed = result.error || result.status !== 0;
  diagnostic(
    `Offline npm ci: ${JSON.stringify({
      platform: process.platform,
      node: process.version,
      elapsedMs,
      timeoutMs: timeout,
      status: result.status,
      signal: result.signal,
      errorCode: result.error?.code,
    })}`,
  );
  try {
    // The timing JSON is written only at npm exit, so a timeout needs the live
    // debug log / captured stderr instead. Read no more than two bounded tails.
    const files = existsSync(logs)
      ? readdirSync(logs)
          .filter((name) => name.endsWith('-debug-0.log'))
          .sort()
          .slice(-1)
      : [];
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
    const packages = Object.keys(lock.packages).filter((path) => path.startsWith('node_modules/'));
    const events = [...files.map((name) => logTail(join(logs, name))), result.stderr?.slice(-logBytes) ?? ''];
    const lines = [...new Set(events.flatMap((event) => npmDiagnosticLines(event, packages)))];
    diagnostic(`npm phase records (${lines.length} records):\n${lines.slice(-80).join('\n') || '(none)'}`);
    if (failed) {
      const missing = packages.filter((path) => !existsSync(join(consumer, path, 'package.json')));
      diagnostic(`Package manifests present: ${packages.length - missing.length}/${packages.length}`);
      diagnostic(
        `Missing package manifests: ${JSON.stringify(missing.slice(0, 40))}; omitted=${Math.max(0, missing.length - 40)}`,
      );
    }
  } catch {
    // Diagnostic collection must not hide or turn an install failure into a pass.
    diagnostic('Additional npm diagnostics unavailable.');
  }
  if (failed) {
    // Do not attach the raw spawn result: node:test would print its unfiltered
    // stdout/stderr, bypassing the diagnostic allowlist above.
    throw new Error(
      `Offline npm ci failed after ${elapsedMs}ms (code=${result.error?.code ?? 'none'}, status=${result.status}, signal=${result.signal}); see package diagnostics`,
    );
  }
}
