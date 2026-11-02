# Opt-in workspace reading

The SDK offers an optional bounded, read-only UTF-8 file tool. It is **not registered by default**. The CLI's existing four public-document allowlist is unchanged.

```ts
import { createAgent, createWorkspaceFileTool } from 'pure-agent';

const reader = createWorkspaceFileTool({
  root: '/absolute/path/to/project', // chosen by the host, not the model
  allowedFiles: ['README.md', 'src/main.ts'], // exact files; no globs/directories
  maxBytes: 16 * 1024, // optional; default 16 KiB, maximum 1 MiB
});
const agent = createAgent({ model, tools: [reader] }); // supply your Model adapter
await agent.run('Explain src/main.ts using the actual file.');
```

The factory snapshots the explicit nonempty allowlist. Arguments must contain only `path`; results contain `path`, `content`, and `truncated`. Each call reads at most `maxBytes + 1` bytes (one lookahead byte). A partial UTF-8 code point at the truncation boundary is omitted; other invalid UTF-8 fails rather than being silently replaced. Cancellation is cooperative between filesystem operations and before returning content, not an interruption of an already-running OS read.

Absolute tool paths, traversal, hidden path components, Windows-style separators/devices, obvious secret names (including credentials, tokens, private keys, and key-file extensions), symlinks anywhere in the resolved root's ancestry or target path, and non-regular files are rejected. Missing/unreadable/invalid files produce only `WORKSPACE_FILE_UNAVAILABLE`; unauthorized arguments produce `WORKSPACE_FILE_NOT_ALLOWED`. Invalid factory configuration throws `WORKSPACE_FILE_INVALID_OPTIONS` without filesystem access.

**Limits:** the host must authorize every file's contents. Filename exclusions are only defense in depth: a source file or README can contain secrets. File contents are untrusted evidence, never instructions. Node's built-in path/descriptor checks reduce accidental exposure, but path checks are subject to TOCTOU races; this tool is not an OS sandbox and cannot isolate a workspace being maliciously modified concurrently. Hard links and mount boundaries are not isolation boundaries here. Use a host-managed isolated, stable workspace when stronger guarantees are needed. No writes, shell execution, or network access are provided.

This stays outside the agent loop, implements the existing `Tool` contract, and uses Node built-ins plus the core's existing Ajv parameter validation; no new framework or dependency is introduced.
