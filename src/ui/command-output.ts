import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { safeText } from './view.ts';
import { deco } from './theme.ts';

const names = new Set(['exec_command', 'start_process', 'read_process', 'kill_process']);
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A display projection of supplied evidence, never a process read or execution. */
export function commandOutput(name: string, source: string | undefined) {
  if (!names.has(name) || source === undefined) return undefined;
  try {
    const value = JSON.parse(source);
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.output !== 'string' ||
      !['running', 'exited', 'failed', 'terminated'].includes(value.status) ||
      (value.exitCode !== null && !Number.isSafeInteger(value.exitCode))
    )
      return undefined;
    return value as {
      output: string;
      status: string;
      exitCode: number | null;
      [key: string]: unknown;
    };
  } catch {
    return undefined;
  }
}

function bounded(text: string, limit: number): string {
  const safe = safeText(text);
  if (safe.length <= limit) return safe;
  let result = '';
  for (const { segment } of segmenter.segment(safe)) {
    if (result.length + segment.length > limit) break;
    result += segment;
  }
  return `${result}\n[display truncated; raw result unchanged]`;
}

export function renderCommandOutput(
  result: NonNullable<ReturnType<typeof commandOutput>>,
  width: number,
  expanded: boolean,
): string[] {
  const inset = width >= 16 ? 2 : 0;
  const inner = Math.max(1, width - inset - 2);
  const rows: string[] = [];
  const add = (text: string, accent = false) => {
    const body = new Text(text, 0, 0).render(inner);
    for (const line of body)
      rows.push(
        truncateToWidth(`${' '.repeat(inset)}${deco.blue('│')} ${accent ? deco.purple(line) : line}`, width, ''),
      );
  };
  add(`${result.status} · exit ${result.exitCode ?? 'unavailable'}`, true);
  for (const [key, label] of [
    ['signal', 'signal'],
    ['terminationReason', 'termination'],
    ['error', 'error'],
    ['cleanupWarning', 'cleanup warning'],
  ]) {
    if (typeof result[key] === 'string' && result[key]) add(`${label}: ${bounded(result[key], 240)}`);
  }
  if (result.truncated === true) add('[output truncated by tool]');
  if (Number.isSafeInteger(result.omittedBytes) && (result.omittedBytes as number) > 0)
    add(`[${result.omittedBytes} bytes omitted from retained tail]`);
  if (Number.isSafeInteger(result.nextCursor) && (result.nextCursor as number) >= 0)
    add(`cursor ${result.nextCursor} · more output: ${result.hasMore === true ? 'yes' : 'no'}`);
  add('stdout + stderr (combined)', true);
  const output = new Text(bounded(result.output || '(no output)', expanded ? 24_000 : 2000), 0, 0).render(inner);
  const visible = expanded ? output : output.slice(0, 6);
  for (const line of visible) rows.push(truncateToWidth(`${' '.repeat(inset)}${deco.blue('│')} ${line}`, width, ''));
  if (!expanded && output.length > visible.length) add('[preview clipped · Ctrl+O details]');
  if (typeof result.logPath === 'string')
    add(`log (${result.logComplete === true ? 'complete' : 'incomplete'}): ${bounded(result.logPath, 240)}`);
  return rows;
}
