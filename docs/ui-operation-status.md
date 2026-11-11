# Session-operation presentation

This small UI/controller follow-up distinguishes active model runs from
non-cancellable session operations. It does not introduce a model, change tool
permissions, add retries or create a new persistence format.

- Manual save, restore and session replacement show explicit progress, success
  and failure status. Fixed failure notices remain in the transcript without
  echoing thrown storage errors, paths or private content. Drafts are retained.
- While a session operation is active, the footer says to wait and no longer
  offers Enter/send or cancellation. Editing a future draft remains possible.
- During an active run, the footer identifies the draft as unsent and displays
  cancellation controls. Existing custom action adapters without the optional
  `cancellable` property retain their prior busy/cancel behavior.
- Auto-save retains the actual run outcome and appends `saved` only when storage
  returns a selected path. If no active file is selected, it retains the run
  outcome without claiming a save. A failure remains visible beside that outcome.
- Storage operations are not cancelled by Ctrl+C; they display the existing
  wait notice. No completed model request is presented as still cancellable while
  its subsequent save is in progress.
- A thrown run error clears unfinished streaming presentation and marks it as
  partial, without fabricating step counts or a completed `RunResult`.

The optional `SessionView.setStatus` and `runError` methods let interactive
views render these states. Append-only and existing custom views remain supported.

## Verification scope

Run only the dedicated allowed checks:

    node --test test/ui-presentation.test.ts test/ui-session-operations.test.ts
    npm run quality
    npm run typecheck
    npm run build

The command-only suite uses the actual OpenAI adapter and agent core, but never
submits a natural-language run. A transport tripwire throws rather than returning
an API response, and every case asserts zero attempted API requests. It performs
real session-file writes/reads, restore, reset and errors, and drives the actual
Pi rendering component. It does not simulate model responses. The storage adapter
uses one real explicit file; CLI path routing is outside this suite.

The automatic-save-after-model-run and partial-stream failure paths are statically
reviewed but are not established as live API acceptance by these checks. They
need a real-provider run under the user's authorized credential configuration.
Do not execute the legacy mixed suites or publish to a workflow that runs model
simulations while that testing restriction remains in force.
