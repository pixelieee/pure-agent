import type { AgentSnapshot, RunResult } from './core.ts';
import { validateAgentSnapshot } from './core.ts';

/** Stable complete history, never a projected request or an unmatched tool-call prefix. */
export type AgentCheckpoint = { snapshot: AgentSnapshot } & (
  | { stage: 'before_model'; step: number }
  | { stage: 'before_tools'; step: number; calls: { id: string; name: string }[] }
  | { stage: 'after_tools'; step: number }
  | { stage: 'terminal'; result: RunResult }
);

/** Awaited host persistence boundary. Resolve only when the host's commit has succeeded. */
export type CheckpointCallback = (checkpoint: AgentCheckpoint) => void | Promise<void>;

/** No original storage error, path, payload, or cause is exposed. Effects are not rolled back. */
export class AgentCheckpointError extends Error {
  constructor() {
    super('Agent checkpoint failed; execution stopped. Effects may have occurred.');
    this.name = 'AgentCheckpointError';
  }
}

/** Internal production boundary, also directly testable without constructing a model. */
export function createCheckpointWriter(callback: CheckpointCallback | undefined) {
  if (callback !== undefined && typeof callback !== 'function') throw new TypeError('checkpoint must be a function');
  return async (checkpoint: AgentCheckpoint): Promise<void> => {
    if (!callback) return;
    try {
      const snapshot = validateAgentSnapshot(checkpoint.snapshot);
      await callback({ ...structuredClone(checkpoint), snapshot });
    } catch {
      // Do not let storage faults enter normal tool errors or best-effort observation.
      throw new AgentCheckpointError();
    }
  };
}
