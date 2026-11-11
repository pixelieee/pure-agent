import { types } from 'node:util';
import { assertPlainData } from './record-data.ts';
import { createPrivateRecordStore, PrivateRecordError, recordCodeIs as codeIs } from './private-record-store.ts';
import type { PrivateRecordStore } from './private-record-store.ts';
import type { AgentCheckpoint } from './checkpoint.ts';
import { validateAgentSnapshot } from './core.ts';
import type { AgentSnapshot, RunResult } from './core.ts';

type Phase = 'accepted' | AgentCheckpoint['stage'] | 'interrupted' | 'failed';
export interface RunJournalFence {
  taskId: string;
  runId: number;
  revision: number;
}
export interface RunJournalRecord extends RunJournalFence {
  format: 'pure-agent.run-journal';
  version: 1;
  snapshot: AgentSnapshot;
  phase: Phase;
  outcome: RunResult['status'] | 'interrupted' | 'failed' | null;
  /** No claim about processes, MCP connections, workspace ownership, or external effects. */
  resources: 'unknown';
  pendingTools: { id: string; name: string }[] | null;
  events: { sequence: number; phase: Phase }[];
}
export type RunJournalTransition =
  | { kind: 'checkpoint'; checkpoint: AgentCheckpoint }
  | { kind: 'interrupted' | 'failed' };
export class RunJournalError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Run journal: ${code}`);
    this.name = 'RunJournalError';
    this.code = code;
  }
}
function fail(code: string): never {
  throw new RunJournalError(code);
}
const phases: Phase[] = [
  'accepted',
  'before_model',
  'before_tools',
  'after_tools',
  'terminal',
  'interrupted',
  'failed',
];
const outcomes = ['completed', 'blocked', 'cancelled', 'limit', 'interrupted', 'failed'];
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const identifier = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(s);
const plainData = (value: unknown) => assertPlainData(value, fail);
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
    if ((error instanceof RunJournalError || error instanceof PrivateRecordError) && safeCodes.has(code))
      return fail(code);
  }
  if (codeIs(error, 'ENOENT')) return fail('NOT_FOUND');
  if (codeIs(error, 'EACCES') || codeIs(error, 'EPERM')) return fail('PERMISSIONS');
  if (codeIs(error, 'ELOOP')) return fail('UNSAFE_PATH');
  return fail('IO');
}
async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return safeError(error);
  }
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    return fail('INVALID');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor?.enumerable || !('value' in descriptor))
      return fail('INVALID');
  }
  return value as Record<string, unknown>;
}
function canFollow(previous: Phase, next: Phase): boolean {
  if (['terminal', 'interrupted', 'failed'].includes(previous)) return false;
  if (next === 'interrupted' || next === 'failed') return true;
  if (next === 'terminal') return previous !== 'before_tools';
  if (next === 'before_model') return previous === 'accepted' || previous === 'after_tools';
  if (next === 'before_tools') return previous === 'before_model';
  return next === 'after_tools' && previous === 'before_tools';
}
function calls(value: unknown): { id: string; name: string }[] {
  if (!Array.isArray(value) || !value.length || value.length > 1024) return fail('INVALID');
  const ids = new Set<string>();
  return value.map((entry) => {
    const item = object(entry, ['id', 'name']);
    if (
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 1024 ||
      typeof item.name !== 'string' ||
      !item.name ||
      item.name.length > 1024 ||
      ids.has(item.id)
    )
      return fail('INVALID');
    ids.add(item.id);
    return { id: item.id, name: item.name };
  });
}
/** Detached, complete conversation only. This does not authorize replay or prove resource cleanup. */
export function validateRunJournal(value: unknown): RunJournalRecord {
  plainData(value);
  const data = object(value, [
    'format',
    'version',
    'taskId',
    'runId',
    'revision',
    'snapshot',
    'phase',
    'outcome',
    'resources',
    'pendingTools',
    'events',
  ]);
  if (data.format !== 'pure-agent.run-journal' || data.version !== 1) return fail('VERSION');
  if (!identifier(data.taskId) || !positive(data.runId) || !positive(data.revision) || data.resources !== 'unknown')
    return fail('INVALID');
  if (
    !Array.isArray(data.events) ||
    !data.events.length ||
    data.events.length > 1024 ||
    data.revision !== data.events.length
  )
    return fail('INVALID');
  const events = data.events.map((entry, index) => {
    const event = object(entry, ['sequence', 'phase']);
    if (event.sequence !== index + 1 || !phases.includes(event.phase as Phase)) return fail('INVALID');
    return { sequence: index + 1, phase: event.phase as Phase };
  });
  if (events[0].phase !== 'accepted') return fail('INVALID');
  for (let i = 1; i < events.length; i++) if (!canFollow(events[i - 1].phase, events[i].phase)) return fail('INVALID');
  const phase = events[events.length - 1].phase;
  if (data.phase !== phase) return fail('INVALID');
  const terminal = ['terminal', 'interrupted', 'failed'].includes(phase);
  if (terminal ? !outcomes.includes(data.outcome as string) : data.outcome !== null) return fail('INVALID');
  if ((phase === 'failed' || phase === 'interrupted') && data.outcome !== phase) return fail('INVALID');
  if (phase === 'terminal' && ['failed', 'interrupted'].includes(data.outcome as string)) return fail('INVALID');
  const lastBoundary = events.findLast((event) => !['failed', 'interrupted'].includes(event.phase))?.phase;
  if ((lastBoundary === 'before_tools') !== (data.pendingTools !== null)) return fail('INVALID');
  let snapshot: AgentSnapshot;
  try {
    snapshot = validateAgentSnapshot(data.snapshot);
  } catch {
    return fail('INVALID');
  }
  return {
    format: 'pure-agent.run-journal',
    version: 1,
    taskId: data.taskId,
    runId: data.runId,
    revision: data.revision,
    snapshot,
    phase,
    outcome: data.outcome as RunJournalRecord['outcome'],
    resources: 'unknown',
    pendingTools: data.pendingTools === null ? null : calls(data.pendingTools),
    events,
  };
}
export function createRunJournal(taskId: string, runId: number, snapshot: AgentSnapshot): RunJournalRecord {
  return validateRunJournal({
    format: 'pure-agent.run-journal',
    version: 1,
    taskId,
    runId,
    revision: 1,
    snapshot,
    phase: 'accepted',
    outcome: null,
    resources: 'unknown',
    pendingTools: null,
    events: [{ sequence: 1, phase: 'accepted' }],
  });
}
function matches(record: RunJournalRecord, fence: RunJournalFence): boolean {
  return record.taskId === fence.taskId && record.runId === fence.runId && record.revision === fence.revision;
}
export function reduceRunJournal(
  value: RunJournalRecord,
  fence: RunJournalFence,
  transition: RunJournalTransition,
): RunJournalRecord {
  plainData(fence);
  plainData(transition);
  const current = validateRunJournal(value);
  object(fence, Object.keys(current));
  if (!matches(current, fence)) return fail('CONFLICT');
  const update = object(transition, ['kind', 'checkpoint']);
  if (!['checkpoint', 'interrupted', 'failed'].includes(update.kind as string)) return fail('INVALID');
  if (update.kind !== 'checkpoint') object(transition, ['kind']);
  const checkpoint = transition.kind === 'checkpoint' ? transition.checkpoint : undefined;
  if (
    update.kind === 'checkpoint' &&
    (!checkpoint || !['before_model', 'before_tools', 'after_tools', 'terminal'].includes(checkpoint.stage))
  )
    return fail('INVALID');
  const phase = checkpoint?.stage ?? (transition.kind as Phase);
  if (!canFollow(current.phase, phase)) return fail('TRANSITION');
  if (checkpoint) {
    object(
      checkpoint,
      checkpoint.stage === 'terminal'
        ? ['stage', 'snapshot', 'result']
        : checkpoint.stage === 'before_tools'
          ? ['stage', 'snapshot', 'step', 'calls']
          : ['stage', 'snapshot', 'step'],
    );
    if (checkpoint.stage !== 'terminal' && !positive(checkpoint.step)) return fail('INVALID');
    if (checkpoint.stage === 'terminal') {
      const result = object(checkpoint.result, ['status', 'text', 'steps', 'error']);
      if (
        typeof result.text !== 'string' ||
        !Number.isSafeInteger(result.steps) ||
        (result.steps as number) < 0 ||
        (Object.hasOwn(result, 'error') && typeof result.error !== 'string')
      )
        return fail('INVALID');
    }
  }
  if (checkpoint) {
    let snapshot: AgentSnapshot;
    try {
      snapshot = validateAgentSnapshot(checkpoint.snapshot);
    } catch {
      return fail('INVALID');
    }
    const old = current.snapshot.messages;
    if (JSON.stringify(snapshot.messages.slice(0, old.length)) !== JSON.stringify(old)) return fail('HISTORY');
    if (checkpoint.stage === 'before_tools' && snapshot.messages.length !== old.length) return fail('HISTORY');
    if (checkpoint.stage === 'after_tools') {
      const added = snapshot.messages.slice(old.length);
      const assistant = added[0];
      const intent = current.pendingTools;
      if (
        !intent ||
        added.length !== intent.length + 1 ||
        assistant?.role !== 'assistant' ||
        JSON.stringify(assistant.tool_calls?.map((call) => ({ id: call.id, name: call.function.name }))) !==
          JSON.stringify(intent)
      )
        return fail('HISTORY');
    }
  }
  return validateRunJournal({
    ...current,
    revision: current.revision + 1,
    phase,
    snapshot: checkpoint?.snapshot ?? current.snapshot,
    pendingTools:
      checkpoint?.stage === 'before_tools'
        ? checkpoint.calls
        : checkpoint?.stage === 'after_tools'
          ? null
          : current.pendingTools,
    outcome:
      checkpoint?.stage === 'terminal'
        ? checkpoint.result.status
        : phase === 'failed' || phase === 'interrupted'
          ? phase
          : null,
    events: [...current.events, { sequence: current.revision + 1, phase }],
  });
}

export interface RunJournalStore {
  readonly path: string;
  /** Read-only: active records remain active evidence; recovery must explicitly mark interrupted. */
  load(): Promise<RunJournalRecord>;
  create(record: RunJournalRecord): Promise<RunJournalRecord>;
  transition(fence: RunJournalFence, transition: RunJournalTransition): Promise<RunJournalRecord>;
}
/**
 * Linux local-filesystem store. The caller creates a private parent directory first.
 * Lock files left by a crash are NEVER automatically removed. This is not an executor or resource lock.
 * COMMIT_UNCERTAIN means reread before deciding what happened; never blindly replay the transition.
 */
export function createRunJournalStore(options: { path: string; maxBytes?: number }): RunJournalStore {
  plainData(options);
  object(options, ['path', 'maxBytes']);
  let store: PrivateRecordStore<RunJournalRecord, RunJournalFence, RunJournalTransition>;
  try {
    store = createPrivateRecordStore(options, {
      validate: validateRunJournal,
      initial: (value) => {
        const initial = validateRunJournal(value);
        if (initial.phase !== 'accepted' || initial.revision !== 1) return fail('INVALID');
        return initial;
      },
      reduce: reduceRunJournal,
    });
  } catch (error) {
    return safeError(error);
  }
  return {
    path: store.path,
    load: () => guarded(() => store.load()),
    create: (value) => guarded(() => store.create(value)),
    transition: (fence, transition) =>
      guarded(async () => {
        // Validate before cloning: structuredClone can invoke getters and silently drop fields.
        plainData(fence);
        plainData(transition);
        return store.transition({ ...fence }, structuredClone(transition));
      }),
  };
}
