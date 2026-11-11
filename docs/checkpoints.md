# Awaited Agent checkpoints

`createAgent` and `createDeveloperAgent` accept an optional `checkpoint` callback.
`AgentCheckpoint`, `CheckpointCallback`, and `AgentCheckpointError` are exported
from the package root and `pure-agent/core`. The callback is captured and validated
at construction. It receives detached data and is awaited; mutation of its payload
cannot change canonical history, the invocation, or the returned run result.

Boundaries, in execution order:

- `before_model`: complete canonical snapshot including admitted input, with the
  next 1-based `step`. Runs after successful context projection, before `model_start`
  and provider invocation. Projection is request-only and is never persisted instead
  of canonical history. This is conservative request intent, not proof of invocation.
- `before_tools`: preceding complete snapshot, step and ordered `{id, name}` call
  metadata. Awaited before inserting the assistant's calls or starting tool effects.
  The marker means effects **may** occur, not that any tool ran. No arguments are
  copied into the marker; private history can still contain sensitive information.
- `after_tools`: complete history with every settled result in canonical call order,
  even after cancellation. This precedes cancellation handling or the next model step.
- `terminal`: complete snapshot and proposed `RunResult`, before `done` observation
  and before `run` resolves. Includes blocked, cancelled and step-limit outcomes.

The host must resolve only after its own commit succeeds. Core supplies neither a
store nor a durability guarantee, journal, task ID, scheduler, automatic resume,
mailbox, or daemon. A callback that never settles stalls the run; Core does not race
it against cancellation and abandon a possibly still-running storage write.

Snapshot validation or callback failure rejects `run` with `AgentCheckpointError`
and the fixed message `Agent checkpoint failed; execution stopped. Effects may have
occurred.` No original error/cause is exposed. The failed checkpoint is not retried
through terminal handling and no `done` is emitted for that failed run. No subsequent
provider or tool starts within that run. This is not an ordinary tool error or a
best-effort `onEvent` failure. Without `checkpoint`, the existing behavior remains.

History and real effects already produced are retained. A failed batch-intent
commit leaves the preceding complete history intact. A failed post-tool commit
leaves paired results in memory. After rejection settles, the normal `snapshot()`
method is available; its busy guard still applies inside callbacks and observers.
Any explicit retry or recovery must inspect both durable and in-memory state and
reconcile external effects first. Provider billing or hosted-tool effects may have
occurred even without a local tool marker. Never replay automatically or infer
rollback from a storage error. A terminal outcome does not mean background process
handles or escaped descendants have stopped, nor that runtime resources were released.

## Verification scope

`test/checkpoint.test.ts` directly exercises the production writer with structured
snapshot data, real temporary-file writes/failures and direct production tool
execution. It checks callback capture, awaited settlement, detachment, invalid
pairings, sanitization, observer isolation in the tool runner, and retained effects
and checkpoint data after a terminal write failure. These are component checks,
not Agent-loop E2E or power-loss durability tests. The package consumer compiles the
public callback/types. Core boundary order, no terminal retry, projection separation,
and runtime forwarding are statically reviewed; real provider acceptance remains
pending. No model substitutes or HTTP model responses are used.
