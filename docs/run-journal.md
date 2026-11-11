# Per-run journal foundation

This Linux-only SDK component persists one immutable caller-selected `taskId` and positive safe-integer `runId` in one explicitly selected file. It is **not** an asynchronous executor, task registry, daemon, admission API, mailbox, notification service, or global workspace/resource lock. It never allocates or advances run generations. A future task service must atomically manage the current generation and resource reconciliation, preferably by extending one authoritative task envelope, not by assuming independent run files are a transaction.

`createRunJournal(taskId, runId, snapshot)` constructs a detached initial record. `createRunJournalStore({ path, maxBytes })` opens no implicit location. The root SDK exports both, `validateRunJournal`, `reduceRunJournal`, and their types. The host creates an existing private 0700 parent directory, owned by the current user, before using an absolute path. Existing records must be regular single-link 0600 files owned by that user. Symlinks in the selected path or its parent components are refused. Ancestors must remain trusted: these checks are not a sandbox against a hostile process replacing paths. Files contain private transcripts and provider continuation data; storage is **not encrypted**.

## Envelope and transitions

Version 1 contains a complete validated snapshot, immutable identity, revision, contiguous event sequence, phase, outcome, pending tool IDs/names, and `resources: 'unknown'`. Up to 1024 events and 1024 pending calls are allowed; file bytes default to 16 MiB with a configurable maximum of 256 MiB. Limits fail closed without compaction. Revision equals event count, so arithmetic cannot reach unsafe-integer overflow. Event entries contain only sequence and phase; this is not a replayable action log.

`store.create(record)` exclusively creates revision 1 and refuses an existing file. `store.transition({ taskId, runId, revision }, transition)` rereads under the writer lock and rejects mismatched identity or revision, including terminal and interrupted writes. Callers await each transition and use its returned revision. Concurrent writes may fail with `LOCKED`; stale revisions fail with `CONFLICT`. All public storage failures use fixed safe `RunJournalError` codes, without original messages, paths, or causes (`NOT_FOUND` for absent paths, `IO` for other unclassified I/O failures). Inputs reject accessors without evaluating them, sparse arrays, non-data properties, cycles, nesting beyond 128 levels and lossy JSON values. Returned records and transition inputs are detached; complete checkpoint validation rejects unmatched calls/results.

Transitions are `{ kind: 'checkpoint', checkpoint }`, `{ kind: 'interrupted' }`, or `{ kind: 'failed' }`. Checkpoints use the core `AgentCheckpoint` contract. The journal accepts `accepted -> before_model -> before_tools -> after_tools`, then another `before_model` or terminal. Terminal is also allowed before a first request or after a model boundary. Interrupted/failed can end any active phase. No terminal phase can reopen. History cannot rewrite its committed prefix. Tool intent preserves the preceding complete snapshot. Only a complete checkpoint containing the corresponding ordered call/result batch clears intent.

The host can close over the current record in its awaited checkpoint callback:

```ts
let record = await store.create(createRunJournal(taskId, runId, initialSnapshot));
const checkpoint: CheckpointCallback = async (boundary) => {
  record = await store.transition(record, { kind: 'checkpoint', checkpoint: boundary });
};
```

This fragment is only a storage adapter. The host still must bind the correct provider/workspace, own and settle execution/resources, and handle failures. Do not swallow callback rejection or publish durable success before commit. Core sanitizes callback failure as `AgentCheckpointError`; inspect the store privately after failure rather than automatically retrying tools or a terminal callback.

## Durability and recovery

Each write uses an exclusive per-file `.lock`, compares the durable revision, creates a same-directory private temporary file, writes and syncs it, renames over the record, and syncs the Linux parent directory. Lock creation/removal also sync the parent directory. Successful completion relies on the local filesystem and hardware honoring sync and rename; network filesystems, power-cut testing, and non-Linux platforms are not verified. Session-store semantics are unchanged.

Any error once rename is attempted is `COMMIT_UNCERTAIN`, including sync/cleanup errors. The replacement may already be visible or durable. **Reread before deciding what happened; never blindly retry.** A crash may leave a lock and temporary file. The store never steals a lock based on a PID or timestamp, scans a directory, removes orphan locks automatically, or replays work. Ordinary cleanup removes only the temporary path and lock created by that operation, never the committed record. Administrative recovery requires the host/user to establish that the old writer is gone; file-lock recovery does not establish external-effect safety.

`load()` is read-only and preserves active evidence, not proof that a process is alive. After establishing exclusive ownership, the host can explicitly persist `interrupted` with the current fence. Pending tool intent survives interruption/failure and means effects may have happened. `before_model` can also mean provider billing or hosted effects occurred. An `after_tools` checkpoint is not a committed terminal outcome. `accepted` is only this local record phase, not acceptance by a task service.

Every outcome, including `completed` and `cancelled`, leaves resources **unknown**. Processes, descendants, MCP connections and other external state need separate reconciliation. No record authorizes automatic effect replay, proves rollback/exactly-once effects, releases a workspace lock, or establishes OS-daemon survivability.

## Evidence limits

The fixed non-model allowlist includes `run-journal.test.ts`: pure reducer/storage fixtures, actual private temporary files, direct production checkpoint callback/storage integration, an owned child killed before a real rename after a real file effect, and a real post-rename directory-sync fault. These are component and local filesystem checks, not Agent-loop E2E, power-loss, resource-cleanup, Windows or real-provider acceptance. Runtime-model checkpoint ordering remains separately pending.
