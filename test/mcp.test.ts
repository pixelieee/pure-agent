import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/client';
import { createAgent, type Model } from '../src/core.ts';
import { createMcpHttpTransport } from '../src/extensions/mcp-http.ts';
import { connectMcpTools, loadMcpConfig, type McpServerConfig } from '../src/extensions/mcp.ts';

const ctx = () => ({ signal: new AbortController().signal });
const definition = (name = 'echo') => ({
  name,
  description: 'Echo a string',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
});
type Rpc = { id?: number; method: string; params?: Record<string, unknown> };
type Reply = { result?: unknown; error?: { code: number; message: string } };
const initialization = (message: Rpc) => ({
  protocolVersion: message.params?.protocolVersion,
  serverInfo: { name: 'fixture', version: '1.0' },
  capabilities: { tools: {} },
  instructions: 'UNTRUSTED: do not automatically add server instructions to an agent prompt',
});

async function httpFixture(
  t: TestContext,
  handle?: (rpc: Rpc, response: ServerResponse, request: IncomingMessage) => Reply | undefined,
) {
  const requests: Rpc[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    const rpc = JSON.parse(body) as Rpc;
    requests.push(rpc);
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const reply = handle
      ? handle(rpc, response, request)
      : {
          result:
            rpc.method === 'initialize'
              ? initialization(rpc)
              : rpc.method === 'tools/list'
                ? { tools: [definition()] }
                : { content: [{ type: 'text', text: JSON.stringify(rpc.params?.arguments) }] },
        };
    if (reply) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...reply }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}/mcp`, requests };
}

// A local protocol peer exercises the real official SDK stdio transport, not a mocked Client.
const stdioPeer = String.raw`
  const { createInterface } = require('node:readline');
  const fs = require('node:fs');
  const config = JSON.parse(process.env.MCP_FIXTURE_CONFIG || '{}');
  if (config.pidFile) fs.writeFileSync(config.pidFile, String(process.pid));
  const lines = createInterface({ input: process.stdin });
  lines.on('close', () => process.exit(0));
  lines.on('line', (line) => {
    const rpc = JSON.parse(line);
    if (rpc.id === undefined || config.silent) return;
    let result;
    if (rpc.method === 'initialize') {
      if (config.failInit) {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,error:{code:-32603,message:'init failed'}})+'\n');
        return;
      }
      result = {protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    } else if (rpc.method === 'tools/list') {
      result = {tools:config.tools || [{name:'env',inputSchema:{type:'object'}}]};
    } else {
      result = {content:[{type:'text',text:JSON.stringify({
        openai:process.env.OPENAI_API_KEY === 'not-a-real-key',
        anthropic:process.env.ANTHROPIC_API_KEY === 'not-a-real-key',
        custom:process.env.MCP_TEST_EXPLICIT === 'host-provided',
        args:rpc.params.arguments
      })}]};
    }
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})+'\n');
  });
`;
const stdioConfig = (config: Record<string, unknown> = {}): Extract<McpServerConfig, { transport: 'stdio' }> => ({
  namespace: 'local',
  transport: 'stdio',
  command: process.execPath,
  args: ['-e', stdioPeer],
  env: { MCP_FIXTURE_CONFIG: JSON.stringify(config) },
  timeoutMs: 3000,
});
async function temp(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pure-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

interface ToolResult {
  ok: boolean;
  isError: boolean;
  content: { type: string; text?: string; originalType?: string }[];
  structuredContent?: unknown;
  truncated: boolean;
  limitations: string[];
}

test('official HTTP transport lists every page, maps safe stable names, and keeps annotations untrusted', async (t) => {
  const names = ['echo.one', 'echo_one', 'remote:third'];
  const fixture = await httpFixture(t, (rpc) => ({
    result:
      rpc.method === 'initialize'
        ? initialization(rpc)
        : rpc.method === 'tools/list'
          ? rpc.params?.cursor === 'page2'
            ? { tools: [definition(names[2])] }
            : { tools: names.slice(0, 2).map(definition), nextCursor: 'page2' }
          : { content: [{ type: 'text', text: 'ok' }], structuredContent: { called: rpc.params?.name } },
  }));
  const config: McpServerConfig = {
    transport: 'http',
    namespace: 'files',
    url: fixture.url,
    readOnlyTools: [names[0]],
  };
  const connection = await connectMcpTools(config);
  t.after(() => connection.close());
  assert.equal(connection.tools.length, 3);
  assert.equal(new Set(connection.tools.map((tool) => tool.name)).size, 3);
  for (const tool of connection.tools) assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(connection.metadata.get(connection.tools[0].name)?.readOnly, true);
  assert.equal(connection.metadata.get(connection.tools[1].name)?.readOnly, false);
  assert.equal(connection.metadata.get(connection.tools[1].name)?.annotations?.readOnlyHint, true);
  assert.deepEqual(connection.server, { namespace: 'files', name: 'fixture', version: '1.0' });
  const result = (await connection.tools[2].execute({ text: 'hello' }, ctx())) as ToolResult;
  assert.deepEqual(result.structuredContent, { called: names[2] });
  assert.equal(result.ok, true);
  assert.equal(fixture.requests.filter((rpc) => rpc.method === 'tools/list').length, 2);
  const again = await connectMcpTools(config);
  t.after(() => again.close());
  assert.deepEqual(
    again.tools.map((tool) => tool.name),
    connection.tools.map((tool) => tool.name),
  );
  await connection.close();
  await connection.close();
  await assert.rejects(connection.tools[0].execute({ text: 'no' }, ctx()), /MCP_CLOSED/);
});

test('core JSON Schema validation rejects malformed arguments before the remote call', async (t) => {
  const fixture = await httpFixture(t);
  const connection = await connectMcpTools({ namespace: 'schema', transport: 'http', url: fixture.url });
  t.after(() => connection.close());
  const model: Model = {
    complete: async (messages) =>
      messages.at(-1)?.role === 'tool'
        ? { role: 'assistant', content: 'done' }
        : {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'bad', type: 'function', function: { name: connection.tools[0].name, arguments: '{"text":4}' } },
            ],
          },
  };
  const agent = createAgent({ model, tools: connection.tools });
  await agent.run('test');
  assert.match(agent.messages.find((message) => message.role === 'tool')?.content ?? '', /Invalid tool arguments/);
  assert.equal(fixture.requests.filter((rpc) => rpc.method === 'tools/call').length, 0);
});

test('stdio inherits safe SDK environment only and accepts explicit host environment', async (t) => {
  const oldOpenai = process.env.OPENAI_API_KEY;
  const oldAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = 'not-a-real-key';
  process.env.ANTHROPIC_API_KEY = 'not-a-real-key';
  t.after(() => {
    if (oldOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenai;
    if (oldAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldAnthropic;
  });
  const config = stdioConfig();
  assert.equal(config.transport, 'stdio');
  if (config.transport !== 'stdio') throw new Error('expected stdio');
  config.env = { ...config.env, MCP_TEST_EXPLICIT: 'host-provided' };
  const connection = await connectMcpTools(config);
  t.after(() => connection.close());
  const result = (await connection.tools[0].execute({}, ctx())) as ToolResult;
  assert.deepEqual(JSON.parse(result.content[0].text ?? ''), {
    openai: false,
    anthropic: false,
    custom: true,
    args: {},
  });
  config.env.OPENAI_API_KEY = 'not-a-real-key';
  const explicit = await connectMcpTools(config);
  t.after(() => explicit.close());
  const explicitResult = (await explicit.tools[0].execute({}, ctx())) as ToolResult;
  assert.equal(JSON.parse(explicitResult.content[0].text ?? '').openai, true);
});

test('tool errors, protocol errors, multimodal limitations and structured output remain honest', async (t) => {
  const fixture = await httpFixture(t, (rpc) => {
    if (rpc.method === 'initialize') return { result: initialization(rpc) };
    if (rpc.method === 'tools/list') return { result: { tools: [definition()] } };
    if ((rpc.params?.arguments as { text: string } | undefined)?.text === 'protocol')
      return { error: { code: -32603, message: 'fixture protocol failure' } };
    return {
      result: {
        isError: true,
        content: [
          { type: 'text', text: 'tool failed' },
          { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
          { type: 'audio', mimeType: 'audio/wav', data: 'aGVsbG8=' },
          { type: 'resource', resource: { uri: 'file:///fixture.txt', text: 'resource text' } },
          { type: 'resource_link', uri: 'https://example.invalid/file', name: 'fixture' },
        ],
        structuredContent: { reason: 'fixture' },
      },
    };
  });
  const connection = await connectMcpTools({ namespace: 'errors', transport: 'http', url: fixture.url });
  t.after(() => connection.close());
  const result = (await connection.tools[0].execute({ text: 'error' }, ctx())) as ToolResult;
  assert.equal(result.ok, false);
  assert.equal(result.isError, true);
  assert.equal(result.limitations.length, 4);
  assert.deepEqual(
    result.content.slice(1).map((block) => block.originalType),
    ['image', 'audio', 'resource', 'resource_link'],
  );
  assert.equal(JSON.stringify(result).includes('aGVsbG8='), false);
  await assert.rejects(
    connection.tools[0].execute({ text: 'protocol' }, ctx()),
    /fixture protocol failure.*may have occurred/,
  );
});

test('output limit counts JSON escaping and UTF-8 and reports truncated structured content', async (t) => {
  const fixture = await httpFixture(t, (rpc) => ({
    result:
      rpc.method === 'initialize'
        ? initialization(rpc)
        : rpc.method === 'tools/list'
          ? { tools: [definition()] }
          : {
              content: [
                { type: 'text', text: '世界😀\\"'.repeat(4000) },
                { type: 'image', mimeType: 'image/png', data: 'YWJj' },
              ],
              structuredContent: { large: 'x'.repeat(5000) },
            },
  }));
  const connection = await connectMcpTools({
    namespace: 'bounded',
    transport: 'http',
    url: fixture.url,
    maxOutputBytes: 1024,
  });
  t.after(() => connection.close());
  const result = (await connection.tools[0].execute({ text: 'large' }, ctx())) as ToolResult;
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024);
  assert.equal(result.truncated, true);
  assert.match(result.limitations.join(' '), /JSON preview.*incomplete/);
  assert.match(result.limitations.join(' '), /image.*unsupported/);
  assert.equal(JSON.stringify(result).includes('\ufffd'), false);
});

test('pending calls cancel or time out without automatic retry, and lifetime abort closes', async (t) => {
  const fixture = await httpFixture(t, (rpc) => {
    if (rpc.method === 'initialize') return { result: initialization(rpc) };
    if (rpc.method === 'tools/list') return { result: { tools: [definition()] } };
    return undefined;
  });
  const lifetime = new AbortController();
  const connection = await connectMcpTools({
    namespace: 'cancel',
    transport: 'http',
    url: fixture.url,
    timeoutMs: 120,
    signal: lifetime.signal,
  });
  t.after(() => connection.close());
  const controller = new AbortController();
  const pending = connection.tools[0].execute({ text: 'cancel' }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('test cancellation')), 20);
  await assert.rejects(pending, /MCP_CALL_FAILED.*may have occurred/);
  await assert.rejects(connection.tools[0].execute({ text: 'timeout' }, ctx()), /MCP_CALL_FAILED.*may have occurred/);
  assert.equal(fixture.requests.filter((rpc) => rpc.method === 'tools/call').length, 2);
  const last = connection.tools[0].execute({ text: 'lifetime' }, ctx());
  lifetime.abort();
  await assert.rejects(last, /MCP_CALL_FAILED/);
  await connection.close();
  await assert.rejects(connection.tools[0].execute({ text: 'closed' }, ctx()), /MCP_CLOSED/);
});

test('initialization, listing, and stdio failures close the connection and spawned process', async (t) => {
  const directory = await temp(t);
  for (const mode of ['failInit', 'silent']) {
    const pidFile = join(directory, `${mode}.pid`);
    const config = stdioConfig({ [mode]: true, pidFile });
    config.timeoutMs = 200;
    await assert.rejects(connectMcpTools(config), /MCP_CONNECT_FAILED/);
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  }
  const fixture = await httpFixture(t, (rpc) =>
    rpc.method === 'initialize' ? { result: initialization(rpc) } : { error: { code: -32603, message: 'list failed' } },
  );
  await assert.rejects(connectMcpTools({ namespace: 'bad', transport: 'http', url: fixture.url }), /list failed/);
  const silent = await httpFixture(t, (rpc) =>
    rpc.method === 'initialize' ? { result: initialization(rpc) } : undefined,
  );
  await assert.rejects(
    connectMcpTools({ namespace: 'slow', transport: 'http', url: silent.url, timeoutMs: 80 }),
    /MCP_CONNECT_FAILED/,
  );
});

test('catalogue validation rejects cycles, limits, duplicates, bad schemas and names', async (t) => {
  for (const tools of [
    [definition('duplicate'), definition('duplicate')],
    [{ ...definition(), inputSchema: { type: 'object', properties: { x: { type: 'nonsense' } } } }],
    [definition('bad name')],
    [definition('')],
  ]) {
    await assert.rejects(connectMcpTools(stdioConfig({ tools })), /MCP_CONNECT_FAILED/);
  }
  const fixture = await httpFixture(t, (rpc) => ({
    result: rpc.method === 'initialize' ? initialization(rpc) : { tools: [definition()], nextCursor: 'cycle' },
  }));
  await assert.rejects(connectMcpTools({ namespace: 'cycle', transport: 'http', url: fixture.url }), /MCP_LIST_CYCLE/);
  await assert.rejects(
    connectMcpTools({ namespace: 'pages', transport: 'http', url: fixture.url, maxPages: 1 }),
    /MCP_LIST_LIMIT/,
  );
  await assert.rejects(
    connectMcpTools({ namespace: 'tools', transport: 'http', url: fixture.url, maxTools: 1 }),
    /MCP_LIST_LIMIT/,
  );
  await assert.rejects(connectMcpTools({ ...stdioConfig(), readOnlyTools: ['missing'] }), /unknown remote tool/);
});

test('explicit config files are bounded, validated, redacted and never start commands', async (t) => {
  const directory = await temp(t);
  const path = join(directory, 'mcp.json');
  const configs: McpServerConfig[] = [
    { namespace: 'local', transport: 'stdio', command: 'not-executed', args: ['--flag'], env: { EXPLICIT: 'value' } },
    {
      namespace: 'remote',
      transport: 'http',
      url: 'https://example.invalid/mcp',
      headers: { Authorization: 'fixture-value' },
    },
  ];
  await writeFile(path, JSON.stringify({ servers: configs }));
  assert.deepEqual(await loadMcpConfig(path), configs);
  for (const invalid of [
    'secret-parser-content',
    { servers: [{ ...configs[0], unexpected: 'secret-value' }] },
    { servers: [configs[0], configs[0]] },
    { servers: [{ ...configs[0], args: ['ok', 42] }] },
    { servers: [{ ...configs[0], signal: {} }] },
    { servers: [{ ...configs[1], headers: { Authorization: 'secret\nvalue' } }] },
    { servers: [{ ...configs[1], url: 'file:///secret-value' }] },
    { servers: [{ ...configs[1], url: 'https://user:secret-value@example.invalid' }] },
    { servers: [{ ...configs[1], maxOutputBytes: 0 }] },
    { servers: [{ ...configs[1], namespace: undefined }] },
  ]) {
    await writeFile(path, typeof invalid === 'string' ? invalid : JSON.stringify(invalid));
    await assert.rejects(loadMcpConfig(path), (error: Error) => {
      assert.match(error.message, /MCP_INVALID_CONFIG/);
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
  }
  await writeFile(path, 'x'.repeat(256 * 1024 + 1));
  await assert.rejects(loadMcpConfig(path), /MCP_CONFIG_READ_FAILED/);
  await assert.rejects(loadMcpConfig(directory), /MCP_CONFIG_READ_FAILED/);
  await assert.rejects(loadMcpConfig(join(directory, 'missing')), /MCP_CONFIG_READ_FAILED/);
});

test('pre-aborted connection never spawns, and cancellation during initialization reaps stdio', async (t) => {
  const directory = await temp(t);
  const pidFile = join(directory, 'cancelled.pid');
  const preAborted = new AbortController();
  preAborted.abort(new Error('already cancelled'));
  await assert.rejects(
    connectMcpTools({ ...stdioConfig({ pidFile }), signal: preAborted.signal }),
    /already cancelled/,
  );
  await assert.rejects(readFile(pidFile), { code: 'ENOENT' });
  const controller = new AbortController();
  const pending = connectMcpTools({ ...stdioConfig({ silent: true, pidFile }), signal: controller.signal });
  // Observe startup instead of depending on a fixed sleep before cancellation.
  let pid: number | undefined;
  const deadline = Date.now() + 2000;
  while (pid === undefined && Date.now() < deadline) {
    try {
      pid = Number(await readFile(pidFile, 'utf8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(pid);
  controller.abort(new Error('cancel initialization'));
  await assert.rejects(pending, /cancel initialization/);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('HTTP redirect does not send credentials or initialize a guessed destination', async (t) => {
  const destination = await httpFixture(t);
  const redirect = createServer((_request, response) => response.writeHead(307, { Location: destination.url }).end());
  await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    redirect.closeAllConnections();
    await new Promise<void>((resolve) => redirect.close(() => resolve()));
  });
  const address = redirect.address();
  assert.ok(address && typeof address !== 'string');
  await assert.rejects(
    connectMcpTools({
      namespace: 'redirect',
      transport: 'http',
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { Authorization: 'Bearer not-a-real-secret' },
    }),
    /MCP_CONNECT_FAILED/,
  );
  assert.equal(destination.requests.length, 0);
});

test('missing command and unsupported tools capability fail without a usable partial connection', async (t) => {
  await assert.rejects(
    connectMcpTools({ namespace: 'missing', transport: 'stdio', command: 'pure-agent-mcp-no-such-fixture-command' }),
    /MCP_CONNECT_FAILED/,
  );
  const fixture = await httpFixture(t, (rpc) => ({ result: { ...initialization(rpc), capabilities: {} } }));
  await assert.rejects(
    connectMcpTools({ namespace: 'unsupported', transport: 'http', url: fixture.url }),
    /does not advertise tools/,
  );
  assert.equal(fixture.requests.filter((rpc) => rpc.method === 'tools/list').length, 0);
});

test('MCP defaults omitted schemas to 2020-12 while preserving explicitly selected dialects', async (t) => {
  const fixture = await httpFixture(t, (rpc) => ({
    result:
      rpc.method === 'initialize'
        ? initialization(rpc)
        : rpc.method === 'tools/list'
          ? {
              tools: [
                {
                  ...definition('modern'),
                  inputSchema: {
                    type: 'object',
                    properties: {
                      tuple: {
                        type: 'array',
                        prefixItems: [{ type: 'string', format: 'email' }],
                        minItems: 1,
                        maxItems: 1,
                      },
                    },
                    required: ['tuple'],
                    additionalProperties: false,
                  },
                },
                {
                  ...definition('legacy'),
                  inputSchema: { ...definition().inputSchema, $schema: 'http://json-schema.org/draft-07/schema#' },
                },
              ],
            }
          : { content: [{ type: 'text', text: 'validated' }] },
  }));
  const connection = await connectMcpTools({ namespace: 'dialects', transport: 'http', url: fixture.url });
  t.after(() => connection.close());
  assert.equal(connection.tools[0].parameters.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(connection.tools[1].parameters.$schema, 'http://json-schema.org/draft-07/schema#');
  let value = 'not-an-email';
  const model: Model = {
    complete: async (messages) =>
      messages.at(-1)?.role === 'tool'
        ? { role: 'assistant', content: 'done' }
        : {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'tuple',
                type: 'function',
                function: { name: connection.tools[0].name, arguments: JSON.stringify({ tuple: [value] }) },
              },
            ],
          },
  };
  const rejected = createAgent({ model, tools: connection.tools });
  await rejected.run('invalid');
  assert.match(rejected.messages.find((message) => message.role === 'tool')?.content ?? '', /Invalid tool arguments/);
  assert.equal(fixture.requests.filter((rpc) => rpc.method === 'tools/call').length, 0);
  value = 'valid@example.test';
  await createAgent({ model, tools: connection.tools }).run('valid');
  assert.equal(fixture.requests.filter((rpc) => rpc.method === 'tools/call').length, 1);
});

test('HTTP failures redact credentials before truncation without hiding protocol diagnostic details', async (t) => {
  const secret = 'fixture-only-secret-no-real-value';
  const fixture = await httpFixture(t, (rpc, response) => {
    if (rpc.method === 'initialize') return { result: initialization(rpc) };
    if (rpc.method === 'tools/list') return { result: { tools: [definition()] } };
    if ((rpc.params?.arguments as { text?: string } | undefined)?.text === 'http') {
      response.writeHead(500).end(`remote fixture diagnostic Bearer ${secret}`);
      return undefined;
    }
    return { error: { code: -32602, message: `fixture invalid parameter Bearer ${secret}` } };
  });
  const connection = await connectMcpTools({
    namespace: 'redact',
    transport: 'http',
    url: fixture.url,
    headers: { Authorization: `Bearer ${secret}` },
  });
  t.after(() => connection.close());
  for (const text of ['http', 'protocol']) {
    await assert.rejects(connection.tools[0].execute({ text }, ctx()), (error: Error) => {
      assert.match(error.message, /fixture.*\[REDACTED\].*may have occurred/);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.cause, undefined, 'the original error must not leak through cause');
      return true;
    });
  }
});

test('HTTP decoded input limits cover gzip, chunked JSON and incomplete SSE frames', async (t) => {
  const fixture = await httpFixture(t, (rpc, response) => {
    if (rpc.method === 'initialize') return { result: initialization(rpc) };
    if (rpc.method === 'tools/list') return { result: { tools: [definition()] } };
    const kind = (rpc.params?.arguments as { text?: string } | undefined)?.text;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: rpc.id,
      result: { content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024 + 4096) }] },
    });
    if (kind === 'gzip')
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end(gzipSync(body));
    else if (kind === 'chunked') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(body.slice(0, 1));
      response.end(body.slice(1));
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${body}`); // Deliberately never terminate this SSE frame or body.
    }
    return undefined;
  });
  const connection = await connectMcpTools({
    namespace: 'decoded',
    transport: 'http',
    url: fixture.url,
    timeoutMs: 500,
  });
  t.after(() => connection.close());
  for (const text of ['gzip', 'chunked', 'sse']) {
    await assert.rejects(connection.tools[0].execute({ text }, ctx()), /MCP_CALL_FAILED/);
  }
});

test('stdio close waits until a child ignoring EOF and SIGTERM is reaped', async (t) => {
  const directory = await temp(t);
  const pidFile = join(directory, 'stubborn.pid');
  const script = stdioPeer.replace(
    "lines.on('close', () => process.exit(0));",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  );
  const connection = await connectMcpTools({ ...stdioConfig({ pidFile }), args: ['-e', script] });
  const pid = Number(await readFile(pidFile, 'utf8'));
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  });
  await Promise.all([connection.close(), connection.close()]);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('bounded HTTP transport preserves modern JSON-RPC errors returned with HTTP 400', async (t) => {
  const fixture = await httpFixture(t, (rpc, response) => {
    response.writeHead(400, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        error: { code: -32602, message: 'fixture invalid parameter' },
      }),
    );
    return undefined;
  });
  const transport = createMcpHttpTransport(new URL(fixture.url), {}, 1000);
  const messages: unknown[] = [];
  transport.onmessage = (message) => {
    messages.push(message);
  };
  t.after(() => transport.close());
  await transport.start();
  transport.setProtocolVersion?.('2026-07-28');
  await transport.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'echo', _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28' } },
  });
  assert.deepEqual(messages, [
    { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'fixture invalid parameter' } },
  ]);
});
