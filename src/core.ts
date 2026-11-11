import { executeToolCalls, registerTools, validateToolConcurrency, validateToolHooks } from './tool-execution.ts';

/** One agent, one session, one bounded model/tool loop. No built-in capabilities. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Opaque JSON-compatible continuation data. Core validates its shape but never interprets its contents. */
  providerData?: { kind: string; data: unknown };
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface Tool extends ToolDefinition {
  /** Host promise that concurrent calls are safe. Omitted/false tools are serial barriers. */
  parallelSafe?: boolean;
  /** Optional domain check, applied after mandatory JSON Schema validation. */
  validate?: (args: unknown) => boolean;
  // biome-ignore lint/suspicious/noExplicitAny: Agent invokes heterogeneous callbacks after JSON Schema and optional domain validation; direct callers own validation.
  execute: (args: any, ctx: { signal: AbortSignal }) => Promise<unknown>;
}
/** Detached metadata. Mutating it never rewrites the validated invocation. */
export interface ToolCallContext {
  id: string;
  name: string;
  args: unknown;
}
export interface AfterToolCallContext extends ToolCallContext {
  /** JSON-normalized result, including the error payload for a thrown invocation. */
  result: unknown;
  /** Describes execute(), not whether external side effects occurred. */
  outcome: 'returned' | 'threw' | 'serialization_error';
}
export interface ToolHooks {
  /** Runs after validation, before execute (and runtime authorization). Cannot grant permission. */
  beforeToolCall?: (
    call: ToolCallContext,
    context: { signal: AbortSignal },
  ) => void | { block: true; reason?: string } | Promise<{ block: true; reason?: string } | undefined> | Promise<void>;
  /** Runs after execute settles, even on abort. A replacement changes only the model-facing result. */
  afterToolCall?: (
    call: AfterToolCallContext,
    context: { signal: AbortSignal },
  ) => void | { result: unknown } | Promise<{ result: unknown } | undefined> | Promise<void>;
}
export interface Model {
  complete: (
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    onTextDelta?: (text: string) => void | Promise<void>,
  ) => Promise<Message>;
}
/** Discriminants give observers an exhaustive, type-safe execution protocol. */
export type AgentEvent =
  | { type: 'model_start'; step: number }
  | { type: 'assistant_delta'; text: string; step: number }
  | { type: 'assistant'; text: string; step: number }
  | { type: 'tool_start'; name: string; id: string; args: unknown }
  | { type: 'tool_end'; name: string; id: string; result: string; hookError?: string }
  | ({ type: 'done' } & RunResult);
export interface RunResult {
  status: 'completed' | 'blocked' | 'cancelled' | 'limit';
  text: string;
  steps: number;
  error?: string;
}
export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}
/** Versioned conversation data only. Models, tool implementations, and credentials are never included. */
export interface AgentSnapshot {
  version: 1;
  messages: Message[];
}

/** Host-owned, request-only context transformation; never persisted or executed as a tool. */
export type ContextProjector = (
  messages: Message[],
  context: { signal: AbortSignal; step: number },
) => Message[] | Promise<Message[]>;

export interface AgentOptions extends ToolHooks {
  model: Model;
  system?: string;
  tools?: Tool[];
  maxSteps?: number;
  /** Maximum concurrent parallel-safe calls. Defaults to 1 (sequential compatibility). */
  maxToolConcurrency?: number;
  /** Transform detached request messages before each model step; stored history remains intact. */
  projectContext?: ContextProjector;
}

function errorText(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return 'Unknown error';
  }
}

/** Validate untrusted provider output before committing it to the conversation. */
function assistantMessage(reply: Message): Message {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply))
    throw new Error('Model returned an invalid assistant message');
  // Read only own data properties. Cloning first can evaluate accessors or silently
  // drop unsupported continuation fields before the persistence validator sees them.
  const fields: Record<string, unknown> = {};
  for (const key of ['role', 'content', 'tool_calls', 'providerData']) {
    const descriptor = Object.getOwnPropertyDescriptor(reply, key);
    if (!descriptor) continue;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Model returned invalid assistant data');
    fields[key] = descriptor.value;
  }
  const data = fields as unknown as Message;
  if (data.role !== 'assistant' || (data.content !== null && typeof data.content !== 'string')) {
    throw new Error('Model returned an invalid assistant message');
  }
  const calls = data.tool_calls ?? [];
  if (!Array.isArray(calls)) throw new Error('Model returned invalid tool calls');
  const assistant: Message = {
    role: 'assistant',
    content: data.content,
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(data.providerData !== undefined ? { providerData: data.providerData } : {}),
  };
  // The same retained fields must be valid for persistence before any tool can run.
  try {
    jsonValue(assistant);
    assistantFields(assistant);
  } catch {
    throw new Error('Model returned invalid assistant data');
  }
  return assistant;
}

/** Reject lossy JSON values rather than silently changing opaque provider continuation data. */
function jsonValue(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return;
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('Invalid snapshot JSON data');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new Error('Invalid snapshot JSON object');
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor))
      throw new Error('Invalid snapshot JSON property');
    jsonValue(descriptor.value, ancestors);
  }
  if (
    Array.isArray(value) &&
    (Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index)))
  )
    throw new Error('Invalid snapshot JSON array');
  ancestors.delete(value);
}

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid snapshot record');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error('Unknown snapshot field');
  return record;
}

/** Shared structural contract for live responses and restored assistant messages. */
function assistantFields(message: { content?: unknown; tool_calls?: unknown; providerData?: unknown }): Set<string> {
  const pending = new Set<string>();
  if (message.content !== null && typeof message.content !== 'string')
    throw new Error('Invalid snapshot assistant content');
  if (Object.hasOwn(message, 'tool_calls')) {
    if (!Array.isArray(message.tool_calls) || !message.tool_calls.length)
      throw new Error('Invalid snapshot tool calls');
    for (const entry of message.tool_calls) {
      const call = object(entry, ['id', 'type', 'function']);
      const fn = object(call.function, ['name', 'arguments']);
      if (
        typeof call.id !== 'string' ||
        !call.id ||
        pending.has(call.id) ||
        call.type !== 'function' ||
        typeof fn.name !== 'string' ||
        !fn.name ||
        typeof fn.arguments !== 'string'
      )
        throw new Error('Invalid or duplicate snapshot tool call');
      pending.add(call.id);
    }
  }
  if (Object.hasOwn(message, 'providerData')) {
    const provider = object(message.providerData, ['kind', 'data']);
    if (typeof provider.kind !== 'string' || !provider.kind || !Object.hasOwn(provider, 'data'))
      throw new Error('Invalid snapshot provider continuation data');
  }
  return pending;
}

/** Validate a complete, replay-safe history without executing tools or interpreting provider data. */
export function validateAgentSnapshot(value: unknown): AgentSnapshot {
  jsonValue(value);
  const snapshot = object(value, ['version', 'messages']);
  if (snapshot.version !== 1) throw new Error('Unsupported agent snapshot version');
  if (!Array.isArray(snapshot.messages)) throw new Error('Invalid snapshot messages');
  const pending = new Set<string>();
  let previous: unknown;
  for (const [index, entry] of snapshot.messages.entries()) {
    const message = object(entry, ['role', 'content', 'tool_calls', 'tool_call_id', 'providerData']);
    const role = message.role;
    if (pending.size && role !== 'tool') throw new Error('Snapshot has unfinished tool calls');
    if (role === 'tool') {
      if (
        !pending.size ||
        message.tool_call_id !== pending.values().next().value ||
        typeof message.content !== 'string'
      )
        throw new Error('Snapshot has unmatched or out-of-order tool results');
      pending.delete(message.tool_call_id as string);
    } else {
      if (Object.hasOwn(message, 'tool_call_id')) throw new Error('Invalid snapshot tool result');
      if (role === 'system') {
        if (index !== 0 || typeof message.content !== 'string') throw new Error('Invalid snapshot system message');
      } else if (role === 'user') {
        if (typeof message.content !== 'string' || !message.content.trim())
          throw new Error('Invalid snapshot user message');
      } else if (role === 'assistant') {
        if (previous !== 'user' && previous !== 'tool') throw new Error('Invalid snapshot assistant sequence');
        for (const id of assistantFields(message)) pending.add(id);
      } else throw new Error('Invalid snapshot message role');
    }
    if (role !== 'assistant' && (Object.hasOwn(message, 'tool_calls') || Object.hasOwn(message, 'providerData')))
      throw new Error('Invalid snapshot assistant fields');
    previous = role;
  }
  if (pending.size) throw new Error('Snapshot has unfinished tool calls; execution cannot safely be resumed');
  return structuredClone(value) as AgentSnapshot;
}

/**
 * Cancellation is cooperative: injected models/tools must honor the signal.
 * We await an executing tool rather than detach a possibly still-running write.
 * Observation hooks are isolated; failures cannot cause tool execution retries.
 * messages is a detached snapshot, so callers cannot corrupt the session.
 */
export function createAgent({
  model,
  system,
  tools = [],
  maxSteps = 12,
  maxToolConcurrency = 1,
  projectContext,
  beforeToolCall,
  afterToolCall,
}: AgentOptions) {
  validateToolConcurrency(maxToolConcurrency);
  const hooks = { beforeToolCall, afterToolCall };
  validateToolHooks(hooks);
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('maxSteps must be a positive safe integer');
  if (!model || typeof model.complete !== 'function') throw new Error('A model.complete function is required');
  if (projectContext !== undefined && typeof projectContext !== 'function')
    throw new Error('projectContext must be a function');
  const registry = registerTools(tools);
  let history: Message[] = system ? [{ role: 'system', content: system }] : [];
  let running = false;
  return {
    get messages(): Message[] {
      return structuredClone(history);
    },
    /** Call after run settles, never from an in-flight observer or tool. */
    snapshot(): AgentSnapshot {
      if (running) throw new Error('Cannot snapshot an agent session while running');
      return validateAgentSnapshot({ version: 1, messages: history });
    },
    /** Replace idle history only. Restoring never runs a model or repeats a tool. */
    restore(snapshot: unknown): void {
      if (running) throw new Error('Cannot restore an agent session while running');
      const restored = validateAgentSnapshot(snapshot);
      if (system && (restored.messages[0]?.role !== 'system' || restored.messages[0].content !== system))
        throw new Error('Snapshot system message is incompatible with this agent');
      history = restored.messages;
    },
    async run(input: string, options: RunOptions = {}): Promise<RunResult> {
      if (running) throw new Error('This agent session is already running');
      if (typeof input !== 'string' || !input.trim()) throw new Error('Input must be a non-empty string');
      running = true;
      try {
        const signal = options.signal ?? new AbortController().signal;
        let steps = 0;
        let text = '';
        const emit = async (event: AgentEvent) => {
          try {
            await options.onEvent?.(structuredClone(event));
          } catch {
            /* Observers never own execution. */
          }
        };
        const done = async (status: RunResult['status'], error?: string): Promise<RunResult> => {
          const result: RunResult = { status, text, steps, ...(error ? { error } : {}) };
          await emit({ type: 'done', ...result });
          return result;
        };
        try {
          if (signal.aborted) return await done('cancelled');
          history.push({ role: 'user', content: input });
          while (steps < maxSteps) {
            if (signal.aborted) return await done('cancelled');
            let projected: Message[] | undefined;
            if (projectContext) {
              const messages = await projectContext(structuredClone(history), { signal, step: steps + 1 });
              if (signal.aborted) return await done('cancelled');
              try {
                // Validate tool pairing and detach again: the host may retain its returned array.
                projected = validateAgentSnapshot({ version: 1, messages }).messages;
              } catch {
                throw new Error('Context projection must return a complete JSON-compatible message history');
              }
            }
            await emit({ type: 'model_start', step: steps + 1 });
            if (signal.aborted) return await done('cancelled');
            steps++;
            let acceptingDeltas = true;
            let deltaDelivery = Promise.resolve();
            let reply: Message;
            try {
              const response = await model.complete(
                projected ?? structuredClone(history),
                [...registry.values()].map(({ name, description, parameters }) => ({
                  name,
                  description,
                  parameters: structuredClone(parameters),
                })),
                signal,
                (delta) => {
                  if (!acceptingDeltas || signal.aborted || typeof delta !== 'string' || !delta)
                    return Promise.resolve();
                  const event: AgentEvent = { type: 'assistant_delta', text: delta, step: steps };
                  // Injected models may ignore the returned promise. Keep observation ordered anyway.
                  deltaDelivery = deltaDelivery.then(() => emit(event));
                  return deltaDelivery;
                },
              );
              // Validate and detach retained data before awaiting any queued observers.
              reply = structuredClone(assistantMessage(response));
            } finally {
              acceptingDeltas = false;
              // Drain accepted callbacks before assistant/done, including failures and cancellation.
              await deltaDelivery;
            }
            if (signal.aborted) return await done('cancelled');
            const assistant = reply;
            const calls = assistant.tool_calls ?? [];
            history.push(assistant);
            text = reply.content ?? '';
            await emit({ type: 'assistant', text, step: steps });
            if (!calls.length) return await done(signal.aborted ? 'cancelled' : 'completed');
            // Execution events follow completion; retained results always follow model order.
            const results = await executeToolCalls(calls, registry, signal, emit, maxToolConcurrency, hooks);
            for (const [index, call] of calls.entries()) {
              history.push({ role: 'tool', tool_call_id: call.id, content: results[index] as string });
            }
            if (signal.aborted) return await done('cancelled');
          }
          return await done('limit', `Reached maximum of ${maxSteps} model steps`);
        } catch (error) {
          return await done(signal.aborted ? 'cancelled' : 'blocked', errorText(error));
        }
      } finally {
        running = false;
      }
    },
  };
}
