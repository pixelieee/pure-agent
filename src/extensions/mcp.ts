import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Client, type Tool as RemoteTool, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Tool } from '../core.ts';
import { compileParameters } from '../schema.ts';
import { createMcpHttpTransport } from './mcp-http.ts';

interface McpCommonConfig {
  /** Host-chosen, unique within the composed agent. Never read from a repository automatically. */
  namespace: string;
  /** Original remote tool names explicitly classified by the host, never inferred from annotations. */
  readOnlyTools?: string[];
  /** Bounds initialization/listing as a whole, and each call. Default: 30 seconds. */
  timeoutMs?: number;
  /** Maximum serialized tool-result bytes, including truncation notices. Default: 64 KiB. */
  maxOutputBytes?: number;
  maxTools?: number;
  maxPages?: number;
  /** Lifetime cancellation; abort closes this connection and cancels pending calls. */
  signal?: AbortSignal;
}

export type McpServerConfig = McpCommonConfig &
  (
    | {
        transport: 'stdio';
        command: string;
        args?: string[];
        cwd?: string;
        /** Only SDK-safe platform variables are inherited. Secrets require explicit host env. */
        env?: Record<string, string>;
      }
    | {
        transport: 'http';
        /** Exact Streamable HTTP endpoint. No endpoint guessing, redirects, or OAuth enrollment. */
        url: string;
        headers?: Record<string, string>;
      }
  );

export interface McpToolMetadata {
  namespace: string;
  remoteName: string;
  readOnly: boolean;
  /** Untrusted, informational claims from the server. Not an authorization source. */
  annotations?: RemoteTool['annotations'];
}

export interface McpConnection {
  tools: Tool[];
  metadata: ReadonlyMap<string, McpToolMetadata>;
  /** Self-reported server identity, not authenticated identity. */
  server: { namespace: string; name?: string; version?: string };
  close(): Promise<void>;
}

interface McpResult {
  ok: boolean;
  isError: boolean;
  content: unknown[];
  structuredContent?: unknown;
  truncated: boolean;
  limitations: string[];
}

function invalid(message: string): never {
  throw new Error(`MCP_INVALID_CONFIG: ${message}`);
}
function bound(value: number | undefined, fallback: number, max: number, name: string, min = 1): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) invalid(`${name} must be ${min}..${max}`);
  return result;
}
function stringMap(value: Record<string, string> | undefined, name: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be a string map`);
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.includes('\0') || typeof entry !== 'string' || entry.includes('\0'))
      invalid(`${name} must contain non-empty keys and string values without NUL`);
  }
  return { ...value };
}
function remoteName(name: string): void {
  if (typeof name !== 'string' || !name || name.length > 128 || /[\s\p{Cc}]/u.test(name))
    throw new Error('MCP_INVALID_TOOL: remote names must be non-empty, at most 128 characters, without whitespace');
}
function toolName(namespace: string, name: string): string {
  const slug = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24);
  const digest = createHash('sha256')
    .update(JSON.stringify([namespace, name]))
    .digest('hex')
    .slice(0, 16);
  return `mcp_${namespace.slice(0, 16)}_${slug}_${digest}`;
}
function errorSanitizer(config: McpServerConfig): (error: unknown) => string {
  const values = Object.values(config.transport === 'stdio' ? (config.env ?? {}) : (config.headers ?? {}));
  if (config.transport === 'http') {
    values.push(...new URL(config.url).searchParams.values());
    for (const [name, value] of Object.entries(config.headers ?? {})) {
      if (/^(?:proxy-)?authorization$/i.test(name)) values.push(value.replace(/^\S+\s+/, ''));
    }
  }
  const sensitive = [
    ...new Set(
      values.filter(Boolean).flatMap((value) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]),
    ),
  ].sort((a, b) => b.length - a.length);
  return (error) => {
    let text = error instanceof Error ? error.message : String(error);
    // Redact before truncation so a cut through a token cannot expose its prefix.
    for (const value of sensitive) text = text.split(value).join('[REDACTED]');
    return text.slice(0, 512);
  };
}
function utf8Prefix(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  let end = Math.min(bytes, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

/** Core accepts JSON, not multimodal messages. Keep explicit unsupported-content notices. */
function boundedResult(result: Awaited<ReturnType<Client['callTool']>>, limit: number): McpResult {
  const limitations = new Set<string>();
  const content = result.content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    limitations.add(`MCP ${block.type} content is unsupported by the text-only tool interface; payload omitted.`);
    return { type: 'unsupported', originalType: block.type };
  });
  const output: McpResult = {
    ok: result.isError !== true,
    isError: result.isError === true,
    content,
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    truncated: false,
    limitations: [...limitations],
  };
  const serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized) <= limit) return output;
  const preview = {
    ok: output.ok,
    isError: output.isError,
    content: [{ type: 'text', text: '' }],
    truncated: true,
    limitations: [
      ...limitations,
      'Result exceeded maxOutputBytes. Content is a truncated JSON preview; structured output is incomplete.',
    ],
  };
  // Account for JSON escaping and UTF-8, rather than counting JS code units.
  let low = 0;
  let high = Math.min(Buffer.byteLength(serialized), limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    preview.content[0].text = utf8Prefix(serialized, middle);
    if (Buffer.byteLength(JSON.stringify(preview)) <= limit) low = middle;
    else high = middle - 1;
  }
  preview.content[0].text = utf8Prefix(serialized, low);
  return preview;
}

function validateConfig(value: unknown, file = false): asserts value is McpServerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('server must be an object');
  const config = value as Record<string, unknown>;
  const common = ['namespace', 'transport', 'readOnlyTools', 'timeoutMs', 'maxOutputBytes', 'maxTools', 'maxPages'];
  const transportFields = config.transport === 'stdio' ? ['command', 'args', 'cwd', 'env'] : ['url', 'headers'];
  const allowed = new Set([...common, ...transportFields, ...(file ? [] : ['signal'])]);
  if (Object.keys(config).some((key) => !allowed.has(key))) invalid('server contains an unknown field');
  if (typeof config.namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(config.namespace))
    invalid('namespace must be 1..40 ASCII letters, digits, underscores, or hyphens');
  for (const name of ['timeoutMs', 'maxOutputBytes', 'maxTools', 'maxPages']) {
    if (config[name] !== undefined && typeof config[name] !== 'number') invalid(`${name} must be a number`);
  }
  bound(config.timeoutMs as number | undefined, 30_000, 300_000, 'timeoutMs');
  bound(config.maxOutputBytes as number | undefined, 65_536, 1_048_576, 'maxOutputBytes', 1024);
  bound(config.maxTools as number | undefined, 256, 2048, 'maxTools');
  bound(config.maxPages as number | undefined, 64, 1024, 'maxPages');
  if (config.signal !== undefined && !(config.signal instanceof AbortSignal)) invalid('signal must be an AbortSignal');
  if (config.readOnlyTools !== undefined) {
    if (!Array.isArray(config.readOnlyTools) || config.readOnlyTools.length > 2048)
      invalid('readOnlyTools must be an array');
    for (const name of config.readOnlyTools) remoteName(name);
  }
  if (config.transport === 'stdio') {
    if (typeof config.command !== 'string' || !config.command.trim() || config.command.includes('\0'))
      invalid('stdio command is required');
    if (
      config.args !== undefined &&
      (!Array.isArray(config.args) ||
        config.args.length > 256 ||
        config.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))
    )
      invalid('stdio args must be strings without NUL');
    if (config.cwd !== undefined && (typeof config.cwd !== 'string' || !config.cwd || config.cwd.includes('\0')))
      invalid('stdio cwd must be a non-empty path');
    stringMap(config.env as Record<string, string> | undefined, 'env');
  } else if (config.transport === 'http') {
    if (typeof config.url !== 'string') invalid('http url must be an absolute HTTP(S) endpoint');
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      return invalid('http url must be an absolute HTTP(S) endpoint');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
      invalid('http url must use HTTP(S), without userinfo or fragment');
    try {
      new Headers(stringMap(config.headers as Record<string, string> | undefined, 'headers'));
    } catch {
      invalid('http headers are invalid');
    }
  } else invalid('transport must be stdio or http');
}

/** Read only an explicit host-supplied file. Never searches a repository or starts servers. */
export async function loadMcpConfig(path: string): Promise<McpServerConfig[]> {
  const limit = 256 * 1024;
  let text: string;
  try {
    // O_NONBLOCK prevents a FIFO/device from hanging before the descriptor type check.
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit) throw new Error('not a bounded regular file');
      const buffer = Buffer.alloc(limit + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > limit) throw new Error('file grew beyond limit');
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total));
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error('MCP_CONFIG_READ_FAILED: expected a readable regular UTF-8 file of at most 256 KiB');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('MCP_INVALID_CONFIG: expected valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('expected {servers:[...]}');
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.servers) || record.servers.length > 32)
    invalid('expected only servers, an array of at most 32 explicit configurations');
  const namespaces = new Set<string>();
  for (const server of record.servers) {
    validateConfig(server, true);
    if (namespaces.has(server.namespace)) invalid('duplicate server namespace');
    namespaces.add(server.namespace);
  }
  return record.servers as McpServerConfig[];
}

/**
 * First-party MCP boundary, intentionally outside the tiny core. The host owns trust,
 * approvals, endpoint selection, credentials, and closing the returned connection.
 * Tool lists are a snapshot; reconnect explicitly to discover changed definitions.
 * Cancellation/timeouts cannot prove that remote side effects were rolled back.
 */
export async function connectMcpTools(config: McpServerConfig): Promise<McpConnection> {
  validateConfig(config);
  const errorText = errorSanitizer(config);
  const timeout = bound(config.timeoutMs, 30_000, 300_000, 'timeoutMs');
  const maxOutputBytes = bound(config.maxOutputBytes, 65_536, 1_048_576, 'maxOutputBytes', 1024);
  const maxTools = bound(config.maxTools, 256, 2048, 'maxTools');
  const maxPages = bound(config.maxPages, 64, 1024, 'maxPages');
  const readOnlyNames = new Set(config.readOnlyTools ?? []);
  config.signal?.throwIfAborted();

  let transport: Transport;
  let processClosed: Promise<void> | undefined;
  if (config.transport === 'stdio') {
    const stdio = new StdioClientTransport({
      command: config.command,
      args: config.args ? [...config.args] : [],
      cwd: config.cwd,
      env: stringMap(config.env, 'env'),
      // Do not leak arbitrary server diagnostics into the CLI or retain an unread pipe.
      stderr: 'ignore',
      maxBufferSize: 2 * 1024 * 1024,
    });
    processClosed = new Promise((resolve) => {
      stdio.onclose = resolve;
    });
    transport = stdio;
  } else if (config.transport === 'http') {
    const url = new URL(config.url);
    transport = createMcpHttpTransport(url, stringMap(config.headers, 'headers'), timeout);
  } else return invalid('transport must be stdio or http');

  // SDK may invoke close without awaiting during failed initialization. Share teardown
  // so our failure path still waits for that already-started process cleanup.
  const originalClose = transport.close.bind(transport);
  let transportClose: Promise<void> | undefined;
  transport.close = () =>
    (transportClose ??= (async () => {
      const spawned = transport instanceof StdioClientTransport && transport.pid !== null;
      await originalClose();
      // The SDK's last SIGKILL path returns before its child emits close. Wait for
      // the public lifecycle event instead of claiming cleanup before reaping.
      if (spawned && processClosed) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            processClosed,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('MCP_STDIO_CLOSE_TIMEOUT: child did not close')), 1000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    })());
  const client = new Client({ name: 'pure-agent', version: '0.1.0' }, { capabilities: {} });
  const lifetime = new AbortController();
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    lifetime.abort(new Error('MCP connection closed'));
    config.signal?.removeEventListener('abort', onAbort);
    closing = Promise.all([client.close(), transport.close()])
      .then(() => undefined)
      .catch((error) => {
        throw new Error(`MCP_CLOSE_FAILED: ${errorText(error)}`);
      });
    return closing;
  };
  const onAbort = () => {
    void close().catch(() => {
      // Explicit close() still returns this same rejected promise to the host.
    });
  };
  const startup = AbortSignal.any([
    lifetime.signal,
    AbortSignal.timeout(timeout),
    ...(config.signal ? [config.signal] : []),
  ]);
  try {
    await client.connect(transport, { signal: startup, timeout });
    if (!client.getServerCapabilities()?.tools) throw new Error('MCP server does not advertise tools capability');
    const remote: RemoteTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (++pages > maxPages) throw new Error(`MCP_LIST_LIMIT: exceeded ${maxPages} pages; catalogue is incomplete`);
      // Request a single SDK-validated page, avoiding its aggregate duplicate-page shortcut.
      const page = await client.request(
        { method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
        { signal: startup, timeout },
      );
      remote.push(...page.tools);
      if (remote.length > maxTools) throw new Error(`MCP_LIST_LIMIT: exceeded ${maxTools} tools`);
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new Error('MCP_LIST_CYCLE: repeated cursor; catalogue is incomplete');
        cursors.add(cursor);
      }
    } while (cursor !== undefined);

    const metadata = new Map<string, McpToolMetadata>();
    const seen = new Set<string>();
    const tools = remote.map((remoteDefinition): Tool => {
      const definition = structuredClone(remoteDefinition);
      // MCP defaults to 2020-12. Make that contract explicit for both the SDK
      // definition and the core, whose backward-compatible default is draft-07.
      if (!Object.hasOwn(definition.inputSchema, '$schema'))
        definition.inputSchema.$schema = 'https://json-schema.org/draft/2020-12/schema';
      remoteName(definition.name);
      const name = toolName(config.namespace, definition.name);
      if (seen.has(definition.name) || metadata.has(name)) throw new Error('MCP_INVALID_TOOL: duplicate tool name');
      seen.add(definition.name);
      if (Buffer.byteLength(JSON.stringify(definition)) > 65_536)
        throw new Error('MCP_INVALID_TOOL: tool definition exceeds 64 KiB');
      // Fail before returning a partially usable connection if core cannot compile a schema.
      compileParameters(definition.inputSchema);
      metadata.set(name, {
        namespace: config.namespace,
        remoteName: definition.name,
        readOnly: readOnlyNames.has(definition.name),
        ...(definition.annotations ? { annotations: structuredClone(definition.annotations) } : {}),
      });
      return {
        name,
        description: definition.description ?? `MCP tool ${definition.name} from ${config.namespace}`,
        parameters: structuredClone(definition.inputSchema),
        async execute(args: Record<string, unknown>, { signal }) {
          if (closed) throw new Error('MCP_CLOSED: connection is closed');
          const callSignal = AbortSignal.any([lifetime.signal, signal]);
          callSignal.throwIfAborted();
          try {
            const result = await client.callTool(
              { name: definition.name, arguments: args },
              { signal: callSignal, timeout, maxTotalTimeout: timeout, toolDefinition: definition },
            );
            return boundedResult(result, maxOutputBytes);
          } catch (error) {
            throw new Error(
              `MCP_CALL_FAILED: ${errorText(error)}. Remote execution may have occurred; do not assume rollback or retry automatically.`,
            );
          }
        },
      };
    });
    for (const name of readOnlyNames) {
      if (!seen.has(name)) invalid(`readOnlyTools contains an unknown remote tool: ${name}`);
    }
    startup.throwIfAborted();
    config.signal?.addEventListener('abort', onAbort, { once: true });
    config.signal?.throwIfAborted();
    const identity = client.getServerVersion();
    return {
      tools,
      metadata,
      server: { namespace: config.namespace, ...(identity ? { name: identity.name, version: identity.version } : {}) },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [new Error(errorText(error)), new Error(errorText(cleanupError))],
        'MCP connection failed and cleanup also failed',
      );
    }
    throw new Error(`MCP_CONNECT_FAILED: ${errorText(error)}`);
  }
}
