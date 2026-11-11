import { types } from 'node:util';
import type { AgentCheckpoint, AgentSnapshot, RunResult } from './core.ts';
import { assertPlainData } from './record-data.ts';
import { createPrivateRecordStore, PrivateRecordError, recordCodeIs } from './private-record-store.ts';
import type { PrivateRecordStore } from './private-record-store.ts';
import { createRunJournal, reduceRunJournal, validateRunJournal, RunJournalError } from './run-journal.ts';
import type { RunJournalFence, RunJournalRecord } from './run-journal.ts';

export type TaskStatus = 'accepted' | 'running' | 'cancelling' | RunResult['status'] | 'failed';
/** settled means the owner's dispose promise settled successfully, not that external effects vanished. */
export type TaskCleanup = 'owned' | 'pending' | 'dispose_settled' | 'failed';
type Kind =
  | 'accepted'
  | 'running'
  | 'cancelling'
  | 'checkpoint'
  | 'failed'
  | 'cleanup_pending'
  | 'dispose_settled'
  | 'cleanup_failed';
export interface TaskEvent {
  sequence: number;
  kind: Kind;
  status: TaskStatus;
  cleanup: TaskCleanup;
}
export interface TaskRecord {
  format: 'pure-agent.task';
  version: 1;
  revision: number;
  requestId: string;
  input: string;
  run: RunJournalRecord;
  status: TaskStatus;
  cleanup: TaskCleanup;
  events: TaskEvent[];
}
export type TaskTransition =
  | { kind: Exclude<Kind, 'accepted' | 'checkpoint'> }
  | { kind: 'checkpoint'; checkpoint: AgentCheckpoint };
export type TaskRecordStore = PrivateRecordStore<TaskRecord, RunJournalFence, TaskTransition>;
export class TaskError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Task: ${code}`);
    this.name = 'TaskError';
    this.code = code;
  }
}
export function taskFail(code: string): never {
  throw new TaskError(code);
}
const data = (value: unknown) => assertPlainData(value, taskFail);
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return taskFail('INVALID');
  return value as Record<string, unknown>;
}
export const taskActive = (status: TaskStatus) => ['accepted', 'running', 'cancelling'].includes(status);
function advance(
  current: Pick<TaskEvent, 'status' | 'cleanup'>,
  kind: Kind,
  outcome?: RunJournalRecord['outcome'],
): Pick<TaskEvent, 'status' | 'cleanup'> {
  let { status, cleanup } = current;
  if (kind === 'running' && status === 'accepted' && cleanup === 'owned') status = 'running';
  else if (kind === 'cancelling' && ['accepted', 'running'].includes(status) && cleanup === 'owned')
    status = 'cancelling';
  else if (kind === 'checkpoint' && ['running', 'cancelling'].includes(status) && cleanup === 'owned') {
    if (outcome === 'interrupted' || outcome === 'failed') return taskFail('TRANSITION');
    status = outcome ?? status;
  } else if (kind === 'failed' && taskActive(status) && cleanup === 'owned') status = 'failed';
  else if (kind === 'cleanup_pending' && !taskActive(status) && cleanup === 'owned') cleanup = 'pending';
  else if (kind === 'dispose_settled' && cleanup === 'pending') cleanup = 'dispose_settled';
  else if (kind === 'cleanup_failed' && cleanup === 'pending') cleanup = 'failed';
  else return taskFail('TRANSITION');
  return { status, cleanup };
}
/** One-shot envelope only: runId is always 1. This does not implement restart or generations. */
export function validateTaskRecord(value: unknown): TaskRecord {
  data(value);
  const record = object(value, [
    'format',
    'version',
    'revision',
    'requestId',
    'input',
    'run',
    'status',
    'cleanup',
    'events',
  ]);
  if (record.format !== 'pure-agent.task' || record.version !== 1) return taskFail('VERSION');
  if (
    typeof record.requestId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/u.test(record.requestId) ||
    typeof record.input !== 'string' ||
    !record.input.trim()
  )
    return taskFail('INVALID');
  let run: RunJournalRecord;
  try {
    run = validateRunJournal(record.run);
  } catch {
    return taskFail('INVALID');
  }
  if (
    run.runId !== 1 ||
    run.phase === 'interrupted' ||
    !Array.isArray(record.events) ||
    !record.events.length ||
    record.events.length > 2048 ||
    record.revision !== record.events.length
  )
    return taskFail('INVALID');
  let state: Pick<TaskEvent, 'status' | 'cleanup'> = { status: 'accepted', cleanup: 'owned' };
  let runIndex = 0;
  const events = record.events.map((entry, index): TaskEvent => {
    const event = object(entry, ['sequence', 'kind', 'status', 'cleanup']);
    if (event.sequence !== index + 1) return taskFail('INVALID');
    const kind = event.kind as Kind;
    if (index === 0) {
      if (kind !== 'accepted') return taskFail('INVALID');
    } else {
      let outcome: RunJournalRecord['outcome'] = null;
      if (kind === 'checkpoint' || kind === 'failed') {
        const next = run.events[++runIndex];
        if (
          !next ||
          (kind === 'failed'
            ? next.phase !== 'failed'
            : !['before_model', 'before_tools', 'after_tools', 'terminal'].includes(next.phase))
        )
          return taskFail('INVALID');
        outcome = next.phase === 'terminal' ? run.outcome : null;
      }
      state = advance(state, kind, outcome);
    }
    if (event.status !== state.status || event.cleanup !== state.cleanup) return taskFail('INVALID');
    return { sequence: index + 1, kind, ...state };
  });
  if (
    runIndex !== run.events.length - 1 ||
    record.status !== state.status ||
    record.cleanup !== state.cleanup ||
    (run.outcome !== null && state.status !== run.outcome)
  )
    return taskFail('INVALID');
  return {
    format: 'pure-agent.task',
    version: 1,
    revision: events.length,
    requestId: record.requestId,
    input: record.input,
    run,
    ...state,
    events,
  };
}
export function createTaskRecord(
  taskId: string,
  requestId: string,
  input: string,
  snapshot: AgentSnapshot,
): TaskRecord {
  return validateTaskRecord({
    format: 'pure-agent.task',
    version: 1,
    revision: 1,
    requestId,
    input,
    run: createRunJournal(taskId, 1, snapshot),
    status: 'accepted',
    cleanup: 'owned',
    events: [{ sequence: 1, kind: 'accepted', status: 'accepted', cleanup: 'owned' }],
  });
}
export function taskFence(record: TaskRecord): RunJournalFence {
  return { taskId: record.run.taskId, runId: record.run.runId, revision: record.revision };
}
export function reduceTaskRecord(value: TaskRecord, fence: RunJournalFence, transition: TaskTransition): TaskRecord {
  data(fence);
  data(transition);
  object(fence, ['taskId', 'runId', 'revision']);
  const current = validateTaskRecord(value);
  if (fence.taskId !== current.run.taskId || fence.runId !== current.run.runId || fence.revision !== current.revision)
    return taskFail('CONFLICT');
  object(transition, transition.kind === 'checkpoint' ? ['kind', 'checkpoint'] : ['kind']);
  let run = current.run;
  if (transition.kind === 'checkpoint')
    run = reduceRunJournal(run, run, { kind: 'checkpoint', checkpoint: transition.checkpoint });
  else if (transition.kind === 'failed') run = reduceRunJournal(run, run, { kind: 'failed' });
  const state = advance(current, transition.kind, transition.kind === 'checkpoint' ? run.outcome : undefined);
  return validateTaskRecord({
    ...current,
    run,
    ...state,
    revision: current.revision + 1,
    events: [...current.events, { sequence: current.revision + 1, kind: transition.kind, ...state }],
  });
}
const safeCodes = new Set([
  'INVALID',
  'VERSION',
  'CONFLICT',
  'TRANSITION',
  'HISTORY',
  'PLATFORM',
  'PATH',
  'SIZE',
  'UNSAFE_PATH',
  'PERMISSIONS',
  'CORRUPT',
  'LOCKED',
  'EXISTS',
  'COMMIT_UNCERTAIN',
]);
function safeError(error: unknown): never {
  if (error && typeof error === 'object' && !types.isProxy(error)) {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (
      (error instanceof TaskError || error instanceof RunJournalError || error instanceof PrivateRecordError) &&
      safeCodes.has(code)
    )
      return taskFail(code);
  }
  if (recordCodeIs(error, 'ENOENT')) return taskFail('NOT_FOUND');
  if (recordCodeIs(error, 'EACCES') || recordCodeIs(error, 'EPERM')) return taskFail('PERMISSIONS');
  return taskFail('IO');
}
async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return safeError(error);
  }
}
export function createTaskRecordStore(options: { path: string; maxBytes?: number }): TaskRecordStore {
  data(options);
  object(options, ['path', 'maxBytes']);
  let store: TaskRecordStore;
  try {
    store = createPrivateRecordStore(options, {
      validate: validateTaskRecord,
      initial: (value) => {
        const initial = validateTaskRecord(value);
        if (initial.revision !== 1) return taskFail('INVALID');
        return initial;
      },
      reduce: reduceTaskRecord,
    });
  } catch (error) {
    return safeError(error);
  }
  return {
    path: store.path,
    load: () => guarded(() => store.load()),
    create: (record) => guarded(() => store.create(record)),
    transition: (fence, transition) =>
      guarded(async () => {
        data(fence);
        data(transition);
        return store.transition(structuredClone(fence), structuredClone(transition));
      }),
  };
}
