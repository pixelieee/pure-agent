> Historical acceptance record for the initial read-only prototype. Current CLI capabilities and limits are documented in README and configuration.md.

# Independent configuration QA

## Scope

`test/config-regression.test.ts` is an independent, offline regression suite for the explicit JSON configuration feature. It uses temporary files, fixed dummy credential strings and injected models, never a real API or a local credential file.

Coverage:

- Defaults, configuration and explicit model/reasoning flag precedence, including both flag orders.
- Strict field/type validation, no coercion/default insertion or mutation, frozen snapshots, Unicode instructions/prompts.
- Lower/upper budget bounds and runtime enforcement at 1 and 12 model steps; output budget reaches provider options.
- Unknown credential/endpoint/tool/import fields, malformed JSON, missing files, directories, invalid UTF-8 and oversized files.
- Safe CLI error output without raw JSON, unknown field names, values or paths.
- Explicit demo/config rejection and the unchanged deterministic demo fallback.
- Configured session defaults, `/create` instruction replacement and `/new` restoration; the fixed one-tool/four-file capability boundary remains intact.

## Bug found and verified

The initial exported `resolveConfig` accepted an explicitly present `undefined` optional property. Ajv treated it as absent, while the subsequent spread replaced the concrete default. The independent regression failed before the fix (`Missing expected exception` for `{ maxSteps: undefined }`). Developer fix `064a15b` rejects explicit undefined fields; the test also covers system/model/reasoning/output-budget fields and both config/override arguments.

## Validation

On developer commits `252504a` + `064a15b`, with this regression suite:

- `npm run check`: passed strict TypeScript checks, all 111 tests and build.
- `npm_config_cache=/tmp/pure-agent-npm-cache npm run test:package`: passed the offline installed-tarball SDK/CLI test.

No source changes are included in the independent test commit. No live API, remote CI, Windows platform, or interactive real-terminal configuration flow was tested. Session reset is exercised through the controller; CLI configuration propagation is exercised through injected one-shot models. The package smoke test validates the existing SDK/demo installation path rather than a live provider.
