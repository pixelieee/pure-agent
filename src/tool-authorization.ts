import type { Tool } from './core.ts';
import type { DeveloperAgentOptions } from './developer-agent.ts';

async function authorized(decision: () => boolean | Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return new Promise<boolean>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error('Authorization cancelled'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    Promise.resolve()
      .then(decision)
      .then(
        (value) => {
          cleanup();
          resolve(value === true);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
  });
}

/** Internal boundary shared by every runtime tool, including application extensions. */
export function authorizeTool(tool: Tool, root: string, authorize?: DeveloperAgentOptions['authorize']): Tool {
  return {
    ...tool,
    async execute(args: unknown, context) {
      context.signal.throwIfAborted();
      if (
        authorize &&
        !(await authorized(
          () => authorize({ name: tool.name, args: structuredClone(args), workspaceRoot: root }, context),
          context.signal,
        ))
      ) {
        throw new Error(`Permission denied for ${tool.name}. The host must authorize this capability.`);
      }
      context.signal.throwIfAborted();
      return tool.execute(args, context);
    },
  };
}
