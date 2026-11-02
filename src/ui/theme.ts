import type { MarkdownTheme } from '@earendil-works/pi-tui';

const paint = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
export const deco = {
  amber: paint('38;2;226;177;91'),
  ivory: paint('38;2;237;229;209'),
  muted: paint('38;2;142;148;163'),
  red: paint('38;2;232;113;113'),
  bold: paint('1'),
  ink: paint('48;2;15;17;25'),
  selected: paint('38;2;15;17;25;48;2;226;177;91'),
};
export const markdownTheme: MarkdownTheme = {
  heading: (s) => deco.amber(deco.bold(s)),
  link: deco.ivory,
  linkUrl: deco.muted,
  code: deco.amber,
  codeBlock: deco.ivory,
  codeBlockBorder: deco.muted,
  quote: deco.muted,
  quoteBorder: deco.amber,
  hr: deco.muted,
  listBullet: deco.amber,
  bold: deco.bold,
  italic: paint('3'),
  strikethrough: paint('9'),
  underline: paint('4'),
};
