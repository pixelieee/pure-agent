import { safeText } from './view.ts';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const DISPLAY_LIMIT = 24_000;

/** Display-only projection. Never modifies the evidence delivered to the model. */
export function formatToolDetails(source: string): string {
  let formatted = source;
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value === 'string') formatted = value;
    else if (value && typeof value === 'object' && 'path' in value && typeof value.path === 'string'
      && 'content' in value && typeof value.content === 'string') {
      formatted = `${value.path}\n${value.content}${'truncated' in value && value.truncated === true ? '\n[file content truncated by tool]' : ''}`;
    } else formatted = JSON.stringify(value, null, 2);
  } catch { /* Raw non-JSON tool output is already useful text. */ }
  // JSON decoding can turn escaped ANSI/control characters back into executable bytes.
  const safe = safeText(formatted);
  if (safe.length <= DISPLAY_LIMIT) return safe;
  let bounded = '';
  for (const { segment } of segmenter.segment(safe)) {
    if (bounded.length + segment.length > DISPLAY_LIMIT) break;
    bounded += segment;
  }
  return `${bounded}\n[display truncated; model result unchanged]`;
}
