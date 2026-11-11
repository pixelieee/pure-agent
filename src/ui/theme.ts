import type { MarkdownTheme } from '@earendil-works/pi-tui';

// The terminal owns the canvas and body color. One restrained accent marks input;
// ANSI dim keeps secondary information subordinate on both dark and light themes.
const paint =
  (code: string, reset = '0') =>
  (text: string) =>
    'NO_COLOR' in process.env || process.env.TERM === 'dumb' ? text : `\x1b[${code}m${text}\x1b[${reset}m`;
const plain = (text: string) => text;
const accent = paint('38;2;166;179;155', '39');
export const deco = {
  blue: accent,
  purple: accent,
  text: plain,
  muted: paint('2', '22'),
  red: paint('31', '39'),
  bold: paint('1', '22'),
  band: paint('1', '22'),
  selected: paint('7', '27'),
};
export const markdownTheme: MarkdownTheme = {
  heading: deco.bold,
  link: paint('4', '24'),
  linkUrl: deco.muted,
  code: plain,
  codeBlock: plain,
  codeBlockBorder: deco.muted,
  quote: plain,
  quoteBorder: deco.muted,
  hr: deco.muted,
  listBullet: deco.muted,
  bold: deco.bold,
  italic: paint('3', '23'),
  strikethrough: paint('9', '29'),
  underline: paint('4', '24'),
};
