import {
  StreamableHTTPClientTransport,
  isJSONRPCRequest,
  isJSONRPCResponse,
  type FetchLike,
  type RequestId,
  type Transport,
} from '@modelcontextprotocol/client';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Bound decoded bytes before SDK JSON/SSE parsing, including error and incomplete bodies. */
function boundedFetch(timeoutMs: number): FetchLike {
  return async (url, init) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(timeoutMs),
      ...(init?.signal ? [init.signal] : []),
    ]);
    const response = await fetch(url, { ...init, signal });
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
      controller.abort();
      await response.body?.cancel().catch(() => {});
      throw new Error('MCP_HTTP_RESPONSE_LIMIT: response exceeds 2 MiB');
    }
    if (!response.body) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          bytes += chunk.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            controller.abort();
            throw new Error('MCP_HTTP_RESPONSE_LIMIT: response exceeds 2 MiB');
          }
          stream.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/**
 * SDK v2.4 aborts HTTP requests on modern-era cancellation, but legacy cancellation
 * only sends a notification. Preserve that notification while also closing its
 * exact HTTP stream. This boundary uses the public Transport API, not SDK internals.
 */
export function createMcpHttpTransport(url: URL, headers: Record<string, string>, timeoutMs: number): Transport {
  const http = new StreamableHTTPClientTransport(url, {
    fetch: boundedFetch(timeoutMs),
    requestInit: { headers, redirect: 'error' },
    onInsufficientScope: 'throw',
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 1000,
      initialReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const requests = new Map<RequestId, AbortController>();
  const finish = (id: RequestId) => {
    const controller = requests.get(id);
    requests.delete(id);
    controller?.abort();
  };
  const transport: Transport = {
    hasPerRequestStream: true,
    get sessionId() {
      return http.sessionId;
    },
    setProtocolVersion(version) {
      http.setProtocolVersion(version);
    },
    async start() {
      http.onclose = () => transport.onclose?.();
      http.onerror = (error) => transport.onerror?.(error);
      http.onmessage = (message) => {
        transport.onmessage?.(message);
        if (isJSONRPCResponse(message) && message.id !== undefined) finish(message.id);
      };
      await http.start();
    },
    async send(message, options) {
      if ('method' in message && message.method === 'notifications/cancelled') {
        const id = message.params?.requestId;
        if (typeof id === 'string' || typeof id === 'number') finish(id);
      }
      if (!isJSONRPCRequest(message)) return http.send(message, options);
      const controller = new AbortController();
      requests.set(message.id, controller);
      const requestSignal = options?.requestSignal
        ? AbortSignal.any([controller.signal, options.requestSignal])
        : controller.signal;
      requestSignal.addEventListener('abort', () => finish(message.id), { once: true });
      try {
        await http.send(message, { ...options, requestSignal });
      } catch (error) {
        finish(message.id);
        throw error;
      }
    },
    async close() {
      for (const id of requests.keys()) finish(id);
      await http.close();
    },
  };
  return transport;
}
