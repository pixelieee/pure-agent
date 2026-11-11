import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DeveloperAgentOptions } from '../src/developer-agent.ts';
import { authorizeTool } from '../src/tool-authorization.ts';
import { createFileTools } from '../src/tools/filesystem.ts';
import { createProcessTools } from '../src/tools/process.ts';

type Policy = NonNullable<DeveloperAgentOptions['authorize']>;
const context = () => ({ signal: new AbortController().signal });

// No model or agent fixtures: exercise the exact production boundary with real tools.
async function fixture(t: { after: (run: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'pure-authorization-'));
  const processes = createProcessTools({ root, inheritEnv: false });
  t.after(async () => {
    await processes.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const available = [...createFileTools({ root }), ...processes.tools];
  const tool = (name: string) => {
    const found = available.find((item) => item.name === name);
    assert.ok(found);
    return found;
  };
  return { root, tool };
}

test('omitted and undefined policies allow real filesystem and process effects', async (t) => {
  const { root, tool } = await fixture(t);
  await authorizeTool(tool('write'), root).execute({ path: 'file', content: 'written' }, context());
  await authorizeTool(tool('exec_command'), root, undefined).execute(
    { command: "printf 'executed' > command-result" },
    context(),
  );
  assert.equal(await readFile(join(root, 'file'), 'utf8'), 'written');
  assert.equal(await readFile(join(root, 'command-result'), 'utf8'), 'executed');
});

test('only boolean true permits effects; every configured decision applies again', async (t) => {
  const { root, tool } = await fixture(t);
  for (const value of [false, undefined, null, 0, 1, 'true', {}, []]) {
    const policy = (() => value) as Policy;
    for (const [name, args] of [
      ['write', { path: 'denied', content: 'unexpected' }],
      ['exec_command', { command: 'printf unexpected > denied-command' }],
    ] as const) {
      await assert.rejects(authorizeTool(tool(name), root, policy).execute(args, context()), /Permission denied/);
    }
  }
  assert.deepEqual(await readdir(root), []);
  let decisions = 0;
  const write = authorizeTool(tool('write'), root, () => ++decisions === 1);
  await write.execute({ path: 'file', content: 'approved' }, context());
  await assert.rejects(write.execute({ path: 'file', content: 'denied' }, context()), /Permission denied/);
  assert.equal(decisions, 2);
  assert.equal(await readFile(join(root, 'file'), 'utf8'), 'approved');
});

test('throw and rejection never fall back to execution', async (t) => {
  const { root, tool } = await fixture(t);
  for (const policy of [
    () => {
      throw new Error('policy failed');
    },
    async () => {
      throw new Error('policy failed');
    },
  ]) {
    await assert.rejects(
      authorizeTool(tool('write'), root, policy).execute({ path: 'file', content: 'bad' }, context()),
      /policy failed/,
    );
  }
  assert.deepEqual(await readdir(root), []);
});

test('policy sees detached args and the original extension tool name', async (t) => {
  const { root, tool } = await fixture(t);
  // A real file tool registered under an application name, not a fabricated model response.
  const extension = { ...tool('write'), name: 'application_write' };
  const args = { path: 'original', content: 'original content' };
  await authorizeTool(extension, root, (request, ctx) => {
    assert.equal(request.name, extension.name);
    assert.equal(request.workspaceRoot, root);
    assert.equal(ctx.signal.aborted, false);
    assert.notStrictEqual(request.args, args);
    (request.args as typeof args).path = 'changed';
    (request.args as typeof args).content = 'changed content';
    return true;
  }).execute(args, context());
  assert.deepEqual(args, { path: 'original', content: 'original content' });
  assert.equal(await readFile(join(root, 'original'), 'utf8'), 'original content');
  assert.deepEqual(await readdir(root), ['original']);
});

test('pre-abort, pending approval abort and abort during approval prevent effects', async (t) => {
  const { root, tool } = await fixture(t);
  const args = { path: 'file', content: 'bad' };
  for (const policy of [
    undefined,
    () => {
      throw new Error('must not ask');
    },
  ]) {
    await assert.rejects(
      authorizeTool(tool('write'), root, policy).execute(args, {
        signal: AbortSignal.abort(new Error('cancelled')),
      }),
      /cancelled/,
    );
  }
  const controller = new AbortController();
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let approve!: (value: boolean) => void;
  const decision = new Promise<boolean>((resolve) => {
    approve = resolve;
  });
  const execution = authorizeTool(tool('write'), root, () => {
    start();
    return decision;
  }).execute(args, { signal: controller.signal });
  const rejected = assert.rejects(execution, /cancelled/);
  await started;
  controller.abort(new Error('cancelled'));
  await rejected;
  approve(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const immediate = new AbortController();
  await assert.rejects(
    authorizeTool(tool('write'), root, () => {
      immediate.abort(new Error('cancelled'));
      return true;
    }).execute(args, { signal: immediate.signal }),
    /cancelled/,
  );
  assert.deepEqual(await readdir(root), []);
});

test('default permission does not bypass validation or filesystem escape checks', async (t) => {
  const { root, tool } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'pure-authorization-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'file'), 'preserved');
  await symlink(outside, join(root, 'escape'));
  const write = authorizeTool(tool('write'), root);
  for (const path of [join(outside, 'file'), 'escape/file', '../escaped']) {
    await assert.rejects(write.execute({ path, content: 'bad' }, context()), /outside/);
  }
  await assert.rejects(write.execute({ path: 'invalid', content: 12 }, context()));
  assert.equal(await readFile(join(outside, 'file'), 'utf8'), 'preserved');
  assert.deepEqual(await readdir(root), ['escape']);
});
