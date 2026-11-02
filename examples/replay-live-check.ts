/** Render a recorded real API run without spending tokens or fabricating responses. */
import { readFile } from 'node:fs/promises';
import type { Message, RunResult } from '../src/core.ts';
import { TerminalView } from '../src/ui/view.ts';
interface Report {
  ranAt: string; model: string; reasoning: string; requestCount: number; estimatedUSD: number;
  rounds: { prompt: string; result: RunResult }[]; messages: Message[];
}
const report = JSON.parse(await readFile('artifacts/live-project-check-headless.json', 'utf8')) as Report;
const round = Number(process.argv[2] ?? 1);
if (!Number.isInteger(round) || round < 1 || round > report.rounds.length) throw new Error('Choose a recorded round.');
const view = new TerminalView(process.stdout);
view.panel('STATUS', `PURE AGENT · 真实 API 调用记录回放\n${report.model} / ${report.reasoning} · ROUND ${round} / ${report.rounds.length}\nRecorded: ${report.ranAt}\n回放已完成的真实请求，不生成新回答，不发起新调用。`);
const starts = report.messages.map((m, i) => m.role === 'user' ? i : -1).filter(i => i >= 0);
for (const message of report.messages.slice(starts[round - 1], starts[round] ?? report.messages.length)) {
  if (message.role === 'user') view.panel('USER', message.content);
  if (message.role === 'assistant') {
    for (const call of message.tool_calls ?? []) view.panel('TOOL', `${call.function.name}\n${call.function.arguments}`);
    if (message.content) view.panel('AGENT', message.content);
  }
  if (message.role === 'tool') {
    const text = message.content ?? '';
    view.panel('TOOL', text.length > 220 ? text.slice(0, 220) + '\n[仅截短展示；实际模型收到完整工具结果]' : text);
  }
}
const result = report.rounds[round - 1].result;
view.panel('STATUS', `${result.status} · ${result.steps} model steps\n完整三轮：${report.requestCount} 次请求 · 估算 Token 费用 $${report.estimatedUSD.toFixed(6)}`);
