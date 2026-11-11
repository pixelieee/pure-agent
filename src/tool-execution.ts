import type { AgentEvent, Tool, ToolCall } from './core.ts';
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

/** Internal execution boundary. No model calls, retries, or detached work. */
export async function executeToolCalls(
  calls: readonly ToolCall[],
  registry: Map<string, RegisteredTool>,
  signal: AbortSignal,
  observer: Emit,
  maxConcurrency = 1,
): Promise<string[]> {
  validateToolConcurrency(maxConcurrency);
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
    const result = await invokeTool(call, registry, signal, emit);
    results[index] = result;
    await emit({ type: 'tool_end', name: call.function.name, id: call.id, result });
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
