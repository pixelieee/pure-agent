import OpenAI from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
  ResponseFunctionWebSearch,
} from 'openai/resources/responses/responses';
import type { Message, Model, ToolCall } from '../core.ts';

type ProviderResponse = Pick<Response, 'output' | 'status' | 'usage' | 'error' | 'incomplete_details'>;
/** Narrow transport seam; the adapter never executes local tools. Opted-in hosted tools run at OpenAI. */
export interface OpenAIClient {
  responses: {
    create: (
      body: ResponseCreateParamsNonStreaming,
      options: { signal: AbortSignal; maxRetries: number; timeout: number },
    ) => Promise<ProviderResponse>;
    /** Official SDK streaming helper; optional for existing injected transports. */
    stream?: (
      body: ResponseCreateParamsStreaming,
      options: { signal: AbortSignal; maxRetries: number; timeout: number },
    ) => AsyncIterable<ResponseStreamEvent>;
  };
}
export interface OpenAIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}
export interface OpenAIWebCitation {
  url: string;
  title: string;
  /** Offsets into the original output_text part, not the appended Sources display. */
  startIndex: number;
  endIndex: number;
  messageId: string;
  contentIndex: number;
}
export type OpenAIWebSearchEvent =
  | { type: 'status'; id: string; status: 'in_progress' | 'searching' | 'completed' }
  | { type: 'search'; call: ResponseFunctionWebSearch }
  | { type: 'citation'; citation: OpenAIWebCitation };
export interface OpenAIModelOptions {
  apiKey?: string;
  client?: OpenAIClient;
  model?: string;
  reasoningEffort?: 'low' | 'medium';
  /** Positive integer from 1 through 65536, default 4096 (includes reasoning tokens). */
  maxCompletionTokens?: number;
  /** Explicit opt-in to hosted web_search and API charges. Default false; at most 3 hosted calls per response. */
  webSearch?: boolean;
  /** Untrusted search metadata for presentation only. Observer errors cannot retry requests. */
  onWebSearch?: (event: OpenAIWebSearchEvent) => void | Promise<void>;
  /** Numeric-only accounting, including rejected responses. Callback errors are isolated. */
  onUsage?: (usage: OpenAIUsage) => void | Promise<void>;
}
const fail = (code: string): Error => new Error(`OPENAI_${code}`);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function safeWebURL(value: unknown): value is string {
  if (!nonempty(value) || [...value].some((character) => character.charCodeAt(0) <= 32)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
function validSearch(item: ResponseFunctionWebSearch): boolean {
  const action = item.action;
  if (!nonempty(item.id) || item.status !== 'completed' || !action || typeof action !== 'object') return false;
  switch (action.type) {
    case 'search':
      return (
        (action.query === undefined || typeof action.query === 'string') &&
        (action.queries === undefined ||
          (Array.isArray(action.queries) && action.queries.every((query) => typeof query === 'string'))) &&
        (action.sources === undefined ||
          (Array.isArray(action.sources) &&
            action.sources.every((source) => source && source.type === 'url' && safeWebURL(source.url))))
      );
    case 'open_page':
      return action.url == null || safeWebURL(action.url);
    case 'find_in_page':
      return safeWebURL(action.url) && typeof action.pattern === 'string';
    default:
      return false;
  }
}

/** Accept only the output capabilities this adapter supports; preserve opaque reasoning. */
function decodeOutput(
  output: unknown,
  allowWebSearch = false,
): {
  content: string | null;
  calls: ToolCall[];
  output: ResponseOutputItem[];
  webSearch: { calls: ResponseFunctionWebSearch[]; citations: OpenAIWebCitation[] };
} {
  if (!Array.isArray(output) || !output.length) throw fail('INVALID_RESPONSE');
  const texts: string[] = [];
  const calls: ToolCall[] = [];
  const searches: ResponseFunctionWebSearch[] = [];
  const citations: OpenAIWebCitation[] = [];
  const ids = new Set<string>();
  for (const item of output) {
    if (!item || typeof item !== 'object') throw fail('INVALID_RESPONSE');
    if (item.status !== undefined && item.status !== 'completed') throw fail('INCOMPLETE_RESPONSE');
    switch (item.type) {
      case 'message':
        if (item.role !== 'assistant' || !nonempty(item.id) || !Array.isArray(item.content))
          throw fail('INVALID_RESPONSE');
        for (const [contentIndex, part] of item.content.entries()) {
          if (part?.type === 'refusal') throw fail('REFUSAL');
          if (part?.type !== 'output_text' || typeof part.text !== 'string') throw fail('INVALID_RESPONSE');
          texts.push(part.text);
          if (part.annotations !== undefined && !Array.isArray(part.annotations)) throw fail('INVALID_RESPONSE');
          for (const annotation of part.annotations ?? []) {
            if (annotation?.type !== 'url_citation') continue;
            if (
              !safeWebURL(annotation.url) ||
              typeof annotation.title !== 'string' ||
              !Number.isSafeInteger(annotation.start_index) ||
              !Number.isSafeInteger(annotation.end_index) ||
              annotation.start_index < 0 ||
              annotation.end_index < annotation.start_index ||
              annotation.end_index > part.text.length
            )
              throw fail('INVALID_RESPONSE');
            citations.push({
              url: annotation.url,
              title: annotation.title,
              startIndex: annotation.start_index,
              endIndex: annotation.end_index,
              messageId: item.id,
              contentIndex,
            });
          }
        }
        break;
      case 'function_call': {
        if (
          !nonempty(item.call_id) ||
          ids.has(item.call_id) ||
          !nonempty(item.name) ||
          typeof item.arguments !== 'string'
        )
          throw fail('INVALID_TOOL_CALL');
        let args: unknown;
        try {
          args = JSON.parse(item.arguments);
        } catch {
          throw fail('INVALID_TOOL_CALL');
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('INVALID_TOOL_CALL');
        ids.add(item.call_id);
        calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
        break;
      }
      case 'web_search_call':
        if (!allowWebSearch) throw fail('UNSUPPORTED_OUTPUT');
        if (!validSearch(item)) throw fail('INVALID_WEB_SEARCH');
        searches.push(structuredClone(item));
        break;
      case 'reasoning':
        if (
          !nonempty(item.id) ||
          !Array.isArray(item.summary) ||
          item.summary.some(
            (part: unknown) =>
              !part ||
              typeof part !== 'object' ||
              !('type' in part) ||
              part.type !== 'summary_text' ||
              !('text' in part) ||
              typeof part.text !== 'string',
          ) ||
          (item.encrypted_content != null && typeof item.encrypted_content !== 'string')
        )
          throw fail('INVALID_RESPONSE');
        break;
      default:
        throw fail('UNSUPPORTED_OUTPUT');
    }
  }
  if (!texts.length && !calls.length) throw fail('INVALID_RESPONSE');
  let content = texts.length ? texts.join('\n') : null;
  // Keep sources visible in clients that only render Message.content. Original
  // output and citation offsets remain untouched for SDK continuation replay.
  const urls = [...new Set(citations.map(({ url }) => url))];
  if (content !== null && urls.length) content += `\n\nSources:\n${urls.map((url) => `- ${url}`).join('\n')}`;
  return { content, calls, output: structuredClone(output), webSearch: { calls: searches, citations } };
}

function wireMessages(messages: Message[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!nonempty(message.tool_call_id) || typeof message.content !== 'string') throw fail('INVALID_MESSAGE');
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
    } else if (message.role === 'assistant' && message.providerData) {
      if (message.providerData.kind !== 'openai.responses') throw fail('INVALID_PROVIDER_DATA');
      const data = message.providerData.data as { output?: unknown } | null;
      const decoded = decodeOutput(data?.output, true);
      if (
        decoded.content !== message.content ||
        JSON.stringify(decoded.calls) !== JSON.stringify(message.tool_calls ?? [])
      )
        throw fail('INVALID_PROVIDER_DATA');
      try {
        input.push(...toResponseInputItems(decoded.output));
      } catch {
        throw fail('INVALID_PROVIDER_DATA');
      }
    } else {
      if (typeof message.content === 'string') input.push({ role: message.role, content: message.content });
      else if (message.role !== 'assistant' || !message.tool_calls?.length) throw fail('INVALID_MESSAGE');
      if (message.role === 'assistant')
        for (const call of message.tool_calls ?? []) {
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
    }
  }
  return input;
}

function requestError(error: unknown, signal: AbortSignal, webSearch: boolean): Error {
  if (signal.aborted || error instanceof OpenAI.APIUserAbortError) return fail('ABORTED');
  if (error instanceof OpenAI.APIConnectionTimeoutError) return fail('TIMEOUT');
  if (error instanceof OpenAI.APIError) {
    if (error.status === 400) {
      if (webSearch && typeof error.param === 'string' && /^tools(?:\[0\]|\.0)(?:\.type)?$/.test(error.param))
        return fail('WEB_SEARCH_UNAVAILABLE');
      const params: Record<string, string> = {
        reasoning: 'REASONING',
        reasoning_effort: 'REASONING_EFFORT',
        tools: 'TOOLS',
        input: 'INPUT',
        max_output_tokens: 'MAX_OUTPUT_TOKENS',
        model: 'MODEL',
      };
      const param =
        typeof error.param === 'string' && Object.hasOwn(params, error.param) ? params[error.param] : undefined;
      return fail(param ? `INVALID_REQUEST_${param}` : 'INVALID_REQUEST');
    }
    if (error.status === 401) return fail('AUTHENTICATION');
    if (error.status === 403) return fail('PERMISSION');
    if (error.status === 404) return fail(error.code === 'model_not_found' ? 'MODEL_UNAVAILABLE' : 'NOT_FOUND');
    if (error.status === 429) return fail('RATE_LIMIT');
    if (error.status && error.status >= 500) return fail('SERVER_ERROR');
  }
  return fail('REQUEST_FAILED');
}

/** Stateless Responses API: all continuation state belongs to the agent history, not this model. */
export function createOpenAIModel(options: OpenAIModelOptions): Model {
  const model = options.model ?? 'gpt-5.6-luna';
  const effort = options.reasoningEffort ?? 'low';
  const maxTokens = options.maxCompletionTokens ?? 4096;
  const webSearch = options.webSearch ?? false;
  const onWebSearch = options.onWebSearch;
  const onUsage = options.onUsage;
  if (
    !nonempty(model) ||
    !model.trim() ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > 65536 ||
    typeof webSearch !== 'boolean' ||
    (onWebSearch !== undefined && typeof onWebSearch !== 'function') ||
    !['low', 'medium'].includes(effort) ||
    (onUsage !== undefined && typeof onUsage !== 'function')
  )
    throw fail('INVALID_CONFIG');
  if (!options.client && (typeof options.apiKey !== 'string' || !options.apiKey.trim())) throw fail('MISSING_API_KEY');
  let client: OpenAIClient;
  try {
    client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey,
        baseURL: 'https://api.openai.com/v1',
        maxRetries: 0,
        timeout: 30_000,
        logLevel: 'off',
      });
  } catch {
    throw fail('INVALID_CONFIG');
  }
  const emitWeb = async (event: OpenAIWebSearchEvent) => {
    try {
      await onWebSearch?.(structuredClone(event));
    } catch {
      /* Presentation cannot alter execution. */
    }
  };
  return {
    async complete(messages, tools, signal, onTextDelta) {
      if (signal.aborted) throw fail('ABORTED');
      const body: ResponseCreateParamsNonStreaming = {
        model,
        input: wireMessages(messages),
        reasoning: { effort },
        max_output_tokens: maxTokens,
        store: false,
        include: ['reasoning.encrypted_content', ...(webSearch ? ['web_search_call.action.sources' as const] : [])],
        stream: false,
        ...(webSearch ? { max_tool_calls: 3 } : {}),
        ...(tools.length || webSearch
          ? {
              tools: [
                ...(webSearch
                  ? [{ type: 'web_search' as const, user_location: { type: 'approximate' as const } }]
                  : []),
                ...tools.map(({ name, description, parameters }) => ({
                  type: 'function' as const,
                  name,
                  description,
                  parameters: structuredClone(parameters),
                  strict: false,
                })),
              ],
            }
          : {}),
      };
      let response: ProviderResponse | undefined;
      let streamError = false;
      try {
        const requestOptions = { signal, maxRetries: 0, timeout: 30_000 };
        if (onTextDelta && client.responses.stream) {
          for await (const event of client.responses.stream({ ...body, stream: true }, requestOptions)) {
            if (signal.aborted) break;
            if (
              webSearch &&
              (event.type === 'response.web_search_call.in_progress' ||
                event.type === 'response.web_search_call.searching' ||
                event.type === 'response.web_search_call.completed')
            ) {
              await emitWeb({
                type: 'status',
                id: event.item_id,
                status:
                  event.type === 'response.web_search_call.completed'
                    ? 'completed'
                    : event.type === 'response.web_search_call.searching'
                      ? 'searching'
                      : 'in_progress',
              });
            } else if (event.type === 'response.output_text.delta' && nonempty(event.delta)) {
              try {
                await onTextDelta(event.delta);
              } catch {
                /* Presentation cannot alter execution. */
              }
            } else if (
              event.type === 'response.completed' ||
              event.type === 'response.incomplete' ||
              event.type === 'response.failed'
            ) {
              response = event.response;
              break; // Terminal accounting and output are accepted exactly once.
            } else if (event.type === 'error') {
              streamError = true;
              break;
            }
          }
        } else response = await client.responses.create(body, requestOptions);
      } catch (error) {
        throw requestError(error, signal, webSearch);
      }
      if (onUsage && response?.usage) {
        const usage: OpenAIUsage = {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.total_tokens,
          cachedTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
          reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens ?? 0,
        };
        if (Object.values(usage).every((value) => Number.isSafeInteger(value) && value >= 0)) {
          try {
            await onUsage(usage);
          } catch {
            /* Accounting cannot alter execution. */
          }
        }
      }
      if (signal.aborted) throw fail('ABORTED');
      if (streamError) throw fail('RESPONSE_FAILED');
      if (response?.status === 'incomplete')
        throw fail(response.incomplete_details?.reason === 'max_output_tokens' ? 'TRUNCATED' : 'INCOMPLETE_RESPONSE');
      if (response?.status === 'failed' || response?.error) throw fail('RESPONSE_FAILED');
      if (response?.status !== 'completed') throw fail('INCOMPLETE_RESPONSE');
      const decoded = decodeOutput(response.output, webSearch);
      for (const call of decoded.webSearch.calls) await emitWeb({ type: 'search', call });
      for (const citation of decoded.webSearch.citations) await emitWeb({ type: 'citation', citation });
      if (signal.aborted) throw fail('ABORTED');
      return {
        role: 'assistant',
        content: decoded.content,
        ...(decoded.calls.length ? { tool_calls: decoded.calls } : {}),
        providerData: {
          kind: 'openai.responses',
          data: {
            output: decoded.output,
            ...(decoded.webSearch.calls.length || decoded.webSearch.citations.length
              ? { webSearch: decoded.webSearch }
              : {}),
          },
        },
      };
    },
  };
}
