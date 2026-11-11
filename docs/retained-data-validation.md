# Retained model data validation

The core validates the fields it retains from an adapter reply before cloning
them. It reads `role`, `content`, `tool_calls`, and `providerData` only through
own, enumerable data descriptors. Accessors on those fields are rejected without
being evaluated. Nested retained data still passes the existing strict JSON and
assistant/tool-call validators before any tool can execute.

This ordering matters because `structuredClone` may evaluate getters, discard
symbol and non-enumerable properties, or normalize custom prototypes. Validating
only the clone can therefore accept data the persistence contract would reject
in its original form. Unretained extra adapter fields are not copied or inspected.

The accepted retained data is cloned before the loop awaits queued text observers.
The existing observer drain, cancellation, ordered tool results, and run lock
remain in place. This does not prevent observers from already running while an
adapter request is pending, and JavaScript proxies are not a security sandbox:
reflection can invoke their traps. Adapters and observers remain trusted code.

## Scope and source

The run lock is acquired only after the reentrancy and input guards. Its outer
`try/finally` now encloses preparation (including reading `options.signal`), so
preparation failures release it without letting a rejected concurrent call
release another active run. This is the core-only fix from PR29; its historical
simulated-response tests are deliberately not ported. Existing baseline tests
and assertions are unchanged and are not executed by the non-model entrypoints.

This narrowly restores the descriptor reads and validate-before-clone ordering
from historical local commit `1bb8378944c7d1d68251cb84787998d61142f893` onto the
current PR29 validation contract. It does not import the historical Pi metadata,
parallel execution, projection, compaction, or authorization changes.

## Verification and limits

The permitted data-only component command is:

```sh
node --test test/snapshot-data-validation.test.ts
```

It calls the real snapshot validator on persistence fixtures. It checks rejection
of lossy JSON values, symbol/non-enumerable properties, custom prototypes, and
accessors, plus detached valid data and a JSON round-trip. It creates no agent,
model, simulated model response, or network request. These checks exercise the
shared persistence contract; they do **not** execute the model loop or prove the
new raw-reply boundary's runtime ordering.

Quality, type checking, and build are separate static checks. Real API acceptance,
tool-effect prevention on malformed adapter replies, queued-observer mutation,
cancellation, and concurrent run behavior remain unverified by this component
suite. Historical simulated-model tests are not run or claimed as passing. No
Windows, remote CI, push, merge, or API acceptance is implied by this change.
