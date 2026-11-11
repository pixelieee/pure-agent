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

## In-process host API

`createTaskHost({ path, maxBytes?, createRuntime })` owns one runtime constructed
with its awaited checkpoint callback. For example, the factory can return
`createDeveloperAgent({ ...options, checkpoint })`. It must pass that callback
unchanged, await every checkpoint, clean up failed construction itself, and never
invoke model/tools during construction. The host captures the runtime's methods.
Do not retain it for concurrent calls, replace the callback, or run it independently.
The calling application must exclusively own the workspace and external resources
for the entire lifecycle, including reconciliation after failure. This SDK has no
cross-host, cross-package-instance or cross-process resource exclusion mechanism.

- `await host.start(input, { requestId })` commits accepted input, initial history,
  identity and event before returning `{ taskId, runId: 1, status: 'accepted', cursor: 1 }`.
  Invocation is scheduled with a later host event-loop turn, not awaited by start.
  Concurrent identical admissions on this host return the same acceptance receipt;
  changing request ID or input conflicts. The receipt is not a fresh status report.
- `await host.get(taskId)` reads durable status/cleanup/phase and a separate `host`
  snapshot of live execution, disposal and a safe fault code. Resources remain
  unknown. It returns no private transcript or model output; explicitly reading the
  private task store is a separate operation for an authorized caller.
- `await host.cancel(taskId, expectedRunId)` persists cancelling, then signals the
  runtime. Wrong run IDs fail without aborting; repeated requests and terminal runs
  are idempotent. Running tools must settle. Cancellation neither rolls effects back
  nor guarantees a cancelled outcome when a terminal checkpoint was already queued.
- `await host.events(taskId, afterCursor = 0, limit = 100)` replays safe durable
  events, at most 256 per page. A cursor must be between zero and current revision.
  Consumers deduplicate `(taskId, sequence)`; reading never acknowledges delivery.
  This is polling, not subscriptions, streaming output or exactly-once notification.
- `await host.close({ mode: 'drain' | 'cancel' })` prevents new admission, waits for
  the owned invocation, then awaits disposal. No timeout detaches writes or cleanup.
  It returns final state (or null if never started). First close fixes the mode;
  use cancel separately to interrupt an existing drain. Repeated close shares the
  same promise and never retries disposal. Retain and close the host in finally.

A successfully committed terminal result can be visible while invocation is still
settling and resources remain owned. Cleanup_pending is persisted only after that
invocation settles. Dispose_settled means only the disposal promise succeeded;
background process escapes and remote effects remain outside this guarantee.

A persistence failure stops further writes and cooperatively aborts execution.
The host still awaits the invocation and attempts disposal. `close` rejects with
PERSISTENCE even if disposal settled. `get` may show a durable active state plus
live settled/faulted execution; never infer a terminal outcome from that mismatch.
This also applies at journal/byte limits. Uncertain commits are inspected, not
retried. Admission failure never schedules work; close still disposes a constructed
runtime. A failed admission cannot be retried on that host. Existing files are
refused, including files left after an unacknowledged admission. Reopening, explicit
recovery, later runs, durable mailbox/update, UI routing and idle wake are deferred.
There is no detached OS service: host exit stops scheduling, not necessarily effects.

`task-host.test.ts` uses no-provider host lifecycle drivers and direct production
checkpoint/tool execution, including an actual owned Linux background process. It
checks accepted-before-invocation, deduplication, cancellation races, stale callbacks,
replay, drain/cleanup waiting, admission and checkpoint failure, and disposal errors.
It constructs no Model and returns no fabricated model responses. These are host
component checks, not Agent-loop or real-provider acceptance. Provider latency,
streaming, cancellation within the actual Agent loop and restoration remain separate.
