import type { MarkdownTheme } from '@earendil-works/pi-tui';

// Ordinary text follows the terminal theme. Only accents and paired bands use
// fixed colors, so light and dark terminals retain a readable foreground.
const paint =
  (code: string, reset = '0') =>
  (text: string) =>
    'NO_COLOR' in process.env || process.env.TERM === 'dumb' ? text : `\x1b[${code}m${text}\x1b[${reset}m`;
const plain = (text: string) => text;
export const deco = {
  blue: paint('38;2;101;125;165', '39'),
  purple: paint('38;2;136;116;159', '39'),
  text: plain,
  muted: plain,
  red: paint('31', '39'),
  bold: paint('1', '22'),
  band: paint('38;2;229;231;237;48;2;29;38;58'),
  selected: paint('38;2;238;241;248;48;2;48;67;101'),
};
export const markdownTheme: MarkdownTheme = {
  heading: deco.bold,
  link: paint('4', '24'),
  linkUrl: plain,
  code: plain,
  codeBlock: plain,
  codeBlockBorder: plain,
  quote: plain,
  quoteBorder: deco.purple,
  hr: plain,
  listBullet: deco.purple,
  bold: deco.bold,
  italic: paint('3', '23'),
  strikethrough: paint('9', '29'),
  underline: paint('4', '24'),
};
