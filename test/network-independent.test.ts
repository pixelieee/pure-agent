import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import dns from 'node:dns/promises';
import test, { type TestContext } from 'node:test';
import OpenAI from 'openai';
import { connectMcpTools } from '../src/extensions/mcp.ts';
import { createWebFetchTool } from '../src/extensions/web.ts';
import { createOpenAIModel } from '../src/providers/openai.ts';

const context = () => ({ signal: new AbortController().signal });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Rpc = { id?: number; method: string; params?: Record<string, unknown> };
async function listen(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
function initialize(rpc: Rpc) {
  return {
    protocolVersion: rpc.params?.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: 'independent', version: '1' },
  };
}
const tool = {
  name: 'echo',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
  annotations: { readOnlyHint: true },
};
async function peer(t: TestContext, handler: (rpc: Rpc, req: IncomingMessage, res: ServerResponse) => unknown) {
  return listen(t, async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const part of req) body += part.toString();
    const rpc = JSON.parse(body) as Rpc;
    if (rpc.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result = handler(rpc, req, res);
    if (result !== undefined && !res.writableEnded)
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
}

test('independent: HTTP initialization diagnostics never echo configured credentials', async (t) => {
  const secret = 'independent-fixture-secret-not-real';
  const url = await listen(t, (req, res) => res.writeHead(500).end(`invalid credential ${req.headers.authorization}`));
  await assert.rejects(
    connectMcpTools({ namespace: 'secret', transport: 'http', url, headers: { Authorization: `Bearer ${secret}` } }),
    (error: Error) => {
      assert.match(error.message, /MCP_CONNECT_FAILED/);
      assert.equal(
        error.message.includes(secret),
        false,
        'HTTP response reflected the configured bearer token into the diagnostic',
      );
      return true;
    },
  );
});

test('independent: HTTP call diagnostics never echo configured credentials', async (t) => {
  const secret = 'independent-call-secret-not-real';
  const url = await peer(t, (rpc, req, res) => {
    if (rpc.method === 'initialize') return initialize(rpc);
    if (rpc.method === 'tools/list') return { tools: [tool] };
    res.writeHead(500).end(`invalid credential ${req.headers.authorization}`);
    return undefined;
  });
  const connection = await connectMcpTools({
    namespace: 'secret',
    transport: 'http',
    url,
    headers: { Authorization: `Bearer ${secret}` },
  });
  t.after(() => connection.close());
  await assert.rejects(connection.tools[0].execute({}, context()), (error: Error) => {
    assert.match(error.message, /MCP_CALL_FAILED.*may have occurred/);
    assert.equal(
      error.message.includes(secret),
      false,
      'HTTP response reflected the configured bearer token into the core-visible diagnostic',
    );
    return true;
  });
});

test('independent: MCP pagination cycles fail closed, annotation cannot grant read-only rights', async (t) => {
  let page = 0;
  const url = await peer(t, (rpc) =>
    rpc.method === 'initialize' ? initialize(rpc) : { tools: [{ ...tool, name: `echo${++page}` }], nextCursor: 'same' },
  );
  await assert.rejects(connectMcpTools({ namespace: 'cycle', transport: 'http', url }), /MCP_LIST_CYCLE/);
  assert.equal(page, 2);
  const normal = await peer(t, (rpc) => (rpc.method === 'initialize' ? initialize(rpc) : { tools: [tool] }));
  const connection = await connectMcpTools({ namespace: 'annotation', transport: 'http', url: normal });
  assert.equal(connection.metadata.get(connection.tools[0].name)?.readOnly, false);
  await Promise.all([connection.close(), connection.close(), connection.close()]);
});

test('independent: MCP cancellation closes the outstanding HTTP response stream', async (t) => {
  const received = deferred();
  const disconnected = deferred();
  const url = await peer(t, (rpc, _req, res) => {
    if (rpc.method === 'initialize') return initialize(rpc);
    if (rpc.method === 'tools/list') return { tools: [tool] };
    res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
    res.once('close', () => disconnected.resolve());
    received.resolve();
    return undefined;
  });
  const connection = await connectMcpTools({ namespace: 'cancel', transport: 'http', url, timeoutMs: 1000 });
  t.after(() => connection.close());
  const controller = new AbortController();
  const pending = connection.tools[0].execute({}, { signal: controller.signal });
  await received.promise;
  controller.abort();
  await assert.rejects(pending, /MCP_CALL_FAILED/);
  await Promise.race([
    disconnected.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP stream survived cancellation')), 500)),
  ]);
});

test('independent: web fetch refuses IPv6 transition, Unicode localhost, and mixed DNS answers', async (t) => {
  const fetcher = createWebFetchTool();
  for (const host of [
    '[::ffff:7f00:1]',
    '[64:ff9b::7f00:1]',
    '[2001:0:4136:e378:8000:63bf:3fff:fdd2]',
    '[2002:0a00:0001::1]',
    'localhost\u3002',
  ])
    await assert.rejects(fetcher.execute({ url: `http://${host}/` }, context()), /WEB_FETCH_PRIVATE_NETWORK/);
  const resolve = t.mock.method(dns, 'lookup', async () => [
    { address: '2606:4700:4700::1111', family: 6 },
    { address: 'fd00::1', family: 6 },
  ]);
  await assert.rejects(fetcher.execute({ url: 'https://fixture.invalid/' }, context()), /WEB_FETCH_PRIVATE_NETWORK/);
  assert.equal(resolve.mock.callCount(), 1);
});

test('independent: web fetch cancels an incomplete body and exposes no HTTP error body', async (t) => {
  const disconnected = deferred();
  const base = await listen(t, (req, res) => {
    if (req.url === '/error') {
      res.writeHead(500).end('secret-body-must-not-appear');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).write('prefix');
    res.once('close', () => disconnected.resolve());
  });
  const fetcher = createWebFetchTool({ allowPrivateNetwork: true, timeoutMs: 50 });
  await assert.rejects(fetcher.execute({ url: `${base}/error` }, context()), { message: 'WEB_FETCH_HTTP_500' });
  await assert.rejects(fetcher.execute({ url: base }, context()), { message: 'WEB_FETCH_TIMEOUT' });
  await Promise.race([
    disconnected.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP stream survived timeout')), 500)),
  ]);
});

function providerOutput(sourceUrl: string) {
  return {
    id: 'response_independent',
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'web_search_call',
        id: 'search_independent',
        status: 'completed',
        action: { type: 'search', queries: ['test'], sources: [{ type: 'url', url: sourceUrl }] },
      },
      {
        type: 'message',
        id: 'message_independent',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Found.', annotations: [] }],
      },
    ],
    error: null,
    incomplete_details: null,
    usage: null,
  };
}

test('independent: hosted search rejects unsafe source URLs before emitting metadata', async (t) => {
  // Real official SDK over local HTTP, not a live provider or mocked SDK method.
  let source = 'javascript:alert(1)';
  const baseURL = await listen(t, (_req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(providerOutput(source))),
  );
  const client = new OpenAI({ apiKey: 'offline-not-real', baseURL });
  for (const value of ['javascript:alert(1)', 'file:///private', 'https://user:password@example.invalid/path']) {
    source = value;
    const events: unknown[] = [];
    const model = createOpenAIModel({
      client,
      webSearch: true,
      onWebSearch: (event) => {
        events.push(event);
      },
    });
    await assert.rejects(
      model.complete([{ role: 'user', content: 'Find it' }], [], context().signal),
      /OPENAI_INVALID_WEB_SEARCH/,
    );
    assert.equal(events.length, 0);
  }
});

test('independent: cancelling one MCP call leaves concurrent calls usable', async (t) => {
  const started = deferred();
  const disconnected = deferred();
  const url = await peer(t, (rpc, _req, res) => {
    if (rpc.method === 'initialize') return initialize(rpc);
    if (rpc.method === 'tools/list') return { tools: [tool] };
    const args = rpc.params?.arguments as { value?: string } | undefined;
    if (args?.value === 'cancel') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
      res.once('close', disconnected.resolve);
      started.resolve();
      return undefined;
    }
    setTimeout(
      () =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { content: [{ type: 'text', text: 'concurrent-success' }] },
          }),
        ),
      75,
    );
    return undefined;
  });
  const connection = await connectMcpTools({ namespace: 'concurrent', transport: 'http', url, timeoutMs: 1500 });
  t.after(() => connection.close());
  const controller = new AbortController();
  const cancelled = connection.tools[0].execute({ value: 'cancel' }, { signal: controller.signal });
  await started.promise;
  const ongoing = connection.tools[0].execute({ value: 'keep' }, context());
  controller.abort();
  await assert.rejects(cancelled, /MCP_CALL_FAILED/);
  const result = await ongoing;
  assert.match(JSON.stringify(result), /concurrent-success/);
  await Promise.race([
    disconnected.promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('cancelled HTTP stream survived concurrent success')), 500),
    ),
  ]);
});

test('independent: HTTP transport caps incoming payload before output truncation', async (t) => {
  const url = await peer(t, (rpc) =>
    rpc.method === 'initialize'
      ? initialize(rpc)
      : rpc.method === 'tools/list'
        ? { tools: [tool] }
        : { content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024 + 4096) }] },
  );
  const connection = await connectMcpTools({ namespace: 'inputbound', transport: 'http', url, maxOutputBytes: 1024 });
  t.after(() => connection.close());
  await assert.rejects(connection.tools[0].execute({}, context()), /MCP_CALL_FAILED/);
});

test('independent: stdio receives explicit environment but no ambient credentials or Node startup injection', async (t) => {
  const variables = ['AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GITHUB_TOKEN', 'NODE_OPTIONS'];
  const previous = variables.map((key) => process.env[key]);
  for (const key of variables) process.env[key] = `independent-fake-${key}`;
  t.after(() => {
    variables.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  });
  const script = String.raw`
    require('node:readline').createInterface({input: process.stdin}).on('line', (line) => {
      const rpc = JSON.parse(line);
      if (rpc.id === undefined) return;
      const result = rpc.method === 'initialize' ? {protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'env-independent',version:'1'}} : rpc.method === 'tools/list' ? {tools:[{name:'env',inputSchema:{type:'object'}}]} : {content:[{type:'text',text:JSON.stringify({explicit:process.env.INDEPENDENT_EXPLICIT,unexpected:['AWS_SECRET_ACCESS_KEY','GOOGLE_APPLICATION_CREDENTIALS','GITHUB_TOKEN','NODE_OPTIONS'].filter(key=>process.env[key]!==undefined)})}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})+'\n');
    }).on('close',()=>process.exit(0));
  `;
  const connection = await connectMcpTools({
    namespace: 'stdioenv',
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', script],
    env: { INDEPENDENT_EXPLICIT: 'host-chosen' },
    timeoutMs: 1500,
  });
  t.after(() => connection.close());
  assert.deepEqual(
    JSON.parse(((await connection.tools[0].execute({}, context())) as { content: { text: string }[] }).content[0].text),
    { explicit: 'host-chosen', unexpected: [] },
  );
  await connection.close();
  await connection.close();
});

test('independent: completed MCP SSE replies close their own stream and keep the connection usable', async (t) => {
  const disconnected = deferred();
  let calls = 0;
  const url = await peer(t, (rpc, _req, res) => {
    if (rpc.method === 'initialize') return initialize(rpc);
    if (rpc.method === 'tools/list') return { tools: [tool] };
    calls++;
    if (calls > 1) return { content: [{ type: 'text', text: 'next-call' }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.once('close', disconnected.resolve);
    res.write(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'completed-sse' }] } })}\n\n`,
    );
    return undefined;
  });
  const connection = await connectMcpTools({ namespace: 'ssefinish', transport: 'http', url, timeoutMs: 1500 });
  t.after(() => connection.close());
  assert.match(JSON.stringify(await connection.tools[0].execute({}, context())), /completed-sse/);
  await Promise.race([
    disconnected.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('completed HTTP stream stayed open')), 500)),
  ]);
  assert.match(JSON.stringify(await connection.tools[0].execute({}, context())), /next-call/);
});
