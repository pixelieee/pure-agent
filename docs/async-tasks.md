# One-shot asynchronous task foundation

This layer stores one task and exactly one run (`runId: 1`) in an explicit Linux
private file. It is not a task registry or generation allocator. Existing task files
must not be overwritten to restart work. The per-run journal remains independently
usable and unchanged. A task envelope embeds that journal; it does not maintain a
second session or journal file that would need a multi-file transaction.

## Durable record

`createTaskRecord(taskId, requestId, input, initialSnapshot)` builds an accepted
record. `createTaskRecordStore({path, maxBytes})` uses the same private atomic file
primitive as the run journal. Parent directory, permissions, symlink, orphan-lock,
byte-limit, fsync and uncertain-commit rules are described in [run-journal.md](run-journal.md).
Records contain unencrypted private input and history. Hosts must select a trusted
0700 parent and keep these files private.

Task revision and safe event sequence are independent of the embedded journal
revision. `reduceTaskRecord` and store transitions fence task ID, run ID and task
revision. Checkpoint, task status and event commit together. Event entries expose
only sequence, kind, status and cleanup; not prompts, output, calls, paths or errors.
Events are bounded at 2048, journal events at 1024, and bytes by the configured cap.
There is no pruning, compaction or cursor expiry yet; exceeding a cap fails closed.

Transitions include running, cancelling, awaited checkpoint, failed, cleanup_pending,
dispose_settled and cleanup_failed. Cancellation is a request, not proof of settlement.
A late cancellation may lose to a terminal result already being committed. Terminal
outcome does not change cleanup from owned. Cleanup can begin only after a terminal
outcome; dispose_settled records only successful settlement of the owner's disposal
promise. It does not prove all descendants, external services or effects are gone.
The embedded journal always retains `resources: 'unknown'`, even after disposal.

`load()` is read-only and does not turn stale active state into a live run. A record
left accepted/running/cancelling after host loss is unreconciled evidence, not an
instruction to resume. There is no automatic replay, reopening executor, mailbox,
update API, daemon, cross-process resource lock or workspace identity binding here.
The calling host must own its runtime and effects exclusively; a per-write file lock
is not a lifetime resource lock. No transcript or event proves exactly-once effects.

## Verification scope

`task-record.test.ts` uses production reducers and actual private temporary files.
It covers identity/revision fences, host/journal event consistency, terminal versus
disposal state, privacy of event payloads, input detachment, byte limits, corruption,
accessor/proxy rejection and locks. It creates no Agent or Model and returns no
simulated model responses. Existing journal crash and sync-failure tests exercise
the shared file primitive. These checks are not real-provider or power-loss acceptance.
