import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createProcessTools, type ProcessExecutionResult, type ProcessReadResult } from '../src/tools/process.ts';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const ctx = () => ({ signal: new AbortController().signal });
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pure-process-tree-')));
  const set = createProcessTools({ root, killGraceMs: 40 });
  t.after(async () => {
    await set.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const invoke = (name: string, args: unknown, context = ctx()) => {
    const tool = set.tools.find((item) => item.name === name);
    assert.ok(tool);
    return tool.execute(args, context) as Promise<ProcessExecutionResult & ProcessReadResult>;
  };
  const parent = join(root, 'parent.cjs');
  const leaf = join(root, 'leaf.cjs');
  await writeFile(leaf, 'process.on("SIGTERM",()=>{});console.log("leaf:"+process.pid);setInterval(()=>{},1000);');
  await writeFile(
    parent,
    `const {spawn}=require('node:child_process');console.log('parent:'+process.pid);spawn(process.execPath,[${JSON.stringify(leaf)}],{stdio:'inherit'});setInterval(()=>{},1000);`,
  );
  return { root, set, invoke, command: `${quote(process.execPath)} ${quote(parent)}` };
}
async function waitForLeaf(invoke: Awaited<ReturnType<typeof fixture>>['invoke'], id: string) {
  let output = '';
  let cursor = 0;
  for (let i = 0; i < 20; i++) {
    const page = await invoke('read_process', { id, cursor, waitMs: 250 });
    output += page.output;
    cursor = page.nextCursor;
    if (output.match(/leaf:\d+/)) return output;
  }
  assert.fail(`Child never became ready: ${output}`);
}
async function stopped(pid: number) {
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0], 'Z', `process ${pid} is still running`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } else assert.throws(() => process.kill(pid, 0), /ESRCH/);
}

for (const action of ['kill', 'cancel', 'dispose'] as const) {
  test(`${action} kills ignored-TERM descendants and settles only after owned group cleanup`, {
    skip: process.platform === 'win32',
    timeout: 10_000,
  }, async (t) => {
    const { invoke, command, set } = await fixture(t);
    const controller = new AbortController();
    const started = await invoke('start_process', { command }, { signal: controller.signal });
    const output = await waitForLeaf(invoke, started.id);
    if (action === 'kill') await invoke('kill_process', { id: started.id });
    else if (action === 'dispose') await set.dispose();
    else {
      controller.abort();
      let page = await invoke('read_process', { id: started.id });
      while (page.status === 'running')
        page = await invoke('read_process', { id: started.id, cursor: page.nextCursor, waitMs: 250 });
    }
    const result = await invoke('process_status', { id: started.id });
    assert.equal(result.status, 'terminated');
    assert.equal(result.cleanupWarning, undefined);
    for (const match of output.matchAll(/(?:parent|leaf):(\d+)/g)) await stopped(Number(match[1]));
    assert.throws(() => process.kill(started.pid as number, 0), /ESRCH/);
  });
}

test('deadline kills a grandchild ignoring TERM and never hangs on inherited output', {
  skip: process.platform === 'win32',
  timeout: 10_000,
}, async (t) => {
  const { invoke, command } = await fixture(t);
  const result = await invoke('exec_command', { command, timeoutMs: 500 });
  assert.equal(result.terminationReason, 'timeout');
  assert.equal(result.status, 'terminated');
  assert.match(result.output, /leaf:/);
  for (const match of result.output.matchAll(/(?:parent|leaf):(\d+)/g)) await stopped(Number(match[1]));
});

test('successful parent exit does not strand background descendants holding output pipes', {
  skip: process.platform === 'win32',
  timeout: 10_000,
}, async (t) => {
  const { root, invoke } = await fixture(t);
  const script = join(root, 'orphan.cjs');
  await writeFile(
    script,
    `const {spawn}=require('node:child_process');spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});console.log("leaf:"+process.pid);setInterval(()=>{},1000)'],{stdio:'inherit'});setTimeout(()=>process.exit(0),250);`,
  );
  const started = Date.now();
  const result = await invoke('exec_command', { command: `${quote(process.execPath)} ${quote(script)}` });
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 0);
  assert.ok(Date.now() - started < 5000);
  for (const match of result.output.matchAll(/leaf:(\d+)/g)) await stopped(Number(match[1]));
});

test('repeated starts and kills do not leave live owned children or prevent runtime exit', {
  skip: process.platform === 'win32',
  timeout: 20_000,
}, async (t) => {
  const { invoke } = await fixture(t);
  for (let i = 0; i < 8; i++) {
    const result = await invoke('start_process', {
      command: `${quote(process.execPath)} -e 'setInterval(()=>{},1000)'`,
    });
    await invoke('kill_process', { id: result.id });
    await stopped(result.pid as number);
  }
  await delay(20);
});
