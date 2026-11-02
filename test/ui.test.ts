import test from 'node:test';
import stringWidth from 'string-width';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { createAgent } from '../src/core.ts';
import { createDemoAgent } from '../src/demo.ts';
import { SessionController, interactive } from '../src/ui/controller.ts';
import { TerminalView, safeText, wrapText } from '../src/ui/view.ts';

function capture(columns = 80, color = false) {
  let text = '';
  return {
    view: new TerminalView(
      {
        write: (part) => {
          text += part;
        },
        columns,
      },
      color,
    ),
    text: () => text,
  };
}
test('terminal content cannot execute ANSI, OSC, C0 or bidi controls', () => {
  assert.equal(safeText('\x1b[2Jhello\x1b]0;danger\x07\r\b\u202e!'), 'hello!');
});
test('plain fallback and narrow terminals contain no ANSI codes', () => {
  const out = capture(24, true);
  out.view.panel('USER', '\x1b[31mhello');
  assert.equal(out.text(), '[USER] hello\n');
  assert.deepEqual(wrapText('你好世界', 4), ['你好', '世界']);
});
test('deco theme renders distinct panels and safe content', () => {
  const out = capture(50, true);
  out.view.panel('TOOL', 'result');
  assert.match(out.text(), /┏━ TOOL/);
  assert.match(out.text(), /48;2;15;17;25/);
  for (const line of safeText(out.text()).trimEnd().split('\n')) assert.equal([...line].length, 50);
});
test('demo calls and resolves a real tool through core', async () => {
  const out = capture();
  const controller = new SessionController(createDemoAgent, out.view);
  const result = await controller.submit('  a   useful note ');
  assert.equal(result?.status, 'completed');
  assert.match(out.text(), /→ format_note/);
  assert.match(out.text(), /"note":"a useful note"/);
  assert.match(out.text(), /scripted fixture/);
});
test('create uses exact instructions and new restores a fresh session', async () => {
  const configurations: string[] = [];
  const out = capture();
  const controller = new SessionController((system) => {
    configurations.push(system);
    return createDemoAgent(system);
  }, out.view);
  await controller.submit('/create 用中文回答');
  assert.equal(configurations.at(-1), '用中文回答');
  await controller.submit('/new');
  assert.equal(configurations.at(-1), configurations[0]);
  await controller.submit('/create');
  assert.match(out.text(), /Usage/);
  await controller.submit('/help');
  assert.match(out.text(), /Show commands/);
  await controller.submit('/quit');
  assert.equal(controller.closed, true);
});
test('controller commands and ignored inputs resolve without a run result', async () => {
  const out = capture();
  const controller = new SessionController(createDemoAgent, out.view);
  for (const input of ['  ', '/help', '/new', '/create instructions', '/create', '/unknown', '/quit', 'after close']) {
    assert.equal(await controller.submit(input), undefined);
    assert.equal(controller.busy, false);
  }
  assert.doesNotMatch(out.text(), /\[USER\]/);
});
test('controller reports a rejected run, returns undefined, and permits a subsequent run', async () => {
  const out = capture();
  let rejectNext = true;
  const controller = new SessionController((system) => {
    const agent = createDemoAgent(system);
    return {
      ...agent,
      run: async (...args: Parameters<typeof agent.run>) => {
        if (rejectNext) {
          rejectNext = false;
          throw new Error('run rejected');
        }
        return agent.run(...args);
      },
    };
  }, out.view);
  assert.equal(await controller.submit('first'), undefined);
  assert.match(out.text(), /\[ERROR\] run rejected/);
  assert.equal(controller.busy, false);
  assert.equal(controller.closed, false);
  assert.equal((await controller.submit('second'))?.status, 'completed');
  assert.equal(controller.busy, false);
});
test('Ctrl+C cancels active run, leaves session open, then exits when idle', async () => {
  const out = capture();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const controller = new SessionController(
    (system) =>
      createAgent({
        system,
        model: {
          complete: async (_messages, _tools, signal) => {
            started();
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
            return { role: 'assistant', content: 'cancelled' };
          },
        },
      }),
    out.view,
  );
  const run = controller.submit('slow');
  await ready;
  controller.interrupt();
  assert.equal((await run)?.status, 'cancelled');
  assert.equal(controller.closed, false);
  assert.equal(controller.busy, false);
  controller.interrupt();
  assert.equal(controller.closed, true);
});
test('piped commands drain in order through EOF without hanging', async () => {
  const out = capture();
  const controller = new SessionController(createDemoAgent, out.view);
  await interactive(controller, Readable.from(['/create test\nfirst\n/new\nsecond\n/quit\nignored\n']), { write() {} });
  assert.equal((out.text().match(/completed · 2/g) ?? []).length, 2);
  assert.doesNotMatch(out.text(), /ignored/);
});
test('CLI requires explicit demo and supports one-shot prompt', () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['src/cli.ts', ...args], { encoding: 'utf8', timeout: 3000 });
  assert.equal(run().status, 2);
  assert.equal(run('--help').status, 0);
  assert.equal(run('--demo', '--prompt').status, 2);
  const demo = run('--demo', '--prompt', 'hello');
  assert.equal(demo.status, 0);
  assert.match(demo.stdout, /format_note/);
  assert.doesNotMatch(demo.stdout, /\x1b/);
});

test('controller takes presentation and default instructions from composition root', async () => {
  const out = capture();
  const systems: string[] = [];
  const controller = new SessionController(
    (system) => {
      systems.push(system);
      return createAgent({ system, model: { complete: async () => ({ role: 'assistant', content: 'ready' }) } });
    },
    out.view,
    {
      defaultSystem: 'injected policy',
      modeLabel: 'TEST',
      helpNote: 'Injected help',
      configurationNote: 'Injected config note',
    },
  );
  await controller.submit('/create temporary');
  await controller.submit('/new');
  await controller.submit('/help');
  await controller.submit('go');
  assert.deepEqual(systems, ['injected policy', 'temporary', 'injected policy']);
  assert.match(out.text(), /TEST · model step/);
  assert.match(out.text(), /Injected help/);
  assert.match(out.text(), /Injected config note/);
  assert.doesNotMatch(out.text(), /DEMO/);
});

test('busy controller rejects reset, configuration, and input without replacing active session', async () => {
  const out = capture();
  let factories = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new SessionController((system) => {
    factories++;
    return createAgent({
      system,
      model: {
        complete: async () => {
          await gate;
          return { role: 'assistant', content: 'finished' };
        },
      },
    });
  }, out.view);
  const running = controller.submit('first');
  assert.equal(controller.busy, true);
  await controller.submit('/new');
  await controller.submit('/create replacement');
  await controller.submit('second');
  assert.equal(factories, 1);
  assert.equal((out.text().match(/A run is already active/g) ?? []).length, 3);
  release();
  assert.equal((await running)?.status, 'completed');
  await controller.submit('/new');
  assert.equal(factories, 2);
});

test('wrapping preserves complete graphemes and terminal cell widths', () => {
  const graphemes = ['e\u0301', '你', '🇨🇳', '👍🏽', '👨‍👩‍👧‍👦', '1️⃣'];
  for (const grapheme of graphemes) {
    const width = stringWidth(grapheme);
    assert.deepEqual(wrapText(grapheme.repeat(3), width), [grapheme, grapheme, grapheme]);
    const lines = wrapText(`a${grapheme}b${grapheme}`, width + 1);
    assert.equal(lines.join(''), `a${grapheme}b${grapheme}`);
    assert.ok(lines.every((line) => stringWidth(line) <= width + 1));
    const originalClusters = [...new Intl.Segmenter().segment(`a${grapheme}b${grapheme}`)].map(
      ({ segment }) => segment,
    );
    const wrappedClusters = lines.flatMap((line) =>
      [...new Intl.Segmenter().segment(line)].map(({ segment }) => segment),
    );
    assert.deepEqual(wrappedClusters, originalClusters);
  }
});

test('deco panel padding measures graphemes rather than code points', () => {
  const out = capture(40, true);
  out.view.panel('AGENT', 'e\u0301 你好 🇨🇳 👍🏽 👨‍👩‍👧‍👦 1️⃣ '.repeat(5));
  for (const line of safeText(out.text()).trimEnd().split('\n')) assert.equal(stringWidth(line), 40);
});

test('wrapping preserves spaces and blank lines, strips malicious ANSI first', () => {
  assert.deepEqual(wrapText('  a  \n\n b ', 10), ['  a  ', '', ' b ']);
  assert.deepEqual(wrapText('ab    cd', 4), ['ab  ', '  cd']);
  assert.deepEqual(wrapText('a\x1b[2Jb\x1b]0;malicious\x07c\u202ed', 2), ['ab', 'cd']);
  assert.deepEqual(wrapText('', 8), ['']);
  assert.deepEqual(wrapText('a\n', 8), ['a', '']);
});

test('wrapping preserves exact NFD code points for copying code and tool output', () => {
  const input = 'const cafe\u0301 = "A\u030a e\u0301 o\u0308";';
  const lines = wrapText(input, 7);
  assert.equal(lines.join(''), input);
  assert.notEqual(lines.join(''), input.normalize('NFC'));
  assert.ok(lines.every((line) => stringWidth(line) <= 7));
});
