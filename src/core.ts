import { compileParameters } from './schema.ts';

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
  /** Opaque adapter-owned continuation data. Core preserves it without interpreting it. */
  providerData?: { kind: string; data: unknown };
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface Tool extends ToolDefinition {
  /** Optional domain check, applied after mandatory JSON Schema validation. */
  validate?: (args: unknown) => boolean;
  // biome-ignore lint/suspicious/noExplicitAny: Agent invokes heterogeneous callbacks after JSON Schema and optional domain validation; direct callers own validation.
  execute: (args: any, ctx: { signal: AbortSignal }) => Promise<unknown>;
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
  | { type: 'tool_end'; name: string; id: string; result: string }
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
export interface AgentOptions {
  model: Model;
  system?: string;
  tools?: Tool[];
  maxSteps?: number;
}

function errorText(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return 'Unknown error';
  }
}
const toolError = (error: string): string => JSON.stringify({ ok: false, error });

/** Validate untrusted provider output before committing it to the conversation. */
function assistantMessage(reply: Message): Message {
  if (reply.role !== 'assistant' || (reply.content !== null && typeof reply.content !== 'string')) {
    throw new Error('Model returned an invalid assistant message');
  }
  const calls = reply.tool_calls ?? [];
  if (!Array.isArray(calls)) throw new Error('Model returned invalid tool calls');
  const ids = new Set<string>();
  for (const call of calls) {
    if (
      !call ||
      typeof call.id !== 'string' ||
      !call.id ||
      ids.has(call.id) ||
      call.type !== 'function' ||
      typeof call.function?.name !== 'string' ||
      typeof call.function?.arguments !== 'string'
    )
      throw new Error('Model returned an invalid or duplicate tool call');
    ids.add(call.id);
  }
  if (reply.providerData !== undefined && (!reply.providerData || typeof reply.providerData.kind !== 'string')) {
    throw new Error('Model returned invalid provider continuation data');
  }
  const assistant: Message = {
    role: 'assistant',
    content: reply.content,
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(reply.providerData ? { providerData: structuredClone(reply.providerData) } : {}),
  };
  return assistant;
}

interface RegisteredTool extends Tool {
  validateSchema: (args: unknown) => void;
}

type Emit = (event: AgentEvent) => Promise<void>;

/** A single tool invocation. Never retries, and always yields a protocol-safe result. */
async function invokeTool(
  call: ToolCall,
  registry: Map<string, RegisteredTool>,
  signal: AbortSignal,
  emit: Emit,
): Promise<string> {
  if (signal.aborted) return toolError('Cancelled before execution');
  const name = call.function.name;
  try {
    const tool = registry.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const args: unknown = JSON.parse(call.function.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new Error('Tool arguments must be a JSON object');
    tool.validateSchema(args);
    if (tool.validate && tool.validate(structuredClone(args)) !== true)
      throw new Error(`Invalid arguments for tool: ${name}`);
    await emit({ type: 'tool_start', name, id: call.id, args });
    if (signal.aborted) throw new Error('Cancelled before execution');
    const value = await tool.execute(args, { signal });
    const result = JSON.stringify(value ?? null);
    if (typeof result !== 'string') throw new Error('Tool result is not JSON serializable');
    return result;
  } catch (error) {
    return toolError(errorText(error));
  }
}

/**
 * Cancellation is cooperative: injected models/tools must honor the signal.
 * We await an executing tool rather than detach a possibly still-running write.
 * Observation hooks are isolated; failures cannot cause tool execution retries.
 * messages is a detached snapshot, so callers cannot corrupt the session.
 */
export function createAgent({ model, system, tools = [], maxSteps = 12 }: AgentOptions) {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('maxSteps must be a positive safe integer');
  if (!model || typeof model.complete !== 'function') throw new Error('A model.complete function is required');
  const registry = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    if (!tool.name || registry.has(tool.name)) throw new Error(`Invalid or duplicate tool name: ${tool.name}`);
    if (tool.validate !== undefined && typeof tool.validate !== 'function')
      throw new Error(`Tool ${tool.name} requires a validate function`);
    const parameters = structuredClone(tool.parameters);
    registry.set(tool.name, { ...tool, parameters, validateSchema: compileParameters(parameters) });
  }
  const history: Message[] = system ? [{ role: 'system', content: system }] : [];
  let running = false;
  return {
    get messages(): Message[] {
      return structuredClone(history);
    },
    async run(input: string, options: RunOptions = {}): Promise<RunResult> {
      if (running) throw new Error('This agent session is already running');
      if (typeof input !== 'string' || !input.trim()) throw new Error('Input must be a non-empty string');
      running = true;
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
          await emit({ type: 'model_start', step: steps + 1 });
          if (signal.aborted) return await done('cancelled');
          steps++;
          let acceptingDeltas = true;
          let deltaDelivery = Promise.resolve();
          let reply: Message;
          try {
            reply = structuredClone(
              await model.complete(
                structuredClone(history),
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
              ),
            );
          } finally {
            acceptingDeltas = false;
            // Drain accepted callbacks before assistant/done, including failures and cancellation.
            await deltaDelivery;
          }
          if (signal.aborted) return await done('cancelled');
          const assistant = assistantMessage(reply);
          const calls = assistant.tool_calls ?? [];
          history.push(assistant);
          text = reply.content ?? '';
          await emit({ type: 'assistant', text, step: steps });
          if (!calls.length) return await done(signal.aborted ? 'cancelled' : 'completed');
          // Always append one ordered result per call, even when interrupted midway.
          for (const call of calls) {
            const name = call.function.name;
            const result = await invokeTool(call, registry, signal, emit);
            history.push({ role: 'tool', tool_call_id: call.id, content: result });
            await emit({ type: 'tool_end', name, id: call.id, result });
          }
          if (signal.aborted) return await done('cancelled');
        }
        return await done('limit', `Reached maximum of ${maxSteps} model steps`);
      } catch (error) {
        return await done(signal.aborted ? 'cancelled' : 'blocked', errorText(error));
      } finally {
        running = false;
      }
    },
  };
}
