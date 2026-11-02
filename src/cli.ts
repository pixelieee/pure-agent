#!/usr/bin/env node
import { createDemoAgent, DEFAULT_SYSTEM } from './demo.ts';
import { createOpenAIModel } from './providers/openai.ts';
import type { OpenAIModelOptions } from './providers/openai.ts';
import type { Model } from './core.ts';
import { createProjectAgent } from './project-agent.ts';
import { ConfigError, loadConfig, resolveConfig } from './config.ts';
import { SessionController, interactive } from './ui/controller.ts';
import { TerminalView } from './ui/view.ts';
import { PureAgentTUI } from './ui/tui.ts';

const HELP = `Pure Agent — minimal SDK + dark deco terminal

Usage:
  npm run demo
  npm start -- --demo --prompt "Format this note"
  node --env-file=.env.local src/cli.ts --openai --reasoning low --prompt "请根据 README 介绍项目"
  node src/cli.ts --help

Choose exactly one: --demo (scripted fixture) or --openai (real API).
--config <path>    Explicit JSON settings file (live mode only; no discovery)
--model <id>       Live model (default gpt-5.6-luna)
--reasoning <low|medium>  Live reasoning effort (default low)
--prompt <text>    Run once; omit for interactive mode.
Live mode reads OPENAI_API_KEY from the process environment only.
Only four public project documents can be read, relative to the working directory.
/create configures instructions only; it does not generate tools or workflows.
`;
export interface CLIOptions {
  env?: { OPENAI_API_KEY?: string };
  modelFactory?: (options: OpenAIModelOptions) => Model;
  projectRoot?: string;
  onUsage?: OpenAIModelOptions['onUsage'];
}
export async function main(args = process.argv.slice(2), options: CLIOptions = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  let demo = false;
  let openai = false;
  let prompt: string | undefined;
  let model: string | undefined;
  let reasoning: 'low' | 'medium' | undefined;
  let configPath: string | undefined;
  let liveOptions = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--demo') demo = true;
    else if (args[i] === '--openai') openai = true;
    else if (
      ['--prompt', '--model', '--reasoning', '--config'].includes(args[i]) &&
      args[i + 1] !== undefined &&
      !args[i + 1].startsWith('--')
    ) {
      const flag = args[i];
      const value = args[++i];
      if (flag === '--prompt') prompt = value;
      else if (flag === '--config' && value.trim()) {
        configPath = value;
        liveOptions = true;
      } else if (flag === '--model' && value.trim()) {
        model = value;
        liveOptions = true;
      } else if (flag === '--reasoning' && (value === 'low' || value === 'medium')) {
        reasoning = value;
        liveOptions = true;
      } else {
        process.stderr.write('Invalid argument. Use --help for usage.\n');
        return 2;
      }
    } else {
      process.stderr.write('Invalid argument. Use --help for usage.\n');
      return 2;
    }
  }
  if (demo === openai || (demo && liveOptions)) {
    process.stderr.write(
      'Choose exactly one mode: --demo or --openai. Configuration, model and reasoning options require --openai.\n',
    );
    return 2;
  }

  let config;
  try {
    config = resolveConfig(configPath === undefined ? {} : await loadConfig(configPath), {
      ...(model === undefined ? {} : { model }),
      ...(reasoning === undefined ? {} : { reasoning }),
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof ConfigError ? error.message : 'Configuration error: CONFIG_INVALID at /.'}\n`,
    );
    return 2;
  }

  let factory: (system: string) => ReturnType<typeof createDemoAgent> = createDemoAgent;
  if (openai) {
    const apiKey = (options.env ?? process.env).OPENAI_API_KEY;
    if (!apiKey?.trim()) {
      process.stderr.write('OPENAI_API_KEY is required for --openai.\n');
      return 2;
    }
    factory = (system) =>
      createProjectAgent(
        (options.modelFactory ?? createOpenAIModel)({
          apiKey,
          model: config.model,
          reasoningEffort: config.reasoning,
          maxCompletionTokens: config.maxOutputTokens,
          onUsage: options.onUsage,
        }),
        system,
        options.projectRoot,
        { maxSteps: config.maxSteps },
      );
  }
  const label = 'OPENAI · live model';
  const note = openai
    ? `${label}\nReal API · read-only project evidence · max ${config.maxSteps} steps per run.`
    : 'DEMO ONLY · A real agent loop. A scripted model. No network or keys.';
  const useTui = prompt === undefined && !!process.stdin.isTTY && !!process.stdout.isTTY && process.env.TERM !== 'dumb';
  const view = useTui
    ? new PureAgentTUI({ modeLabel: openai ? label : 'DEMO · scripted fixture', note })
    : new TerminalView(process.stdout);
  const controller = new SessionController(factory, view, {
    defaultSystem: openai ? config.system : DEFAULT_SYSTEM,
    modeLabel: openai ? label : 'DEMO',
    helpNote: openai
      ? 'Live model with read_project_file only (four public project documents). No shell, network tool, or writes.'
      : 'Other text runs the DEMO note-formatting tool loop.\nDEMO does not interpret system instructions or natural-language intent.',
    configurationNote: openai
      ? 'Instructions only; tools remain fixed and read-only. No dynamic tool generation.'
      : 'DEMO remains scripted and does not interpret these instructions.',
  });
  if (view instanceof TerminalView) view.welcome(note);
  if (prompt !== undefined) {
    const interrupt = () => controller.interrupt();
    process.on('SIGINT', interrupt);
    try {
      const result = await controller.submit(prompt);
      return result?.status === 'cancelled' ? 130 : result && result.status !== 'completed' ? 1 : 0;
    } finally {
      process.off('SIGINT', interrupt);
    }
  }
  if (view instanceof PureAgentTUI) {
    view.attach(controller);
    await view.run();
  } else await interactive(controller, process.stdin, process.stdout);
  return 0;
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
