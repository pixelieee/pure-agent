import { randomUUID } from 'node:crypto';
import type { AgentSnapshot, CheckpointCallback, RunOptions } from './core.ts';
import { assertPlainData } from './record-data.ts';
import { createTaskRecord, createTaskRecordStore, taskActive, taskFail, taskFence, TaskError } from './task-record.ts';
import type { TaskCleanup, TaskRecord, TaskStatus, TaskTransition } from './task-record.ts';

/** Must use the supplied awaited checkpoint callback and be exclusively owned by this host. */
export interface TaskRuntime {
  agent: {
    snapshot(): AgentSnapshot;
    run(input: string, options: RunOptions): Promise<unknown>;
  };
  /** Must settle owned operations; a successful return is not proof against escaped descendants. */
  dispose(): Promise<void>;
}
export interface TaskAccepted {
  taskId: string;
  runId: 1;
  status: 'accepted';
  cursor: 1;
}
export interface TaskState {
  taskId: string;
  runId: 1;
  cursor: number;
  status: TaskStatus;
  cleanup: TaskCleanup;
  phase: TaskRecord['run']['phase'];
  resources: 'unknown';
  host: {
    execution: 'idle' | 'scheduled' | 'running' | 'settled';
    disposal: 'not_started' | 'pending' | 'settled' | 'failed';
    fault: 'PERSISTENCE' | 'EXECUTION' | 'CLEANUP' | null;
  };
}
/** One task, one Agent, one run, one retained host. No restart, external worker or global resource lock. */
export function createTaskHost(options: {
  path: string;
  maxBytes?: number;
  createRuntime(checkpoint: CheckpointCallback): TaskRuntime;
}) {
  const store = createTaskRecordStore({
    path: options.path,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  const factory = options.createRuntime;
  if (typeof factory !== 'function') return taskFail('INVALID');
  const abort = new AbortController();
  const host: TaskState['host'] = { execution: 'idle', disposal: 'not_started', fault: null };
  let record: TaskRecord | undefined;
  let runtime: TaskRuntime | undefined;
  let attempted = false;
  let acceptingCheckpoints = false;
  let closing = false;
  let persistenceFailed = false;
  let work = Promise.resolve();
  let tail = Promise.resolve();
  let closure: Promise<TaskState | null> | undefined;
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  const state = (value: TaskRecord): TaskState => ({
    taskId: value.run.taskId,
    runId: 1,
    cursor: value.revision,
    status: value.status,
    cleanup: value.cleanup,
    phase: value.run.phase,
    resources: 'unknown',
    host: { ...host },
  });
  function persistenceFault(): never {
    persistenceFailed = true;
    host.fault = 'PERSISTENCE';
    abort.abort();
    return taskFail('PERSISTENCE');
  }
  async function persist(transition: TaskTransition) {
    if (!record || persistenceFailed) return taskFail('PERSISTENCE');
    try {
      record = await store.transition(taskFence(record), transition);
    } catch {
      return persistenceFault();
    }
  }
  function identify(taskId: string, expectedRunId = 1): TaskRecord {
    if (!record || taskId !== record.run.taskId) return taskFail('NOT_FOUND');
    if (expectedRunId !== 1) return taskFail('CONFLICT');
    return record;
  }
  async function read(taskId: string) {
    identify(taskId);
    const loaded = await store.load();
    if (loaded.run.taskId !== taskId) return taskFail('CONFLICT');
    return loaded;
  }
  const checkpoint: CheckpointCallback = (value) => {
    assertPlainData(value, taskFail);
    const detached = structuredClone(value);
    return serial(async () => {
      if (!acceptingCheckpoints || host.execution !== 'running') return taskFail('STALE_CALLBACK');
      await persist({ kind: 'checkpoint', checkpoint: detached });
    });
  };
  async function execute() {
    try {
      await serial(async () => {
        if (record?.status === 'accepted') await persist({ kind: 'running' });
        host.execution = 'running';
        acceptingCheckpoints = true;
      });
      if (!record || !runtime) return taskFail('EXECUTION');
      await runtime.agent.run(record.input, { signal: abort.signal });
      acceptingCheckpoints = false;
      if (!record.run.outcome) return taskFail('MISSING_TERMINAL');
    } catch {
      acceptingCheckpoints = false;
      host.fault ??= 'EXECUTION';
      if (!persistenceFailed && record && taskActive(record.status)) {
        try {
          await serial(() => persist({ kind: 'failed' }));
        } catch {
          /* The last acknowledged record is evidence, not permission to retry. */
        }
      }
    } finally {
      host.execution = 'settled';
    }
  }
  async function cancelCurrent() {
    if (!record || !taskActive(record.status)) return;
    if (record.status !== 'cancelling') await persist({ kind: 'cancelling' });
    abort.abort();
  }
  return {
    async start(input: string, request: { requestId: string }): Promise<TaskAccepted> {
      // Validate before entering the queue, including accessors; keep only detached primitives.
      assertPlainData(request, taskFail);
      if (!request || Object.keys(request).some((key) => key !== 'requestId'))
        return Promise.reject(new TaskError('INVALID'));
      const requestId = request.requestId;
      createTaskRecord('validation', requestId, input, { version: 1, messages: [] });
      return serial(async () => {
        if (closing) return taskFail('CLOSED');
        if (record) {
          if (record.requestId !== requestId || record.input !== input) return taskFail('CONFLICT');
          return { taskId: record.run.taskId, runId: 1, status: 'accepted', cursor: 1 };
        }
        if (attempted) return taskFail('START_FAILED');
        attempted = true;
        try {
          const created = factory(checkpoint);
          // Capture methods/receivers so later caller mutation cannot replace execution or cleanup.
          runtime = {
            agent: { snapshot: created.agent.snapshot.bind(created.agent), run: created.agent.run.bind(created.agent) },
            dispose: created.dispose.bind(created),
          };
          const initial = createTaskRecord(randomUUID(), requestId, input, runtime.agent.snapshot());
          try {
            record = await store.create(initial);
          } catch {
            return persistenceFault();
          }
        } catch (error) {
          host.fault ??= 'EXECUTION';
          if (error instanceof TaskError && error.code === 'PERSISTENCE') throw error;
          return taskFail('EXECUTION');
        }
        host.execution = 'scheduled';
        // The durable handle resolves through microtasks before this later host event-loop turn.
        work = new Promise<void>((resolve) =>
          setImmediate(() => {
            void execute().then(resolve);
          }),
        );
        return { taskId: record.run.taskId, runId: 1, status: 'accepted', cursor: 1 };
      });
    },
    get(taskId: string): Promise<TaskState> {
      return serial(async () => state(await read(taskId)));
    },
    cancel(taskId: string, expectedRunId: number): Promise<TaskState> {
      return serial(async () => {
        identify(taskId, expectedRunId);
        await cancelCurrent();
        return state(await read(taskId));
      });
    },
    events(taskId: string, afterCursor = 0, limit = 100) {
      return serial(async () => {
        const current = await read(taskId);
        if (
          !Number.isSafeInteger(afterCursor) ||
          afterCursor < 0 ||
          afterCursor > current.revision ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 256
        )
          return taskFail('CURSOR');
        const events = current.events.slice(afterCursor, afterCursor + limit);
        const cursor = events.at(-1)?.sequence ?? afterCursor;
        return { taskId, runId: 1 as const, events, cursor, hasMore: cursor < current.revision };
      });
    },
    close({ mode }: { mode: 'drain' | 'cancel' }): Promise<TaskState | null> {
      if (mode !== 'drain' && mode !== 'cancel') return Promise.reject(new TaskError('INVALID'));
      // First close chooses the mode. Call cancel separately to upgrade an ongoing drain.
      closure ??= (async () => {
        await serial(async () => {
          closing = true;
          if (mode === 'cancel') {
            try {
              await cancelCurrent();
            } catch {
              abort.abort();
            }
          }
        });
        await work;
        if (runtime) {
          if (record && !persistenceFailed) {
            try {
              await serial(() => persist({ kind: 'cleanup_pending' }));
            } catch {
              /* Still dispose. */
            }
          }
          host.disposal = 'pending';
          try {
            await runtime.dispose();
            host.disposal = 'settled';
          } catch {
            host.disposal = 'failed';
            host.fault ??= 'CLEANUP';
          }
          if (record && !persistenceFailed) {
            try {
              await serial(() => persist({ kind: host.disposal === 'settled' ? 'dispose_settled' : 'cleanup_failed' }));
            } catch {
              /* Report the storage fault without replaying disposal. */
            }
          }
        }
        if (persistenceFailed) return taskFail('PERSISTENCE');
        if (host.disposal === 'failed') return taskFail('CLEANUP');
        return record ? state(await read(record.run.taskId)) : null;
      })();
      return closure;
    },
  };
}
