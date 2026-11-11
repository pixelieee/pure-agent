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
    this.panel(
      'TOOL',
      `Recorded: ${name}\nArguments (raw): ${args}\nResult: ${result.length > 600 ? `${result.slice(0, 600)}\n[... truncated display only]` : result}`,
    );
  }
  event(event: AgentEvent, modeLabel?: string) {
    if (event.type === 'model_start') this.panel('STATUS', `${modeLabel ? `${modeLabel} · ` : ''}model step`);
    if (event.type === 'assistant' && event.text) this.panel('AGENT', event.text);
    if (event.type === 'tool_start') this.panel('TOOL', `→ ${event.name}\nArguments: ${JSON.stringify(event.args)}`);
    if (event.type === 'tool_end')
      this.panel(
        'TOOL',
        `← ${event.name}\nResult: ${event.result.length > 600 ? `${event.result.slice(0, 600)}\n[... truncated display only]` : event.result}`,
      );
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
