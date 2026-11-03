#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createOpenAIModel } from './providers/openai.ts';
import type { OpenAIModelOptions } from './providers/openai.ts';
import type { Model, Tool, AgentSnapshot } from './core.ts';
import { connectMcpTools, loadMcpConfig, type McpConnection } from './extensions/mcp.ts';
import { createWebFetchTool } from './extensions/web.ts';
import { createDeveloperAgent, DEVELOPER_SYSTEM } from './developer-agent.ts';
import { createSessionStore, SessionError, type SessionStore } from './session.ts';
import { ConfigError, loadConfig, resolveConfig } from './config.ts';
import { SessionController, interactive, type SessionPersistence, type SessionRuntime } from './ui/controller.ts';
import { TerminalView, safeText } from './ui/view.ts';
import { PureAgentTUI } from './ui/tui.ts';

const HELP = `Pure Agent — developer SDK + terminal agent

Usage:
  pure-agent --openai --cwd ./project --trust-workspace
  pure-agent --openai --cwd ./project --read-only --prompt "Explain this project"
  pure-agent --openai --trust-workspace --session ./private/session.json
  pure-agent --openai --read-only --resume ./private/session.json

Uses the live OpenAI provider. --openai is an optional compatibility flag.
--cwd <directory>        Workspace (default current directory; never changes host cwd)
--trust-workspace        Allow file changes and commands with full host privileges
--read-only              Deny tool writes/commands; explicitly enabled web reads allowed
--config <path>          Explicit JSON settings (live mode only; no discovery)
--model <id>             Live model (default gpt-5.6-luna)
--reasoning <low|medium>  Live reasoning effort (default low)
--max-steps <1..1000>     Model/tool loop limit (default 64)
--max-output-tokens <1..65536>  Per-model output limit (default 4096)
--session <file>         Create or load, then save after each turn
--resume <file>          Require an existing session, then save after each turn
--web-search             Enable hosted OpenAI web search (queries sent to search service)
--web-fetch              Enable public-page fetch (URLs sent to public websites)
--mcp-config <path>      Explicit MCP {servers:[...]} JSON; requires --trust-workspace
--prompt <text>          Run once; omit for interactive or piped lines

Live mode reads OPENAI_API_KEY from the process environment only.
Files are workspace-contained. Commands are NOT sandboxed: they can access
outside the workspace with your host privileges. Only trust projects you trust.
Noninteractive/piped use requires --trust-workspace or --read-only.
Session paths are relative to --cwd and contain private conversation/project data.
/new and /create detach saved files; /save [file] and /resume <file> manage history.
/create changes instructions, never permissions. /help lists tools and commands.
MCP server connections last until exit; /new does not reset external server state.
`;
export interface CLIOptions {
  env?: { OPENAI_API_KEY?: string };
  /** Explicit host injection for offline tests; never loaded from a project or session. */
  modelFactory?: (options: OpenAIModelOptions) => Model;
  projectRoot?: string;
  onUsage?: OpenAIModelOptions['onUsage'];
}

/** Only called with real interactive stdin/stdout, before entering the alternate screen. */
async function askWorkspaceTrust(root: string): Promise<'trusted' | 'read-only' | 'cancelled'> {
  process.stdout.write(
    `Workspace: ${safeText(root)}\nTrust permits file changes and commands with your full host privileges.\nCommands can read or modify outside this workspace. This is NOT a sandbox.\nType "trust" to enable, or press Enter for read-only: `,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await new Promise<'trusted' | 'read-only' | 'cancelled'>((resolveAnswer) => {
      rl.once('line', (line) => resolveAnswer(line.trim().toLowerCase() === 'trust' ? 'trusted' : 'read-only'));
      rl.once('close', () => resolveAnswer('cancelled'));
      rl.once('SIGINT', () => {
        resolveAnswer('cancelled');
        rl.close();
      });
    });
  } finally {
    rl.close();
  }
}

const hasCode = (error: unknown, code: string) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === code;
function sessionError(error: unknown): Error {
  return new Error(
    error instanceof SessionError
      ? error.message
      : hasCode(error, 'ENOENT')
        ? 'Session file not found.'
        : 'Session could not be loaded or saved. Check its format, permissions and current configuration.',
  );
}

/** Saved user instructions may vary; the current mandatory host policy must remain exact. */
function savedInstructions(snapshot: AgentSnapshot): string {
  const system = snapshot.messages[0];
  if (system?.role !== 'system' || typeof system.content !== 'string')
    throw new Error('Session host instructions are incompatible.');
  if (system.content === DEVELOPER_SYSTEM) return DEVELOPER_SYSTEM;
  const prefix = `${DEVELOPER_SYSTEM}\n\nUser instructions:\n`;
  if (!system.content.startsWith(prefix) || !system.content.slice(prefix.length).trim())
    throw new Error('Session host instructions are incompatible.');
  return system.content.slice(prefix.length);
}

export async function main(args = process.argv.slice(2), options: CLIOptions = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  let trusted = false;
  let readOnly = false;
  let webSearch = false;
  let webFetch = false;
  let mcpConfig: string | undefined;
  let prompt: string | undefined;
  let model: string | undefined;
  let reasoning: 'low' | 'medium' | undefined;
  let configPath: string | undefined;
  let cwd: string | undefined;
  let sessionPath: string | undefined;
  let requireSession = false;
  let maxSteps: number | undefined;
  let maxOutputTokens: number | undefined;
  const invalid = () => {
    process.stderr.write('Invalid argument. Use --help for usage.\n');
    return 2;
  };
  const valueFlags = [
    '--prompt',
    '--model',
    '--reasoning',
    '--config',
    '--cwd',
    '--session',
    '--resume',
    '--max-steps',
    '--max-output-tokens',
    '--mcp-config',
  ];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--openai') continue;
    else if (flag === '--web-search' || flag === '--web-fetch') {
      webSearch ||= flag === '--web-search';
      webFetch ||= flag === '--web-fetch';
    } else if (flag === '--trust-workspace' || flag === '--read-only') {
      trusted ||= flag === '--trust-workspace';
      readOnly ||= flag === '--read-only';
    } else if (valueFlags.includes(flag) && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) {
      const value = args[++i];
      if (!value.trim()) return invalid();
      if (flag === '--prompt') prompt = value;
      else {
        if (flag === '--config') configPath = value;
        else if (flag === '--mcp-config') mcpConfig = value;
        else if (flag === '--model') model = value;
        else if (flag === '--cwd') cwd = value;
        else if (flag === '--session' || flag === '--resume') {
          if (sessionPath !== undefined) return invalid();
          sessionPath = value;
          requireSession = flag === '--resume';
        } else if (flag === '--reasoning' && (value === 'low' || value === 'medium')) reasoning = value;
        else if ((flag === '--max-steps' || flag === '--max-output-tokens') && /^[1-9]\d*$/.test(value)) {
          if (flag === '--max-steps') maxSteps = Number(value);
          else maxOutputTokens = Number(value);
        } else return invalid();
      }
    } else return invalid();
  }
  if (trusted && readOnly) {
    process.stderr.write('Choose only one permission mode: --trust-workspace or --read-only.\n');
    return 2;
  }
  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig(configPath === undefined ? {} : await loadConfig(configPath), {
      ...(model === undefined ? {} : { model }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(maxSteps === undefined ? {} : { maxSteps }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof ConfigError ? error.message : 'Configuration error: CONFIG_INVALID at /.'}\n`,
    );
    return 2;
  }
  const interactiveTerminal = prompt === undefined && !!process.stdin.isTTY && !!process.stdout.isTTY;
  const useTui = interactiveTerminal && process.env.TERM !== 'dumb';
  let root = resolve(cwd ?? options.projectRoot ?? process.cwd());
  if (!(options.env ?? process.env).OPENAI_API_KEY?.trim()) {
    process.stderr.write('OPENAI_API_KEY is required for the live provider.\n');
    return 2;
  }
  try {
    root = await realpath(root);
    if (!(await stat(root)).isDirectory()) throw new Error();
  } catch {
    process.stderr.write('Workspace must be an accessible existing directory.\n');
    return 2;
  }
  if (!trusted && !readOnly) {
    if (!interactiveTerminal) {
      process.stderr.write(
        'Noninteractive live mode requires --trust-workspace or --read-only. Commands are not sandboxed.\n',
      );
      return 2;
    }
    const decision = await askWorkspaceTrust(root);
    if (decision === 'cancelled') return 130;
    trusted = decision === 'trusted';
    readOnly = !trusted;
  }
  if (mcpConfig && !trusted) {
    process.stderr.write(
      'MCP connections require --trust-workspace. Servers can execute code and access external systems.\n',
    );
    return 2;
  }
  const connections: McpConnection[] = [];
  const extensionTools: Tool[] = webFetch ? [createWebFetchTool()] : [];
  const closeExtensions = async () => {
    await Promise.all(connections.map((connection) => connection.close()));
  };
  if (mcpConfig) {
    const abort = new AbortController();
    const interrupt = () => abort.abort();
    process.on('SIGINT', interrupt);
    try {
      for (const server of await loadMcpConfig(mcpConfig)) {
        const connection = await connectMcpTools({ ...server, signal: abort.signal });
        connections.push(connection);
        extensionTools.push(...connection.tools);
      }
    } catch {
      await closeExtensions();
      process.stderr.write('MCP setup failed. Check the explicit server configuration and connection.\n');
      return abort.signal.aborted ? 130 : 2;
    } finally {
      process.off('SIGINT', interrupt);
    }
  }
  const readTools = new Set(['read', 'ls', 'find', 'grep', ...(webFetch ? ['web_fetch'] : [])]);
  const factory = (system: string): SessionRuntime => {
    const apiKey = (options.env ?? process.env).OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for the live provider.');
    return createDeveloperAgent({
      model: (options.modelFactory ?? createOpenAIModel)({
        apiKey,
        model: config.model,
        reasoningEffort: config.reasoning,
        maxCompletionTokens: config.maxOutputTokens,
        onUsage: options.onUsage,
        webSearch,
      }),
      system,
      root,
      maxSteps: config.maxSteps,
      tools: extensionTools,
      authorize: ({ name }) => trusted || readTools.has(name),
    });
  };
  let activeStore: SessionStore | undefined;
  const storeFor = (path: string) =>
    createSessionStore({
      path: resolve(root, path),
      identity: { provider: 'openai', model: config.model, workspaceRoot: root },
    });
  const persistence: SessionPersistence = {
    async save(agent, path, result) {
      const store = path ? (activeStore?.path === resolve(root, path) ? activeStore : storeFor(path)) : activeStore;
      if (!store) return undefined;
      try {
        await store.save(agent.snapshot(), result ? { status: result.status } : undefined);
      } catch (error) {
        throw sessionError(error);
      }
      activeStore = store;
      return store.path;
    },
    async load(path) {
      const store = storeFor(path);
      try {
        const record = await store.load();
        return {
          snapshot: record.snapshot,
          activate: () => {
            activeStore = store;
          },
        };
      } catch (error) {
        throw sessionError(error);
      }
    },
    reset() {
      activeStore = undefined;
    },
  };
  let initialSystem = config.system;
  let initialSnapshot: AgentSnapshot | undefined;
  if (sessionPath !== undefined) {
    try {
      const store = storeFor(sessionPath);
      try {
        const record = await store.load();
        initialSystem = savedInstructions(record.snapshot);
        initialSnapshot = record.snapshot;
      } catch (error) {
        if (requireSession || !hasCode(error, 'ENOENT')) throw error;
      }
      activeStore = store;
    } catch (error) {
      await closeExtensions();
      process.stderr.write(`${safeText(sessionError(error).message)}\n`);
      return 2;
    }
  }
  let initialSession: SessionRuntime | undefined;
  try {
    initialSession = factory(initialSystem);
    if (initialSnapshot) initialSession.agent.restore(initialSnapshot);
    else if (activeStore) await activeStore.save(initialSession.agent.snapshot());
  } catch {
    try {
      await initialSession?.dispose?.();
    } finally {
      await closeExtensions();
    }
    process.stderr.write('Could not initialize the agent or session. Check model, tools and saved configuration.\n');
    return 2;
  }
  const label = `OPENAI · ${trusted ? 'TRUSTED HOST' : 'READ-ONLY'}`;
  const capabilities = trusted
    ? 'Tools: read, write, edit, grep, find, ls, exec_command, start_process, process_status, read_process, kill_process, write_process.'
    : 'Allowed: read, grep, find, ls. Writes, commands and unclassified tools are denied.';
  const extensions = `${webSearch ? '\nHosted web search enabled: queries go to the search service.' : ''}${extensionTools.length ? `\nExtra tools: ${extensionTools.map((tool) => tool.name).join(', ')}.` : ''}${webFetch ? '\nPublic web fetch enabled: requested URLs go to public websites.' : ''}`;
  const note = `${label}\nWorkspace: ${root}\n${capabilities}${extensions}\n${trusted ? 'Commands have full host privileges. NOT a sandbox.' : 'Read-only filesystem access.'}\nReal API · max ${config.maxSteps} steps per run.${activeStore ? `\nSession: ${activeStore.path} · private conversation/project content` : ''}`;
  const view = useTui
    ? new PureAgentTUI({ modeLabel: label, note, workspace: root })
    : new TerminalView(process.stdout);
  const controller = new SessionController(factory, view, {
    initialSession,
    defaultSystem: config.system,
    modeLabel: label,
    persistence,
    resolveSavedInstructions: savedInstructions,
    helpNote: `Workspace: ${root}\n${label}\n${capabilities}${extensions}\nCommands are not sandboxed. Permissions cannot be changed through instructions or session files.`,
    configurationNote: 'Current tools and workspace permissions are unchanged. Previous session files are unchanged.',
  });
  if (view instanceof TerminalView) view.welcome(note);
  try {
    if (prompt !== undefined) {
      const interrupt = () => controller.interrupt();
      process.on('SIGINT', interrupt);
      try {
        await controller.submit(prompt);
      } finally {
        process.off('SIGINT', interrupt);
      }
    } else if (view instanceof PureAgentTUI) {
      view.attach(controller);
      await view.run();
    } else await interactive(controller, process.stdin, process.stdout);
    return controller.exitCode;
  } finally {
    try {
      await controller.dispose();
    } finally {
      await closeExtensions();
    }
  }
}
if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('The terminal session failed.\n');
      process.exitCode = 1;
    },
  );
}
