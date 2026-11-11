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

function bounded(text: string, limit: number, tail = false): string {
  const safe = safeText(text);
  if (safe.length <= limit) return safe;
  const notice = '[display truncated; raw result unchanged]';
  if (tail) {
    for (const { index } of segmenter.segment(safe)) {
      if (safe.length - index <= limit) return `${notice}\n${safe.slice(index)}`;
    }
    return notice;
  }
  let result = '';
  for (const { segment } of segmenter.segment(safe)) {
    if (result.length + segment.length > limit) break;
    result += segment;
  }
  return `${result}\n${notice}`;
}

export function renderCommandOutput(
  result: NonNullable<ReturnType<typeof commandOutput>>,
  width: number,
  expanded: boolean,
  showStatus = true,
): string[] {
  const inset = width >= 16 ? 4 : 0;
  const inner = Math.max(1, width - inset - 2);
  const rows: string[] = [];
  const add = (text: string, accent = false) => {
    const body = new Text(text, 0, 0).render(inner);
    for (const line of body)
      rows.push(
        truncateToWidth(`${' '.repeat(inset)}${deco.muted('│')} ${accent ? deco.muted(line) : line}`, width, ''),
      );
  };
  if (showStatus) add(`${result.status} · exit ${result.exitCode ?? 'unavailable'}`, true);
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
  const failure =
    result.status === 'failed' || result.status === 'terminated' || (result.exitCode !== null && result.exitCode !== 0);
  const source = result.output || '(no output)';
  const characterClipped = !expanded && safeText(source).length > 2000;
  const output = new Text(bounded(source, expanded ? 24_000 : 2000, !expanded && !failure), 0, 0).render(inner);
  const clipped = !expanded && (output.length > (failure ? 14 : 8) || characterClipped);
  const tail = failure && characterClipped ? new Text(bounded(source, 2000, true), 0, 0).render(inner) : output;
  const visible = !clipped
    ? output
    : failure
      ? [...output.slice(0, 10), deco.muted('[preview clipped · Ctrl+O details]'), ...tail.slice(-3)]
      : output.slice(-8);
  for (const line of visible) rows.push(truncateToWidth(`${' '.repeat(inset)}${deco.muted('│')} ${line}`, width, ''));
  if (clipped && !failure) add('[preview clipped · showing tail · Ctrl+O details]', true);
  if (expanded) {
    add('stdout + stderr (combined)', true);
    if (typeof result.logPath === 'string')
      add(`log (${result.logComplete === true ? 'complete' : 'incomplete'}): ${bounded(result.logPath, 240)}`, true);
  } else {
    add(
      `stdout + stderr (combined)${typeof result.logPath === 'string' ? ` · log (${result.logComplete === true ? 'complete' : 'incomplete'})` : ''}`,
      true,
    );
  }
  return rows;
}
