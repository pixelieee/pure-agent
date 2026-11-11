import type { AgentEvent, RunResult } from '../core.ts';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { deco } from './theme.ts';

export interface Output {
  write(text: string): unknown;
  isTTY?: boolean;
  columns?: number;
}
export function safeText(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return stripVTControlCharacters(text).replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal control characters from untrusted display text.
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    '',
  );
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Preserve original code points for copying developer-facing output. wrap-ansi
 * normalizes NFD to NFC, so layout uses native segmentation and string-width
 * instead; neither Unicode segmentation nor cell-width rules are hand-written.
 */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of safeText(text).split('\n')) {
    let line = '';
    let used = 0;
    for (const { segment } of segmenter.segment(paragraph)) {
      const size = stringWidth(segment);
      if (line && used + size > width) {
        lines.push(line);
        line = '';
        used = 0;
      }
      line += segment;
      used += size;
    }
    lines.push(line);
  }
  return lines;
}

export type PanelKind = 'USER' | 'AGENT' | 'TOOL' | 'STATUS' | 'ERROR';
export interface SessionView {
  panel(kind: PanelKind, content: unknown): void;
  event(event: AgentEvent, modeLabel?: string): void;
  finish(result: RunResult): void;
  /** Optional interactive status, separate from append-only transcript content. */
  setStatus?(status: string): void;
  /** End interrupted rendering after a thrown run error, without inventing a RunResult. */
  runError?(error: string): void;
  /** Display a recorded tool call and result without presenting them as live execution. */
  historyTool?(name: string, args: string, result: string): void;
  reset?(): void;
}

function preview(text: string): string {
  // Sanitize before clipping so a partial terminal escape cannot escape the display boundary.
  const safe = safeText(text);
  if (safe.length <= 600) return safe;
  let bounded = '';
  for (const { segment } of segmenter.segment(safe)) {
    if (bounded.length + segment.length > 600) break;
    bounded += segment;
  }
  return `${bounded}\n[... truncated display only]`;
}
const processResultTools = new Set(['exec_command', 'start_process', 'read_process', 'kill_process']);

/** Project the supplied result only. Never read logs, rerun a command, or change retained evidence. */
function resultPreview(name: string, source: string): string {
  if (!processResultTools.has(name)) return preview(source);
  try {
    const result = JSON.parse(source);
    if (
      !result ||
      typeof result !== 'object' ||
      typeof result.output !== 'string' ||
      !['running', 'exited', 'failed', 'terminated'].includes(result.status) ||
      (result.exitCode !== null && !Number.isSafeInteger(result.exitCode))
    )
      return preview(source);
    const lines = [
      `Status: ${result.status}; exit code: ${result.exitCode ?? 'unavailable'}`,
      `Output:\n${preview(result.output)}`,
    ];
    if (result.truncated === true) lines.push('[process output truncated by tool]');
    if (Number.isSafeInteger(result.omittedBytes) && result.omittedBytes > 0)
      lines.push(`[${result.omittedBytes} output bytes omitted from retained tail]`);
    if (Number.isSafeInteger(result.nextCursor) && result.nextCursor >= 0)
      lines.push(`Next cursor: ${result.nextCursor}; more output: ${result.hasMore === true ? 'yes' : 'no'}`);
    for (const [key, label] of [
      ['id', 'Process'],
      ['signal', 'Signal'],
      ['terminationReason', 'Termination'],
      ['error', 'Error'],
      ['cleanupWarning', 'Cleanup warning'],
    ]) {
      if (typeof result[key] === 'string' && result[key]) lines.push(`${label}: ${preview(result[key])}`);
    }
    if (typeof result.logPath === 'string')
      lines.push(`Log (${result.logComplete === true ? 'complete' : 'incomplete'}): ${preview(result.logPath)}`);
    return lines.join('\n');
  } catch {
    return preview(source);
  }
}

/** Append-only rendering avoids cursor races, hidden history, and redraw flicker. */
export class TerminalView implements SessionView {
  private output: Output;
  private color: boolean;
  constructor(output: Output, color = !!output.isTTY && process.env.TERM !== 'dumb' && !('NO_COLOR' in process.env)) {
    this.output = output;
    this.color = color;
  }
  panel(kind: 'USER' | 'AGENT' | 'TOOL' | 'STATUS' | 'ERROR', content: unknown) {
    const width = Math.max(12, Math.min(this.output.columns ?? 80, 96));
    const text = safeText(content);
    if (!this.color || width < 40) {
      this.output.write(`[${kind}] ${text}\n`);
      return;
    }
    const marker = kind === 'USER' ? '› ' : kind === 'ERROR' ? '! ' : '';
    const lines = wrapText(text, Math.max(1, width - stringWidth(marker)));
    for (const [index, line] of lines.entries()) {
      const prefix = index === 0 ? marker : ' '.repeat(stringWidth(marker));
      const body = `${prefix}${line}`;
      this.output.write(
        `${kind === 'USER' ? deco.band(body + ' '.repeat(Math.max(0, width - stringWidth(body)))) : body}\n`,
      );
    }
  }
  historyTool(name: string, args: string, result: string) {
    this.panel('TOOL', `Recorded: ${name}\nArguments (raw): ${args}\nResult: ${resultPreview(name, result)}`);
  }
  event(event: AgentEvent, modeLabel?: string) {
    if (event.type === 'model_start') this.panel('STATUS', `${modeLabel ? `${modeLabel} · ` : ''}model step`);
    if (event.type === 'assistant' && event.text) this.panel('AGENT', event.text);
    if (event.type === 'tool_start') this.panel('TOOL', `→ ${event.name}\nArguments: ${JSON.stringify(event.args)}`);
    if (event.type === 'tool_end')
      this.panel('TOOL', `← ${event.name}\nResult: ${resultPreview(event.name, event.result)}`);
  }
  finish(result: RunResult) {
    this.panel(
      result.error ? 'ERROR' : 'STATUS',
      `${result.status} · ${result.steps} model step(s)${result.error ? ` · ${result.error}` : ''}`,
    );
  }
  welcome(note = '') {
    this.panel(
      'STATUS',
      `pure agent${note ? `\n${note}` : ''}\n/help for commands · Ctrl+C cancels; when idle, exits.`,
    );
  }
}
