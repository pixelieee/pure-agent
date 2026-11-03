# Explicit session configuration

Live mode accepts an explicitly selected JSON file. There is no automatic discovery,
configuration directory, environment interpolation, code import, or plugin system.

Save this example as `agent-config.json`:

```json
{
  "system": "Answer concisely, using project documents as evidence.",
  "model": "gpt-5.6-luna",
  "reasoning": "low",
  "maxSteps": 64,
  "maxOutputTokens": 4096
}
```

With `OPENAI_API_KEY` already supplied in the process environment:

```sh
npm start -- --read-only --config ./agent-config.json --prompt "Introduce this project"
npm start -- --read-only --config ./agent-config.json --model gpt-5.6-luna --reasoning medium
```

Never place credentials in a configuration file. API keys remain environment-only;
`apiKey`, `baseURL`, endpoints, tools, imports, workflows and every other unknown
property are rejected. This format cannot redirect the provider endpoint or add
capabilities. Configured instructions supplement the built-in project safety
instructions. CLI permission mode controls the registered developer capabilities.

## Fields and precedence

All fields are optional. The root must be a JSON object with no extra properties.
Values are not coerced.

| Field | Default | Accepted value |
| --- | --- | --- |
| `system` | Built-in project instructions | Nonblank string, at most 16,000 characters |
| `model` | `gpt-5.6-luna` | Model ID, 1–200 characters; letters, digits, `.`, `_`, `:`, `-`; first character alphanumeric |
| `reasoning` | `low` | `low` or `medium` |
| `maxSteps` | `64` | Integer from 1 through 1000 |
| `maxOutputTokens` | `4096` | Integer from 1 through 65536 |

Precedence is **built-in defaults < JSON file < explicit CLI flags**. `--model`, `--reasoning`, `--max-steps`
and `--max-output-tokens` have CLI setting overrides; `--prompt` supplies the current user
request rather than replacing system instructions. Invalid file settings are rejected
even if an override would replace them. Duplicate CLI options use the final value.

These configurable budget caps bound each run, not total session spending.
Output tokens include reasoning tokens; very small budgets may produce an incomplete
response. Raising the step cap can increase requests and cost. Available model IDs
and reasoning support still depend on the provider and account.

Settings are loaded and frozen once when the session starts. Editing the file does
not affect a running session. `/new` restores that session's resolved system prompt,
not the unconfigured built-in default. `/create` replaces only user-configured
instructions for a fresh session; model, reasoning, budgets, and explicitly granted capabilities
are unchanged. Neither command rereads the file.

There is no demo mode. Product execution uses the real provider. Test model fixtures are test-only.

## Errors and file limits

Files must be regular UTF-8 JSON files of at most 64 KiB. Missing/unreadable files,
invalid encoding, non-files and oversized files produce `CONFIG_FILE`; malformed
JSON produces `CONFIG_JSON`; schema violations produce `CONFIG_SCHEMA`.
Errors identify only the code and a known schema location (or `/`). They do not
print the path, source text, unknown field name, or parser exception. Startup does
not echo configured model IDs or system instructions. Config is input, not a secret
store: do not put secrets in prompts or other supported values either, since those
values are intentionally sent to the model during a live request.
