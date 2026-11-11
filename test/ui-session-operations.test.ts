import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import type { Terminal, ProgramStatus } from '@earendil-works/pi-tui';
import { createAgent } from '../src/core.ts';
import { createOpenAIModel } from '../src/providers/openai.ts';
import { createSessionStore } from '../src/session.ts';
import { SessionController, type SessionPersistence } from '../src/ui/controller.ts';
import { PureAgentTUI } from '../src/ui/tui.ts';
import { safeText } from '../src/ui/view.ts';

/** UI transport only. There is no simulated model response in this file. */
class OperationTerminal implements Terminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  input?: (data: string) => void;
  start(input: (data: string) => void, _resize: () => void) {
    this.input = input;
  }
  stop() {}
  async drainInput() {}
  write(_text: string) {}
  moveBy(_lines: number) {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(_title: string) {}
  setProgress(_active: boolean) {}
  setProgramStatus(_status: ProgramStatus) {}
}

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

async function setup(t: test.TestContext, pauseSave?: Promise<void>, pauseLoad?: Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pure-ui-operations-'));
  const terminal = new OperationTerminal();
  const ui = new PureAgentTUI({ terminal, modeLabel: 'UI inspection · no model requests', workspace: root });
  let requests = 0;
  // Use the real provider and core for command-only work. This tripwire never
  // returns an API response and fails if any operation tries to use the network.
  const client = new OpenAI({
    apiKey: 'unused-command-only-check',
    fetch: async () => {
      requests++;
      throw new Error('Network is prohibited in command-only UI checks');
    },
  });
  const factory = (system: string) => createAgent({ system, model: createOpenAIModel({ client }) });
  const path = join(root, 'session.json');
  const store = createSessionStore({ path, identity: { provider: 'openai', model: 'unused', workspaceRoot: root } });
  let selected = false;
  const storage: SessionPersistence = {
    async save(agent, requested) {
      await pauseSave;
      if (!selected && !requested) return undefined;
      await store.save(agent.snapshot());
      selected = true;
      return path;
    },
    async load(requested) {
      await pauseLoad;
      const selectedStore =
        requested === 'session.json'
          ? store
          : createSessionStore({
              path: join(root, requested),
              identity: { provider: 'openai', model: 'unused', workspaceRoot: root },
            });
      const record = await selectedStore.load();
      return { snapshot: record.snapshot, activate: () => (selected = true) };
    },
    reset() {
      selected = false;
    },
  };
  const controller = new SessionController(factory, ui, {
    defaultSystem: 'Original instructions',
    persistence: storage,
  });
  ui.attach(controller);
  ui.start();
  const screen = () => {
    ui.tui.renderNow();
    return ui.tui.getScreenLines().map(safeText).join('\n');
  };
  t.after(async () => {
    ui.stop();
    await controller.dispose();
    await rm(root, { recursive: true, force: true });
    assert.equal(requests, 0, 'No model/API request may be attempted');
  });
  return { terminal, ui, controller, storage, store, path, root, screen };
}

test('real save shows waiting state, retains draft and rejects repeated commands without cancellation', async (t) => {
  const save = gate();
  const { ui, controller, path, screen } = await setup(t, save.wait);
  t.after(() => save.release());
  ui.editor.setText('next draft');
  const pending = controller.submit('/save session.json');
  assert.equal(controller.busy, true);
  assert.equal(controller.cancellable, false);
  assert.match(screen(), /saving session · please wait/);
  assert.match(screen().split('\n').at(-1) ?? '', /Please wait$/);
  assert.doesNotMatch(screen().split('\n').at(-1) ?? '', /Enter send|cancel/);
  controller.interrupt();
  assert.equal(controller.closed, false);
  assert.match(screen(), /Waiting for the session operation to finish/);
  await controller.submit('/new');
  assert.match(screen(), /A session operation is active/);
  save.release();
  await pending;
  assert.equal(controller.busy, false);
  assert.equal(ui.editor.getText(), 'next draft');
  assert.match(screen(), /ready · session saved/);
  const record = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(record.snapshot.messages[0].content, 'Original instructions');
});

test('real restore shows progress then recorded-session status without executing a model', async (t) => {
  const load = gate();
  const { controller, screen } = await setup(t, undefined, load.wait);
  t.after(() => load.release());
  await controller.submit('/save session.json');
  const pending = controller.submit('/resume session.json');
  assert.equal(controller.cancellable, false);
  assert.match(screen(), /restoring session · please wait/);
  controller.interrupt();
  assert.equal(controller.closed, false);
  load.release();
  await pending;
  assert.equal(controller.busy, false);
  assert.match(screen(), /ready · restored session/);
  assert.match(screen().replace(/\s+/g, ' '), /Previous tools were not rerun/);
  assert.doesNotMatch(screen(), /working · model step/);
});

test('actual missing file and missing save target produce failed status then permit retry', async (t) => {
  const { controller, screen } = await setup(t);
  await controller.submit('/resume missing.json');
  assert.match(screen(), /restore failed · check error/);
  assert.equal(controller.busy, false);
  await controller.submit('/save');
  assert.match(screen(), /save failed · retry \/save/);
  assert.match(screen(), /No session file selected/);
  await controller.submit('/save session.json');
  assert.match(screen(), /ready · session saved/);
  assert.equal(controller.busy, false);
});

test('new and create reset actual core snapshots without model generation or deleting saved files', async (t) => {
  const { controller, path, screen } = await setup(t);
  await controller.submit('/save session.json');
  const before = await readFile(path, 'utf8');
  await controller.submit('/new');
  assert.match(screen(), /ready · new session/);
  assert.equal(await readFile(path, 'utf8'), before);
  await controller.submit('/save');
  assert.match(screen(), /No session file selected/);
  await controller.submit('/create Revised instructions');
  assert.match(screen(), /ready · new session/);
  assert.match(screen(), /System instruction: Revised instructions/);
});

test('busy action hints never offer send, and run-error rendering invents no model result', async (t) => {
  const { ui, root, screen } = await setup(t);
  ui.attach({ busy: true, cancellable: true, closed: false, submit: async () => undefined, interrupt() {} });
  assert.match(screen().split('\n').at(-1) ?? '', /Draft only.*cancel$/);
  assert.doesNotMatch(screen().split('\n').at(-1) ?? '', /Enter send/);
  let error: unknown;
  try {
    await readFile(join(root, 'missing-file'), 'utf8');
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  ui.runError(error.message);
  assert.match(screen(), /run failed · check error/);
  assert.doesNotMatch(screen(), /0 model steps|completed/);
  ui.setStatus('waiting\nfor\x1b[2Jstorage');
  assert.match(screen(), /waiting forstorage/);
});

test('real failed saves and restores preserve drafts and history without echoing failure paths', async (t) => {
  const { ui, controller, path, screen } = await setup(t);
  await controller.submit('/save session.json');
  const saved = await readFile(path, 'utf8');
  ui.editor.setText('unsent draft 你好');
  await controller.submit('/resume private-missing-session.json');
  assert.equal(ui.editor.getText(), 'unsent draft 你好');
  assert.match(screen(), /Session restore failed/);
  assert.doesNotMatch(screen(), /private-missing-session|ENOENT/);
  assert.equal(await readFile(path, 'utf8'), saved);
  await mkdir(`${path}.lock`);
  await controller.submit('/save session.json');
  assert.match(screen(), /Session save failed/);
  assert.match(screen(), /save failed · retry \/save/);
  assert.doesNotMatch(screen(), /Session is locked|EEXIST/);
  assert.equal(ui.editor.getText(), 'unsent draft 你好');
  assert.equal(await readFile(path, 'utf8'), saved);
  await rm(`${path}.lock`, { recursive: true });
  await controller.submit('/save session.json');
  assert.match(screen(), /ready · session saved/);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).snapshot.messages[0].content, 'Original instructions');
});
