import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPrivateRecordStore } from '../src/private-record-store.ts';

// Exercise the shared primitive independently of journal/task reducers, using actual private files.
test('derived record validation fails before replacement and detaches retained reducer data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pure-private-record-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'record.json');
  function validate(value: unknown) {
    assert.ok(value && typeof value === 'object' && 'revision' in value);
    const revision = value.revision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new Error('INVALID');
    return { revision: revision as number };
  }
  const store = createPrivateRecordStore<{ revision: number }, { revision: number }, { increment: number }>(
    { path },
    {
      validate,
      initial: validate,
      reduce(record, fence, transition) {
        assert.equal(record.revision, fence.revision);
        const retained = { revision: record.revision + transition.increment };
        // A schema adapter may retain its result. Mutation after return must not corrupt the commit.
        queueMicrotask(() => {
          retained.revision = 0;
        });
        return retained;
      },
    },
  );
  const created = await store.create({ revision: Number.MAX_SAFE_INTEGER });
  const before = await readFile(path);
  await assert.rejects(store.transition(created, { increment: 1 }), { message: 'INVALID' });
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await store.load(), created);
  const reduced = await store.transition(created, { increment: -1 });
  assert.equal(reduced.revision, Number.MAX_SAFE_INTEGER - 1);
  assert.deepEqual(await store.load(), reduced);
});
