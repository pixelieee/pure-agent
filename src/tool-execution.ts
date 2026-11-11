import type { AfterToolCallContext, AgentEvent, Tool, ToolCall, ToolHooks } from './core.ts';
import { compileParameters } from './schema.ts';

function errorText(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return 'Unknown error';
  }
}
const toolError = (error: string): string => JSON.stringify({ ok: false, error });

export function validateToolConcurrency(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('maxToolConcurrency must be a positive safe integer');
}

export function registerTools(tools: Tool[]): Map<string, RegisteredTool> {
  const registry = new Map<string, RegisteredTool>();
  for (const supplied of tools) {
    const tool = { ...supplied };
    if (!tool.name || registry.has(tool.name)) throw new Error(`Invalid or duplicate tool name: ${tool.name}`);
    if (tool.validate !== undefined && typeof tool.validate !== 'function')
      throw new Error(`Tool ${tool.name} requires a validate function`);
    if (tool.parallelSafe !== undefined && typeof tool.parallelSafe !== 'boolean')
      throw new Error(`Tool ${tool.name} requires a boolean parallelSafe`);
    const parameters = structuredClone(tool.parameters);
    registry.set(tool.name, { ...tool, parameters, validateSchema: compileParameters(parameters) });
  }
  return registry;
}

interface RegisteredTool extends Tool {
  validateSchema: (args: unknown) => void;
}

type Emit = (event: AgentEvent) => Promise<void>;

export function validateToolHooks(hooks: ToolHooks): void {
  for (const name of ['beforeToolCall', 'afterToolCall'] as const) {
    if (hooks[name] !== undefined && typeof hooks[name] !== 'function')
      throw new TypeError(`${name} must be a function`);
  }
}

function serialize(value: unknown): string {
  const result = JSON.stringify(value ?? null);
  if (typeof result !== 'string') throw new Error('Tool result is not JSON serializable');
  return result;
}

/** A single tool invocation. Never retries, and always yields a protocol-safe result. */
async function invokeTool(
  call: ToolCall,
  registry: Map<string, RegisteredTool>,
  signal: AbortSignal,
  emit: Emit,
  hooks: ToolHooks,
): Promise<{ result: string; hookError?: string }> {
  if (signal.aborted) return { result: toolError('Cancelled before execution') };
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
    const metadata = { id: call.id, name, args: structuredClone(args) };
    const { beforeToolCall, afterToolCall } = hooks;
    try {
      const decision = await beforeToolCall?.(structuredClone(metadata), { signal });
      if (signal.aborted) return { result: toolError('Cancelled before execution') };
      if (decision !== undefined) {
        const reason = decision?.reason;
        if (decision?.block !== true || (reason !== undefined && typeof reason !== 'string'))
          return { result: toolError('Invalid beforeToolCall decision') };
        return { result: toolError(reason || 'Tool execution blocked by beforeToolCall') };
      }
    } catch {
      return { result: toolError('beforeToolCall failed') };
    }
    await emit({ type: 'tool_start', name, id: call.id, args });
    if (signal.aborted) throw new Error('Cancelled before execution');
    let result: string;
    let outcome: AfterToolCallContext['outcome'] = 'returned';
    try {
      const value = await tool.execute(args, { signal });
      outcome = 'serialization_error';
      result = serialize(value);
      outcome = 'returned';
    } catch (error) {
      if (outcome === 'returned') outcome = 'threw';
      result = toolError(errorText(error));
    }
    try {
      const replacement = await afterToolCall?.({ ...metadata, result: JSON.parse(result), outcome }, { signal });
      if (replacement !== undefined) {
        if (!replacement || !Object.hasOwn(replacement, 'result')) throw new Error('Invalid afterToolCall result');
        result = serialize(replacement.result);
      }
      return { result };
    } catch {
      // Execution already settled. Preserve its result; do not invent a failed/absent effect.
      return { result, hookError: 'afterToolCall failed' };
    }
  } catch (error) {
    return { result: toolError(errorText(error)) };
  }
}

/** Internal execution boundary. No model calls, retries, or detached work. */
export async function executeToolCalls(
  calls: readonly ToolCall[],
  registry: Map<string, RegisteredTool>,
  signal: AbortSignal,
  observer: Emit,
  maxConcurrency = 1,
  suppliedHooks: ToolHooks = {},
): Promise<string[]> {
  validateToolConcurrency(maxConcurrency);
  const hooks = { ...suppliedHooks };
  validateToolHooks(hooks);
  const results: string[] = new Array(calls.length);
  // Serialize observers so existing consumers need not handle concurrent callbacks.
  let delivery = Promise.resolve();
  const emit: Emit = (event) => {
    delivery = delivery.then(async () => {
      try {
        await observer(structuredClone(event));
      } catch {
        /* Observation cannot own execution. */
      }
    });
    return delivery;
  };
  const run = async (index: number) => {
    const call = calls[index] as ToolCall;
    const finalized = await invokeTool(call, registry, signal, emit, hooks);
    results[index] = finalized.result;
    await emit({ type: 'tool_end', name: call.function.name, id: call.id, ...finalized });
  };
  let next = 0;
  while (next < calls.length) {
    const start = next;
    if (registry.get((calls[next] as ToolCall).function.name)?.parallelSafe !== true || signal.aborted) {
      await run(next++);
      continue;
    }
    // A serial tool is a barrier: drain the preceding group before invoking it.
    while (next < calls.length && registry.get((calls[next] as ToolCall).function.name)?.parallelSafe === true) next++;
    const end = next;
    let cursor = start;
    await Promise.all(
      Array.from({ length: Math.min(maxConcurrency, end - start) }, async () => {
        while (cursor < end && !signal.aborted) await run(cursor++);
      }),
    );
    // Never execute pending calls after abort; still preserve every protocol pairing.
    while (cursor < end) await run(cursor++);
  }
  await delivery;
  return results;
}
