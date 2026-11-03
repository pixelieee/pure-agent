import type { Tool } from '../core.ts';
import { compileParameters } from '../schema.ts';
import { ProcessManager } from './process-manager.ts';

export interface ProcessCommand {
  command: string;
  /** Relative to root; absolute paths inside root are also accepted. */
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
}
export interface ProcessRead {
  id: string;
  cursor?: number;
  maxBytes?: number;
  waitMs?: number;
}
export interface ProcessWrite {
  id: string;
  chars?: string;
  end?: boolean;
}
export type ProcessApprovalRequest =
  | {
      action: 'exec' | 'start';
      command: string;
      cwd: string;
      shell: { command: string; args: string[] };
      timeoutMs: number;
      /** Actual child environment. Do not indiscriminately display or persist these values. */
      env: NodeJS.ProcessEnv;
      stdin: string;
    }
  | { action: 'write'; id: string; command: string; cwd: string; stdin: string; end: boolean };
export interface ProcessSnapshot {
  id: string;
  pid: number | null;
  status: 'running' | 'exited' | 'failed' | 'terminated';
  command: string;
  commandTruncated: boolean;
  cwd: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  terminationReason: 'timeout' | 'cancelled' | 'killed' | 'disposed' | 'output_limit' | 'log_error' | null;
  totalOutputBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  logPath: string;
  logBytes: number;
  logComplete: boolean;
  error?: string;
  cleanupWarning?: string;
}
export interface ProcessExecutionResult extends ProcessSnapshot {
  output: string;
  truncated: boolean;
}
export interface ProcessReadResult extends ProcessSnapshot {
  output: string;
  cursor: number;
  nextCursor: number;
  omittedBytes: number;
  hasMore: boolean;
}
export interface ProcessToolsOptions {
  root: string;
  /** Policy/approval boundary. Only true permits spawn/input; absent means host-authorized execution. */
  approve?: (request: ProcessApprovalRequest, context: { signal: AbortSignal }) => boolean | Promise<boolean>;
  /** Command is appended as one argument. Default /bin/sh -c (POSIX) or cmd.exe /d /s /c (Windows). */
  shell?: { command: string; args: readonly string[] };
  /** Defaults true, with credential-like variables removed by NAME. This is not secret isolation. */
  inheritEnv?: boolean;
  /** Explicit host overrides, including intentional credential grants. Undefined deletes a variable. */
  env?: NodeJS.ProcessEnv;
  /** Combined stdout/stderr tail in RAM, default 32 KiB, range 4 bytes–1 MiB. */
  maxOutputBytes?: number;
  /** Per-process raw combined log cap, default 16 MiB. Exceeding it terminates execution. */
  maxLogBytes?: number;
  /** Concurrent invocations, default 8. */
  maxProcesses?: number;
  /** Completed history/log retention plus running entries, default 64. Oldest finished logs are deleted. */
  maxRetainedProcesses?: number;
  /** Both foreground/background default to two minutes; callers can request a longer bounded deadline. */
  defaultTimeoutMs?: number;
  /** Default one day; maximum Node timer interval. No unbounded jobs. */
  maxTimeoutMs?: number;
  /** POSIX TERM-to-KILL grace, default 500 ms. Windows uses taskkill /T /F. */
  killGraceMs?: number;
  /** Workspace-relative non-symlink directory, default artifacts/processes (ignored by this project). */
  artifactsDir?: string;
}
export interface ProcessToolSet {
  tools: Tool[];
  /** Idempotently cancel pending starts, terminate owned children, await reaping and close log handles.
   * Logs survive disposal for inspection, bounded by maxRetainedProcesses * maxLogBytes per owner.
   * Hosts own retention across owners and must call dispose in finally; no global signal handlers.
   */
  dispose: () => Promise<void>;
}

const string = { type: 'string', pattern: '^[^\\u0000]*$' };
const id = { type: 'string', minLength: 1, maxLength: 64 };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
function tool<A>(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: (args: A, signal: AbortSignal) => Promise<unknown>,
): Tool {
  const check = compileParameters(parameters);
  return {
    name,
    description,
    parameters,
    async execute(args: unknown, { signal }) {
      signal.throwIfAborted();
      check(args);
      return execute(structuredClone(args) as A, signal);
    },
  };
}

/**
 * Opt-in arbitrary local code execution. cwd scoping is NOT a filesystem/network sandbox:
 * commands may read/write outside root, use network, or daemonize. Use OS isolation when needed.
 * No command allowlist, network denial, PTY emulation, login shell, or implicit user approval.
 * Owns POSIX process groups and reaps direct children; deliberate setsid escapes need an OS job/container.
 * Windows taskkill implementation is distinct and must be integration-tested on Windows.
 * Design references: Pi coding-agent tools/bash.ts and output-accumulator.ts; Codex unified_exec/process.rs.
 */
export function createProcessTools(options: ProcessToolsOptions): ProcessToolSet {
  const manager = new ProcessManager(options);
  const command = object(
    {
      command: {
        ...string,
        minLength: 1,
        maxLength: 64 * 1024,
        description: 'Shell source code. Executed as written; shell metacharacters are active.',
      },
      cwd: {
        ...string,
        minLength: 1,
        maxLength: 4096,
        description: 'Working directory inside the configured workspace, default root.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        maximum: manager.maxTimeoutMs,
        description: 'Execution deadline, not polling wait. Default 120000 ms unless host configured otherwise.',
      },
      stdin: {
        type: 'string',
        maxLength: 64 * 1024,
        description: 'Initial standard input; foreground then closes stdin, background leaves it open.',
      },
    },
    ['command'],
  );
  return {
    tools: [
      tool<ProcessCommand>(
        'exec_command',
        'Execute arbitrary code in the configured shell; await exit, deadline or cancellation. Returns bounded combined stdout/stderr and a workspace-relative raw log. No filesystem or network sandbox.',
        command,
        (args, signal) => manager.execute(args, signal),
      ),
      tool<ProcessCommand>(
        'start_process',
        'Start a managed background command. Returns id for status/read/write/kill. Deadline still applies; do not use shell & or daemonization. Owner disposal terminates jobs.',
        command,
        (args, signal) => manager.background(args, signal),
      ),
      tool<{ id?: string }>(
        'process_status',
        'Get one process status, or list retained owned processes. Exit code null is not success. Completed records and logs may expire as new jobs fill retention.',
        object({ id }),
        async (args) => manager.status(args.id),
      ),
      tool<ProcessRead>(
        'read_process',
        'Read combined output using a raw-byte cursor (default 0). Pass nextCursor on the next read; retries with the same cursor repeat output. omittedBytes reports overwritten tail bytes. waitMs waits for new output without killing a job on cancellation.',
        object(
          {
            id,
            cursor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            maxBytes: { type: 'integer', minimum: 4, maximum: manager.maxOutputBytes },
            waitMs: { type: 'integer', minimum: 0, maximum: 30_000 },
          },
          ['id'],
        ),
        (args, signal) => manager.read(args, signal),
      ),
      tool<ProcessWrite>(
        'write_process',
        'Write bounded text to a running process stdin; end=true sends EOF. This is pipe input, not a terminal/PTY. Host policy also mediates input.',
        object({ id, chars: { type: 'string', maxLength: 64 * 1024 }, end: { type: 'boolean' } }, ['id']),
        (args, signal) => manager.write(args, signal),
      ),
      tool<{ id: string }>(
        'kill_process',
        'Terminate an owned process group, escalating when needed; await child exit and closed logs. Already completed jobs return their terminal result.',
        object({ id }, ['id']),
        (args, signal) => manager.kill(args.id, signal),
      ),
    ],
    dispose: () => manager.dispose(),
  };
}
