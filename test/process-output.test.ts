import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ProcessOutput } from '../src/tools/process-output.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, bytes = 256) {
  const root = await mkdtemp(join(tmpdir(), 'pure-output-'));
  const path = join(root, 'output.log');
  const file = await open(path, 'wx', 0o600);
  const failures: string[] = [];
  const output = new ProcessOutput(file, bytes, 1024 * 1024, (reason) => failures.push(reason));
  t.after(async () => {
    await output.close();
    await rm(root, { recursive: true, force: true });
  });
  return { output, path, file, failures };
}

test('byte cursor holds partial Unicode until complete without duplicating it', async (t) => {
  const { output } = await fixture(t);
  const bytes = Buffer.from('A😀B');
  await output.append(bytes.subarray(0, 3), 'stdout');
  const first = output.read(0, 4, false);
  assert.equal(first.output, 'A');
  assert.equal(first.nextCursor, 1);
  await output.append(bytes.subarray(3), 'stdout');
  const second = output.read(first.nextCursor, 4, false);
  assert.equal(second.output, '😀');
  assert.equal(second.nextCursor, 5);
  const third = output.read(second.nextCursor, 4, true);
  assert.equal(third.output, 'B');
  assert.equal(third.nextCursor, bytes.length);
});

test('malformed and truncated UTF-8 always advances completed cursor within text byte limit', async (t) => {
  const { output, path } = await fixture(t);
  const bytes = Buffer.from([0xe0, 0x80, 0x80, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80, 0xc0, 0xaf, 0xf0, 0x9f]);
  await output.append(bytes, 'stderr');
  let cursor = 0;
  for (let i = 0; cursor < bytes.length && i < 100; i++) {
    const page = output.read(cursor, 4, true);
    assert.ok(page.nextCursor > cursor);
    assert.ok(Buffer.byteLength(page.output) <= 4);
    cursor = page.nextCursor;
  }
  assert.equal(cursor, bytes.length);
  await output.close();
  assert.deepEqual(await readFile(path), bytes);
});

test('log errors are reported and never misreported as complete or persisted bytes', async (t) => {
  const { output, file, failures } = await fixture(t);
  await file.close();
  await output.append(Buffer.from('unwritten'), 'stdout');
  await output.close();
  assert.deepEqual(failures, ['log_error']);
  assert.equal(output.logComplete, false);
  assert.equal(output.logBytes, 0);
  assert.equal(output.snapshot(true).output, 'unwritten');
});
