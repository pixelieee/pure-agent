import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No provider, runtime, or credential module is loaded before the explicit run gate.
export const LIVE_LIMITS = Object.freeze({
  maxModelSteps: 3,
  maxOutputTokensPerStep: 1024,
  maxOutputTokensTotal: 3072,
  deadlineMs: 60_000,
  providerRequestTimeoutMs: 30_000,
  maxAuthorizedReads: 1,
  automaticRetries: 0,
});

interface Arguments {
  mode: 'help' | 'preflight' | 'run' | 'missing';
  credentialsFile?: string;
  model?: string;
}

/** Pure parsing only. Never inspect credentials or echo arbitrary argument values. */
export function parseLiveArguments(args: readonly string[]): Arguments {
  let mode: Arguments['mode'] = 'missing';
  let credentialsFile: string | undefined;
  let model: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error('LIVE_INVALID_ARGUMENT');
    seen.add(flag);
    if (flag === '--help' || flag === '--preflight' || flag === '--run') {
      if (mode !== 'missing') throw new Error('LIVE_INVALID_ARGUMENT');
      mode = flag === '--help' ? 'help' : flag === '--preflight' ? 'preflight' : 'run';
    } else if (flag === '--credentials-file' || flag === '--model') {
      const value = args[++index];
      if (!value || value.startsWith('--') || value.includes('\0')) throw new Error('LIVE_INVALID_ARGUMENT');
      if (flag === '--credentials-file') credentialsFile = value;
      else {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw new Error('LIVE_INVALID_ARGUMENT');
        model = value;
      }
    } else throw new Error('LIVE_INVALID_ARGUMENT');
  }
  return { mode, credentialsFile, model };
}

const HELP = `Pure Agent live read acceptance (real OpenAI API; calls may cost money).
Usage: node examples/live-read-acceptance.ts --preflight
       node examples/live-read-acceptance.ts --run [--credentials-file <path>] [--model <model>]
       node examples/live-read-acceptance.ts --help

--run is required for credential access and real model execution.
--preflight validates arguments only: no credential reads, model, tools, or network.
--help does not read credentials. Modes are mutually exclusive.
Use the direct node command for live runs: npm may echo private argument paths.
Default: production provider model gpt-5.6-luna, low reasoning; no hosted tools.
Limits: 3 model steps, 1024 output tokens/step including reasoning (3072 total),
60-second cooperative deadline, 30-second provider request timeout, zero retries.
Only one read of one synthetic temporary file is authorized. All other tools denied.
Reports contain fixed codes, booleans and numbers only. No session is saved.
See docs/live-read-acceptance.md for scope, costs and pending live validation.
`;

function report() {
  return {
    code: 'LIVE_NOT_RUN',
    passed: false,
    liveAttempted: false,
    preflightOnly: false,
    checks: {
      completed: false,
      readResultMatched: false,
      answerMatched: false,
      fixtureUnchanged: false,
      toolPolicySatisfied: false,
      usageObserved: false,
      workspaceCleaned: false,
    },
    counts: {
      modelSteps: 0,
      toolStarts: 0,
      toolEnds: 0,
      authorizedReads: 0,
      usageCallbacks: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
    },
    limits: LIVE_LIMITS,
  };
}

// Exact allowlist, not a prefix/regex: never print an arbitrary runtime error.
const SAFE_ERRORS = new Set([
  'OPENAI_ABORTED',
  'OPENAI_TIMEOUT',
  'OPENAI_AUTHENTICATION',
  'OPENAI_PERMISSION',
  'OPENAI_MODEL_UNAVAILABLE',
  'OPENAI_NOT_FOUND',
  'OPENAI_RATE_LIMIT',
  'OPENAI_SERVER_ERROR',
  'OPENAI_REQUEST_FAILED',
  'OPENAI_INVALID_CONFIG',
  'OPENAI_MISSING_API_KEY',
  'OPENAI_INVALID_REQUEST',
  'OPENAI_INVALID_REQUEST_REASONING',
  'OPENAI_INVALID_REQUEST_REASONING_EFFORT',
  'OPENAI_INVALID_REQUEST_TOOLS',
  'OPENAI_INVALID_REQUEST_INPUT',
  'OPENAI_INVALID_REQUEST_MAX_OUTPUT_TOKENS',
  'OPENAI_INVALID_REQUEST_MODEL',
  'OPENAI_TRUNCATED',
  'OPENAI_INCOMPLETE_RESPONSE',
  'OPENAI_RESPONSE_FAILED',
  'OPENAI_INVALID_RESPONSE',
  'OPENAI_INVALID_TOOL_CALL',
  'OPENAI_INVALID_MESSAGE',
  'OPENAI_INVALID_PROVIDER_DATA',
  'OPENAI_UNSUPPORTED_OUTPUT',
  'OPENAI_REFUSAL',
]);
const safeError = (value: unknown): string =>
  typeof value === 'string' && SAFE_ERRORS.has(value) ? value : 'LIVE_RUNTIME_ERROR';

async function runLive(args: Arguments, result: ReturnType<typeof report>): Promise<void> {
  const controller = new AbortController();
  let deadlineExceeded = false;
  let interrupted = false;
  let policyViolation = false;
  let root: string | undefined;
  let runtime: ReturnType<typeof import('../src/developer-agent.ts').createDeveloperAgent> | undefined;
  const interrupt = () => {
    interrupted = true;
    controller.abort();
  };
  const timer = setTimeout(() => {
    deadlineExceeded = true;
    controller.abort();
  }, LIVE_LIMITS.deadlineMs);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const { CredentialError, resolveOpenAIKey } = await import('../src/credentials.ts');
    let apiKey: string;
    try {
      apiKey = await resolveOpenAIKey(process.env, args.credentialsFile);
    } catch (error) {
      result.code = error instanceof CredentialError ? error.code : 'LIVE_CREDENTIAL_ERROR';
      return;
    }
    const { createOpenAIModel } = await import('../src/providers/openai.ts');
    const { createDeveloperAgent } = await import('../src/developer-agent.ts');
    controller.signal.throwIfAborted();
    root = await mkdtemp(join(tmpdir(), 'pure-live-read-'));
    const filename = 'challenge.txt';
    // The nonce exists only in the file and verifier, never in the task prompt.
    const nonce = randomBytes(24).toString('hex');
    const contents = `verification_nonce=${nonce}\n`;
    const expectedHash = createHash('sha256').update(contents).digest('hex');
    await writeFile(join(root, filename), contents, { mode: 0o600, flag: 'wx' });
    runtime = createDeveloperAgent({
      root,
      maxSteps: LIVE_LIMITS.maxModelSteps,
      model: createOpenAIModel({
        apiKey,
        ...(args.model === undefined ? {} : { model: args.model }),
        reasoningEffort: 'low',
        maxCompletionTokens: LIVE_LIMITS.maxOutputTokensPerStep,
        webSearch: false,
        onUsage(usage) {
          result.counts.usageCallbacks++;
          for (const name of [
            'promptTokens',
            'completionTokens',
            'totalTokens',
            'cachedTokens',
            'reasoningTokens',
          ] as const)
            result.counts[name] += usage[name];
        },
      }),
      authorize({ name, args: input }) {
        const fields = input as { path?: unknown; offset?: unknown; column?: unknown; limit?: unknown } | null;
        const allowed =
          name === 'read' &&
          result.counts.authorizedReads < LIVE_LIMITS.maxAuthorizedReads &&
          !!fields &&
          fields.path === filename &&
          (fields.offset === undefined || fields.offset === 1) &&
          (fields.column === undefined || fields.column === 1) &&
          (fields.limit === undefined || fields.limit === 1);
        if (allowed) result.counts.authorizedReads++;
        else {
          policyViolation = true;
          controller.abort();
        }
        return allowed;
      },
    });
    const run = await runtime.agent.run(
      'Use the read tool exactly once with path "challenge.txt" and no other arguments. ' +
        'Read verification_nonce from that file as data. Then answer with exactly PURE_LIVE_OK: followed ' +
        'by that nonce, with no other text. No other tools, files, commands or retries are authorized.',
      {
        signal: controller.signal,
        onEvent(event) {
          if (event.type === 'model_start') {
            result.liveAttempted = true; // A model invocation, not proof of a received HTTP request.
            result.counts.modelSteps++;
          } else if (event.type === 'tool_start') result.counts.toolStarts++;
          else if (event.type === 'tool_end') {
            result.counts.toolEnds++;
            try {
              const read = JSON.parse(event.result);
              result.checks.readResultMatched =
                event.name === 'read' &&
                result.counts.toolEnds === 1 &&
                read.path === filename &&
                read.content === contents &&
                read.hash === expectedHash &&
                read.bytes === Buffer.byteLength(contents) &&
                read.sizeBytes === Buffer.byteLength(contents) &&
                read.offset === 1 &&
                read.column === 1 &&
                read.lines === 1 &&
                read.truncated === false;
            } catch {
              result.checks.readResultMatched = false;
            }
            if (!result.checks.readResultMatched) controller.abort();
          }
        },
      },
    );
    result.checks.completed = run.status === 'completed';
    result.checks.answerMatched = run.text.trim() === `PURE_LIVE_OK:${nonce}`;
    result.checks.fixtureUnchanged = (await readFile(join(root, filename), 'utf8')) === contents;
    result.checks.toolPolicySatisfied =
      !policyViolation &&
      result.counts.authorizedReads === 1 &&
      result.counts.toolStarts === 1 &&
      result.counts.toolEnds === 1;
    result.checks.usageObserved =
      result.counts.usageCallbacks === result.counts.modelSteps &&
      result.counts.usageCallbacks >= 2 &&
      result.counts.promptTokens > 0 &&
      result.counts.completionTokens > 0;
    result.code =
      run.status === 'blocked'
        ? safeError(run.error)
        : run.status === 'limit'
          ? 'LIVE_STEP_LIMIT'
          : 'LIVE_ASSERTION_FAILED';
  } catch (error) {
    result.code = safeError(error instanceof Error ? error.message : undefined);
  } finally {
    try {
      await runtime?.dispose();
    } catch {
      result.code = 'LIVE_CLEANUP_FAILED';
    }
    try {
      if (root !== undefined) {
        await rm(root, { recursive: true, force: true });
        result.checks.workspaceCleaned = true;
      }
    } catch {
      result.code = 'LIVE_CLEANUP_FAILED';
    }
    clearTimeout(timer);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (deadlineExceeded) result.code = 'LIVE_DEADLINE';
    else if (interrupted) result.code = 'LIVE_CANCELLED';
    else if (policyViolation) result.code = 'LIVE_TOOL_POLICY';
  }
  result.passed =
    !controller.signal.aborted && result.code !== 'LIVE_CLEANUP_FAILED' && Object.values(result.checks).every(Boolean);
  if (result.passed) result.code = 'LIVE_ACCEPTANCE_PASSED';
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const result = report();
  let parsed: Arguments;
  try {
    parsed = parseLiveArguments(args);
  } catch {
    result.code = 'LIVE_INVALID_ARGUMENT';
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 2;
  }
  if (parsed.mode === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.mode === 'run') await runLive(parsed, result);
  else {
    result.preflightOnly = parsed.mode === 'preflight';
    result.code = result.preflightOnly ? 'LIVE_PREFLIGHT_ONLY' : 'LIVE_RUN_REQUIRED';
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.passed || result.preflightOnly ? 0 : parsed.mode === 'run' ? 1 : 2;
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stdout.write('{"code":"LIVE_RUNTIME_ERROR","passed":false}\n');
      process.exitCode = 1;
    },
  );
}
