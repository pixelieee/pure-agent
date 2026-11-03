import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { validateAgentSnapshot } from './core.ts';
import type { AgentSnapshot, RunResult } from './core.ts';

/** Configuration identity only: do not put credentials, endpoints with secrets, or environment variables here. */
export interface SessionIdentity {
  provider: string;
  model: string;
  workspaceRoot: string;
}
export interface SessionRecord {
  format: 'pure-agent.session';
  version: 1;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  identity: SessionIdentity;
  snapshot: AgentSnapshot;
  lastRun?: { status: RunResult['status'] };
}
export interface SessionStoreOptions {
  /** One explicitly selected file. Never searches for or automatically resumes sessions. */
  path: string;
  identity: SessionIdentity;
  /** Maximum encoded file size, default 16 MiB, maximum 256 MiB. */
  maxBytes?: number;
}
export interface SessionSaveOptions {
  status?: RunResult['status'];
}
export interface SessionStore {
  readonly path: string;
  /** ENOENT means no session. Malformed, incompatible, or unreadable records throw without changing history. */
  load(): Promise<SessionRecord>;
  /** Existing records must first be loaded by this store; stale revisions are never overwritten. */
  save(snapshot: AgentSnapshot, options?: SessionSaveOptions): Promise<SessionRecord>;
}
export class SessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

const statuses = new Set<RunResult['status']>(['completed', 'blocked', 'cancelled', 'limit']);
const fail = (code: string, message: string): never => {
  throw new SessionError(code, message);
};
const hasCode = (error: unknown, code: string): boolean =>
  !!error && typeof error === 'object' && 'code' in error && error.code === code;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('SESSION_INVALID', 'Invalid session record');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)))
    return fail('SESSION_INVALID', 'Unknown session record field');
  return result;
}
function identity(value: unknown): SessionIdentity {
  const data = record(value, ['provider', 'model', 'workspaceRoot']);
  for (const key of ['provider', 'model', 'workspaceRoot']) {
    if (typeof data[key] !== 'string' || !data[key].trim() || data[key].includes('\0'))
      return fail('SESSION_INVALID', 'Session identity requires provider, model, and workspaceRoot');
  }
  if (!isAbsolute(data.workspaceRoot as string))
    return fail('SESSION_INVALID', 'Session workspaceRoot must be absolute');
  return {
    provider: data.provider as string,
    model: data.model as string,
    workspaceRoot: resolve(data.workspaceRoot as string),
  };
}
function sameIdentity(a: SessionIdentity, b: SessionIdentity): boolean {
  return a.provider === b.provider && a.model === b.model && a.workspaceRoot === b.workspaceRoot;
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validateRecord(value: unknown, expected: SessionIdentity): SessionRecord {
  const data = record(value, [
    'format',
    'version',
    'id',
    'revision',
    'createdAt',
    'updatedAt',
    'identity',
    'snapshot',
    'lastRun',
  ]);
  if (data.format !== 'pure-agent.session' || data.version !== 1)
    return fail('SESSION_VERSION', 'Unsupported session format or version');
  if (
    typeof data.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(data.id) ||
    !Number.isSafeInteger(data.revision) ||
    (data.revision as number) < 1 ||
    !timestamp(data.createdAt) ||
    !timestamp(data.updatedAt) ||
    data.updatedAt < data.createdAt
  )
    return fail('SESSION_INVALID', 'Invalid session metadata');
  const savedIdentity = identity(data.identity);
  if (!sameIdentity(savedIdentity, expected))
    return fail('SESSION_IDENTITY', 'Session provider, model, or workspace does not match');
  let lastRun: SessionRecord['lastRun'];
  if (Object.hasOwn(data, 'lastRun')) {
    const last = record(data.lastRun, ['status']);
    if (!statuses.has(last.status as RunResult['status'])) return fail('SESSION_INVALID', 'Invalid session run status');
    lastRun = { status: last.status as RunResult['status'] };
  }
  let snapshot: AgentSnapshot;
  try {
    snapshot = validateAgentSnapshot(data.snapshot);
  } catch {
    return fail('SESSION_INVALID', 'Invalid or unfinished session conversation');
  }
  return {
    format: 'pure-agent.session',
    version: 1,
    id: data.id,
    revision: data.revision as number,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    identity: savedIdentity,
    snapshot,
    ...(lastRun ? { lastRun } : {}),
  };
}

/**
 * Private UTF-8 JSON with atomic replacement, a per-path writer lock, and optimistic revisions.
 * Transcripts and provider continuation data can contain private information; this is not encrypted storage.
 * A crash may leave a .lock or temporary file. No lock is removed automatically and no directory is scanned.
 */
export function createSessionStore(options: SessionStoreOptions): SessionStore {
  if (!options || typeof options.path !== 'string' || !options.path.trim() || options.path.includes('\0'))
    return fail('SESSION_INVALID', 'An explicit session file path is required');
  const path = resolve(options.path);
  const expected = identity(options.identity);
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024)
    return fail('SESSION_INVALID', 'Invalid session size limit');
  let baseline: { id: string; revision: number } | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  const read = async (): Promise<SessionRecord> => {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink())
      return fail('SESSION_UNSAFE_PATH', 'Session path must be a regular file, not a symbolic link');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.ino !== before.ino || stats.dev !== before.dev)
        return fail('SESSION_UNSAFE_PATH', 'Session file changed while opening');
      if (stats.size > maxBytes) return fail('SESSION_TOO_LARGE', 'Session file exceeds the size limit');
      const bytes = Buffer.alloc(Math.min(stats.size + 1, maxBytes + 1));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > maxBytes) return fail('SESSION_TOO_LARGE', 'Session file exceeds the size limit');
      if (offset !== stats.size) return fail('SESSION_CORRUPT', 'Session file changed while reading');
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
      } catch {
        return fail('SESSION_CORRUPT', 'Session file is not valid UTF-8 JSON');
      }
      return validateRecord(parsed, expected);
    } finally {
      await handle.close();
    }
  };
  return {
    path,
    load: () =>
      serialized(async () => {
        const loaded = await read();
        baseline = { id: loaded.id, revision: loaded.revision };
        return loaded;
      }),
    async save(snapshot, saveOptions = {}) {
      // Detach synchronously before any queued or asynchronous operation can observe caller mutations.
      const history = validateAgentSnapshot(snapshot);
      const status = saveOptions.status;
      if (status !== undefined && !statuses.has(status))
        return Promise.reject(new SessionError('SESSION_INVALID', 'Invalid session run status'));
      return serialized(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const lockPath = `${path}.lock`;
        let lock: FileHandle;
        try {
          lock = await open(lockPath, 'wx', 0o600);
        } catch (error) {
          if (hasCode(error, 'EEXIST')) return fail('SESSION_LOCKED', 'Session is locked by another writer');
          throw error;
        }
        let temporary: string | undefined;
        try {
          await lock.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
          let current: SessionRecord | undefined;
          try {
            current = await read();
          } catch (error) {
            if (!hasCode(error, 'ENOENT')) throw error;
          }
          if (current && !baseline)
            return fail('SESSION_EXISTS', 'Session already exists; load it explicitly before saving');
          if (
            (baseline && !current) ||
            (current && (current.id !== baseline?.id || current.revision !== baseline?.revision))
          )
            return fail('SESSION_CONFLICT', 'Session changed since it was loaded; refusing to overwrite');
          if (current?.revision === Number.MAX_SAFE_INTEGER)
            return fail('SESSION_INVALID', 'Session revision limit reached');
          const now = new Date().toISOString();
          const saved: SessionRecord = {
            format: 'pure-agent.session',
            version: 1,
            id: current?.id ?? randomUUID(),
            revision: (current?.revision ?? 0) + 1,
            createdAt: current?.createdAt ?? now,
            updatedAt: current && current.updatedAt > now ? current.updatedAt : now,
            identity: { ...expected },
            snapshot: history,
            ...(status ? { lastRun: { status } } : {}),
          };
          const body = `${JSON.stringify(saved, null, 2)}\n`;
          if (Buffer.byteLength(body) > maxBytes)
            return fail('SESSION_TOO_LARGE', 'Session exceeds the size limit; previous record is unchanged');
          temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
          const handle = await open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(body, 'utf8');
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, path);
          temporary = undefined;
          baseline = { id: saved.id, revision: saved.revision };
          return structuredClone(saved);
        } finally {
          try {
            if (temporary) await unlink(temporary);
          } finally {
            await lock.close();
            await unlink(lockPath);
          }
        }
      });
    },
  };
}
