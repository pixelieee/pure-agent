import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  ProcessApprovalRequest,
  ProcessCommand,
  ProcessRead,
  ProcessSnapshot,
  ProcessToolsOptions,
  ProcessWrite,
} from './process.ts';
import { ProcessOutput } from './process-output.ts';
import { terminateProcessTree } from './process-tree.ts';

const MAX_TIMER = 2_147_483_647;
type Reason = 'timeout' | 'cancelled' | 'killed' | 'disposed' | 'output_limit' | 'log_error';
type Status = 'running' | 'exited' | 'failed' | 'terminated';
interface Record {
  id: string;
  child: ChildProcessWithoutNullStreams;
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  status: Status;
  reason?: Reason;
  error?: string;
  cleanupWarning?: string;
  logPath: string;
  absoluteLogPath: string;
  output: ProcessOutput;
  done: Promise<void>;
  terminate?: Promise<void>;
  notify: Set<() => void>;
}

function bounded(value: number, name: string, max: number, min = 1): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid process option: ${name}`);
  return value;
}
function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
function text(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0');
}
function validateEnv(env: NodeJS.ProcessEnv): void {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('Invalid process environment');
  for (const [key, value] of Object.entries(env)) {
    if (!key || key.includes('=') || !text(key) || (value !== undefined && !text(value)))
      throw new Error('Invalid process environment');
  }
}
function childEnvironment(inherit: boolean, supplied: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Defense in depth, not a secret sandbox. Hosts needing isolation must pass inheritEnv:false.
  const environment: NodeJS.ProcessEnv = {};
  if (inherit) {
    for (const [key, value] of Object.entries(process.env)) {
      if (key === 'NODE_TEST_CONTEXT') continue; // Nested node --test must actually execute tests.
      if (
        !/(?:secret|password|passwd|token|api[_-]?key|private[_-]?key|credential|access[_-]?key|connection[_-]?string)/iu.test(
          key,
        )
      )
        environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(supplied)) {
    if (process.platform === 'win32') {
      for (const old of Object.keys(environment)) if (old.toLowerCase() === key.toLowerCase()) delete environment[old];
    }
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export class ProcessManager {
  readonly maxOutputBytes: number;
  readonly maxTimeoutMs: number;
  private readonly root: string;
  private readonly artifactsDir: string;
  private readonly shell: { command: string; args: string[] };
  private readonly environment: NodeJS.ProcessEnv;
  private readonly maxLogBytes: number;
  private readonly maxProcesses: number;
  private readonly maxRetainedProcesses: number;
  private readonly defaultTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly approve?: ProcessToolsOptions['approve'];
  private readonly lifetime = new AbortController();
  private readonly records = new Map<string, Record>();
  private readonly starts = new Set<Promise<Record>>();
  private reservations = 0;
  private launchQueue: Promise<void> = Promise.resolve();
  private initialization?: Promise<{ root: string; directory: string }>;
  private disposal?: Promise<void>;

  constructor(options: ProcessToolsOptions) {
    if (!options || !text(options.root) || !isAbsolute(options.root))
      throw new Error('Process root must be an absolute directory');
    this.root = resolve(options.root);
    this.artifactsDir = options.artifactsDir ?? 'artifacts/processes';
    if (
      !text(this.artifactsDir) ||
      !this.artifactsDir ||
      isAbsolute(this.artifactsDir) ||
      !within(this.root, resolve(this.root, this.artifactsDir))
    )
      throw new Error('Process artifactsDir must be workspace-relative');
    const shell =
      options.shell ??
      (process.platform === 'win32'
        ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'] }
        : { command: '/bin/sh', args: ['-c'] });
    if (!text(shell.command) || !shell.command || !Array.isArray(shell.args) || !shell.args.every(text))
      throw new Error('Invalid process shell');
    this.shell = { command: shell.command, args: [...shell.args] };
    if (options.inheritEnv !== undefined && typeof options.inheritEnv !== 'boolean')
      throw new Error('Invalid process inheritEnv');
    validateEnv(options.env ?? {});
    this.environment = childEnvironment(options.inheritEnv ?? true, { ...options.env });
    this.maxOutputBytes = bounded(options.maxOutputBytes ?? 32 * 1024, 'maxOutputBytes', 1024 * 1024, 4);
    this.maxLogBytes = bounded(options.maxLogBytes ?? 16 * 1024 * 1024, 'maxLogBytes', 1024 * 1024 * 1024);
    this.maxProcesses = bounded(options.maxProcesses ?? 8, 'maxProcesses', 128);
    this.maxRetainedProcesses = bounded(
      options.maxRetainedProcesses ?? Math.max(64, this.maxProcesses),
      'maxRetainedProcesses',
      1024,
      this.maxProcesses,
    );
    this.maxTimeoutMs = bounded(options.maxTimeoutMs ?? 24 * 60 * 60 * 1000, 'maxTimeoutMs', MAX_TIMER);
    this.defaultTimeoutMs = bounded(
      options.defaultTimeoutMs ?? Math.min(120_000, this.maxTimeoutMs),
      'defaultTimeoutMs',
      this.maxTimeoutMs,
    );
    this.killGraceMs = bounded(options.killGraceMs ?? 500, 'killGraceMs', 30_000, 0);
    if (options.approve !== undefined && typeof options.approve !== 'function')
      throw new Error('Invalid process approval hook');
    this.approve = options.approve;
  }

  private initialize() {
    this.initialization ??= (async () => {
      const root = await realpath(this.root);
      if (!(await stat(root)).isDirectory()) throw new Error('Process root is not a directory');
      let current = root;
      const artifactRoot = resolve(root, this.artifactsDir);
      for (const part of relative(root, artifactRoot).split(sep).filter(Boolean)) {
        current = join(current, part);
        await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
        const entry = await lstat(current);
        if (entry.isSymbolicLink() || !entry.isDirectory())
          throw new Error('Process artifacts must not traverse symlinks');
      }
      const directory = await mkdtemp(join(artifactRoot, 'session-'));
      if (!within(root, await realpath(directory))) throw new Error('Process artifact directory escaped workspace');
      return { root, directory };
    })();
    return this.initialization;
  }

  private ensureOpen() {
    if (this.lifetime.signal.aborted) throw new Error('Process tools have been disposed');
  }
  private find(id: string): Record {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown or expired process: ${id}`);
    return record;
  }
  private notify(record: Record) {
    for (const listener of record.notify) listener();
  }

  private terminate(record: Record, reason?: Reason): Promise<void> {
    if (record.status !== 'running') return record.done;
    if (reason && !record.reason) record.reason = reason;
    record.terminate ??= terminateProcessTree(record.child, this.killGraceMs).catch((error: unknown) => {
      record.cleanupWarning = error instanceof Error ? error.message : String(error);
      // Still attempt direct-child termination; never silently claim tree cleanup succeeded.
      try {
        record.child.kill('SIGKILL');
      } catch {
        /* Original cleanup failure remains visible. */
      }
    });
    return record.terminate;
  }

  private summary(record: Record): ProcessSnapshot {
    return {
      id: record.id,
      pid: record.child.pid ?? null,
      status: record.status,
      command: record.command.slice(0, 4096),
      commandTruncated: record.command.length > 4096,
      cwd: record.cwd,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt ?? null,
      exitCode: record.child.pid ? record.child.exitCode : null,
      signal: record.child.signalCode,
      terminationReason: record.reason ?? null,
      totalOutputBytes: record.output.totalBytes,
      stdoutBytes: record.output.stdoutBytes,
      stderrBytes: record.output.stderrBytes,
      logPath: record.logPath,
      logBytes: record.output.logBytes,
      logComplete: record.status !== 'running' && record.output.logComplete,
      ...(record.error ? { error: record.error } : {}),
      ...(record.cleanupWarning ? { cleanupWarning: record.cleanupWarning } : {}),
    };
  }
  private result(record: Record) {
    return { ...this.summary(record), ...record.output.snapshot(record.status !== 'running') };
  }

  private async evict(): Promise<void> {
    while (this.records.size >= this.maxRetainedProcesses) {
      const old = [...this.records.values()].find((record) => record.status !== 'running');
      if (!old) throw new Error('Too many retained processes');
      // A saved result's log reference expires when its completed record is evicted.
      await unlink(old.absoluteLogPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      this.records.delete(old.id);
    }
  }

  private start(args: ProcessCommand, background: boolean, signal: AbortSignal): Promise<Record> {
    this.ensureOpen();
    signal.throwIfAborted();
    if (
      [...this.records.values()].filter((record) => record.status === 'running').length + this.reservations >=
      this.maxProcesses
    )
      throw new Error('Too many running processes');
    this.reservations++;
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    const pending = this.launchQueue.then(() => this.launch(args, background, combined));
    this.launchQueue = pending.then(
      () => {},
      () => {},
    );
    this.starts.add(pending);
    void pending
      .finally(() => {
        this.reservations--;
        this.starts.delete(pending);
      })
      .catch(() => {});
    return pending;
  }

  private async launch(args: ProcessCommand, background: boolean, signal: AbortSignal): Promise<Record> {
    const { root, directory } = await this.initialize();
    const requestedCwd = resolve(root, args.cwd ?? '.');
    if (!within(root, requestedCwd)) throw new Error('Process cwd must be inside the workspace');
    const cwd = await realpath(requestedCwd);
    if (!within(root, cwd) || !(await stat(cwd)).isDirectory())
      throw new Error('Process cwd must be a workspace directory');
    const timeoutMs = args.timeoutMs ?? this.defaultTimeoutMs;
    const request: ProcessApprovalRequest = {
      action: background ? 'start' : 'exec',
      command: args.command,
      cwd,
      shell: { ...this.shell, args: [...this.shell.args] },
      timeoutMs,
      env: { ...this.environment },
      stdin: args.stdin ?? '',
    };
    signal.throwIfAborted();
    if (
      this.approve &&
      (await abortable(Promise.resolve(this.approve(structuredClone(request), { signal })), signal)) !== true
    )
      throw new Error('Process execution denied by host policy');
    signal.throwIfAborted();
    await this.evict();
    signal.throwIfAborted();
    // Re-check cwd after approval. This narrows races, but arbitrary code requires OS isolation.
    if ((await realpath(requestedCwd)) !== cwd) throw new Error('Process cwd changed during approval');
    const id = randomUUID();
    const absoluteLogPath = join(directory, `${id}.log`);
    const file = await open(
      absoluteLogPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    if (signal.aborted) {
      await file.close();
      await unlink(absoluteLogPath);
      signal.throwIfAborted();
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      const isCmd = process.platform === 'win32' && /(?:^|[\\/])cmd(?:\.exe)?$/iu.test(this.shell.command);
      child = spawn(this.shell.command, [...this.shell.args, isCmd ? `"${args.command}"` : args.command], {
        cwd,
        env: { ...this.environment },
        stdio: 'pipe',
        detached: process.platform !== 'win32',
        windowsHide: true,
        windowsVerbatimArguments: isCmd,
      });
    } catch (error) {
      await file.close();
      await unlink(absoluteLogPath);
      throw error;
    }
    let resolveDone: () => void = () => {};
    const record: Record = {
      id,
      child,
      command: args.command,
      cwd,
      startedAt: new Date().toISOString(),
      status: 'running',
      logPath: relative(root, absoluteLogPath).split(sep).join('/'),
      absoluteLogPath,
      output: new ProcessOutput(file, this.maxOutputBytes, this.maxLogBytes, (reason, error) => {
        if (error) record.error = error instanceof Error ? error.message : String(error);
        void this.terminate(record, reason);
      }),
      done: new Promise<void>((done) => {
        resolveDone = done;
      }),
      notify: new Set(),
    };
    this.records.set(id, record);
    let pendingWrites = 0;
    const onOutput = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      child.stdout.pause();
      child.stderr.pause();
      pendingWrites++;
      void record.output.append(chunk, stream).finally(() => {
        pendingWrites--;
        if (!pendingWrites) {
          child.stdout.resume();
          child.stderr.resume();
        }
        this.notify(record);
      });
    };
    child.stdout.on('data', (data: Buffer) => onOutput(data, 'stdout'));
    child.stderr.on('data', (data: Buffer) => onOutput(data, 'stderr'));
    child.stdin.on('error', () => {
      /* EPIPE after an ordinary exit is not an unhandled error. Writes report it. */
    });
    let finishStarted = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      void this.terminate(record, this.lifetime.signal.aborted ? 'disposed' : 'cancelled');
    };
    const timeout = setTimeout(() => {
      void this.terminate(record, 'timeout');
    }, timeoutMs);
    const finish = async () => {
      if (finishStarted) return;
      finishStarted = true;
      clearTimeout(timeout);
      if (drainTimer) clearTimeout(drainTimer);
      signal.removeEventListener('abort', onAbort);
      await record.terminate;
      await record.output.close();
      record.status = record.error || record.cleanupWarning ? 'failed' : record.reason ? 'terminated' : 'exited';
      record.finishedAt = new Date().toISOString();
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      child.stdin.destroy();
      this.notify(record);
      resolveDone();
    };
    child.once('error', (error) => {
      record.error = error.message;
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      // Clean up ordinary background jobs still in this invocation's group, too.
      void this.terminate(record);
      // An escaping daemon may hold inherited pipes. Bound draining and disclose data loss.
      drainTimer = setTimeout(() => {
        record.cleanupWarning ??=
          'Output pipes remained open after process exit; an escaped descendant may still be running';
        record.output.logComplete = false;
        child.stdout.destroy();
        child.stderr.destroy();
      }, this.killGraceMs + 1_000);
    });
    child.once('close', () => {
      void finish();
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const spawned = await new Promise<boolean>((done) => {
      child.once('spawn', () => done(true));
      child.once('error', () => done(false));
    });
    if (!spawned) await record.done;
    if (!background) child.stdin.end(args.stdin ?? '');
    else if (args.stdin) child.stdin.write(args.stdin);
    return record;
  }

  async execute(args: ProcessCommand, signal: AbortSignal) {
    const record = await this.start(args, false, signal);
    await record.done;
    return this.result(record);
  }
  async background(args: ProcessCommand, signal: AbortSignal) {
    const record = await this.start(args, true, signal);
    if (signal.aborted || record.reason) await record.done;
    return this.result(record);
  }
  status(id?: string) {
    return id
      ? this.summary(this.find(id))
      : { processes: [...this.records.values()].map((record) => this.summary(record)) };
  }
  async read(args: ProcessRead, signal: AbortSignal) {
    signal.throwIfAborted();
    const record = this.find(args.id);
    const cursor = args.cursor ?? 0;
    if (cursor > record.output.totalBytes) throw new Error('Process cursor is beyond available output');
    if (record.status === 'running' && cursor === record.output.totalBytes && (args.waitMs ?? 0) > 0) {
      await new Promise<void>((done, reject) => {
        const finish = (error?: unknown) => {
          clearTimeout(timeout);
          record.notify.delete(changed);
          signal.removeEventListener('abort', aborted);
          if (error) reject(error);
          else done();
        };
        const changed = () => finish();
        const aborted = () => finish(signal.reason);
        const timeout = setTimeout(changed, args.waitMs);
        record.notify.add(changed);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      });
    }
    signal.throwIfAborted();
    return {
      ...this.summary(record),
      ...record.output.read(cursor, args.maxBytes ?? this.maxOutputBytes, record.status !== 'running'),
    };
  }
  async kill(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const record = this.find(id);
    await this.terminate(record, 'killed');
    await record.done;
    return this.result(record);
  }
  async write(args: ProcessWrite, signal: AbortSignal) {
    this.ensureOpen();
    signal.throwIfAborted();
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    const record = this.find(args.id);
    if (record.status !== 'running' || record.child.stdin.destroyed || record.child.stdin.writableEnded)
      throw new Error('Process stdin is closed');
    if (
      this.approve &&
      (await abortable(
        Promise.resolve(
          this.approve(
            {
              action: 'write',
              id: args.id,
              command: record.command,
              cwd: record.cwd,
              stdin: args.chars ?? '',
              end: args.end ?? false,
            },
            { signal },
          ),
        ),
        signal,
      )) !== true
    )
      throw new Error('Process input denied by host policy');
    signal.throwIfAborted();
    this.ensureOpen();
    const aborted = () => {
      void this.terminate(record, this.lifetime.signal.aborted ? 'disposed' : 'cancelled');
    };
    signal.addEventListener('abort', aborted, { once: true });
    try {
      if (signal.aborted) aborted();
      signal.throwIfAborted();
      await abortable(
        new Promise<void>((done, reject) => {
          record.child.stdin.write(args.chars ?? '', (error) => {
            if (error) reject(error);
            else done();
          });
          if (args.end) record.child.stdin.end();
        }),
        signal,
      );
    } catch (error) {
      if (signal.aborted) await record.done;
      throw error;
    } finally {
      signal.removeEventListener('abort', aborted);
    }
    return {
      ...this.summary(record),
      writtenBytes: Buffer.byteLength(args.chars ?? ''),
      stdinClosed: args.end ?? false,
    };
  }
  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.lifetime.abort(new Error('Process tools disposed'));
      await Promise.allSettled([...this.starts]);
      await Promise.all(
        [...this.records.values()].map(async (record) => {
          await this.terminate(record, 'disposed');
          await record.done;
        }),
      );
    })();
    return this.disposal;
  }
}
