/** Explicit manual live check. Sends only allowlisted project documents to OpenAI. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { createOpenAIModel } from '../src/providers/openai.ts';
import type { OpenAIUsage } from '../src/providers/openai.ts';
import { createProjectAgent, PROJECT_SYSTEM } from '../src/project-agent.ts';
import { SessionController } from '../src/ui/controller.ts';
import { TerminalView } from '../src/ui/view.ts';

const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('Configure OPENAI_API_KEY before explicitly running this live check.');
const usages: OpenAIUsage[] = [];
const modelName = 'gpt-5.6-luna';
const model = createOpenAIModel({
  apiKey: key,
  model: modelName,
  reasoningEffort: 'low',
  maxCompletionTokens: 1024,
  onUsage: (usage) => {
    usages.push(usage);
  },
});
const view = new TerminalView(process.stdout);
const agent = createProjectAgent(model);
const controller = new SessionController(() => agent, view, {
  defaultSystem: PROJECT_SYSTEM,
  modeLabel: `${modelName} / low`,
});
const prompts = [
  '先读取 README.md 和 package.json。用不超过120字说明 Pure Agent 的定位、开发语言和两个入口。',
  '接着读取 docs/dependency-decisions.md。为什么用了 Ajv 却没用 wrap-ansi？结合上一轮的开发者定位，用不超过120字回答。',
  '读取 docs/live-test-baseline.json。结合前两轮，说明现有验证覆盖，以及还不能声称完成的两项能力。不要把离线通过说成生产验收，不超过150字。',
];
const results: unknown[] = [];
const input = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
process.on('SIGINT', () => controller.interrupt());
view.welcome(
  `LIVE PROJECT CHECK / ${modelName} / LOW\n3 real project questions · read-only allowlist · no synthetic answers`,
);
try {
  for (let i = 0; i < prompts.length; i++) {
    view.panel('STATUS', `ROUND ${i + 1} / 3`);
    const result = await controller.submit(prompts[i]);
    results.push({ prompt: prompts[i], result });
    if (result?.status !== 'completed') {
      process.exitCode = 1;
      break;
    }
    if (input && i < prompts.length - 1) await input.question('Press Enter for the next round...');
  }
} finally {
  input?.close();
  const total = usages.reduce(
    (a, u) => ({
      promptTokens: a.promptTokens + u.promptTokens,
      completionTokens: a.completionTokens + u.completionTokens,
      cachedTokens: a.cachedTokens + u.cachedTokens,
      reasoningTokens: a.reasoningTokens + u.reasoningTokens,
    }),
    { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
  );
  // Official standard token prices verified on 2026-11-02. This is an estimate, not a bill.
  const estimatedUSD =
    ((total.promptTokens - total.cachedTokens) * 0.2 + total.cachedTokens * 0.02 + total.completionTokens * 1.2) /
    1_000_000;
  const report = {
    ranAt: new Date().toISOString(),
    model: modelName,
    reasoning: 'low',
    rounds: results,
    requestCount: usages.length,
    usage: total,
    estimatedUSD,
    messages: agent.messages.map(({ providerData: _continuation, ...message }) => message),
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/live-project-check.json', JSON.stringify(report, null, 2) + '\n');
  view.panel(
    'STATUS',
    `Requests: ${usages.length} · input: ${total.promptTokens} · output: ${total.completionTokens}\nEstimated token cost: $${estimatedUSD.toFixed(6)} (not an invoice)`,
  );
}
