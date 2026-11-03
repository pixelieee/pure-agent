import type { AutocompleteProvider } from '@earendil-works/pi-tui';

export const commands = [
  { value: '/help', label: '/help', description: 'Commands and keyboard shortcuts' },
  { value: '/new', label: '/new', description: 'Clear model history; restore default instructions' },
  { value: '/create', label: '/create', description: '<instructions> · replace instructions and clear history' },
  { value: '/save', label: '/save', description: '[file] · save private session history' },
  { value: '/resume', label: '/resume', description: '<file> · restore history with current permissions' },
  { value: '/quit', label: '/quit', description: 'Exit this session' },
];
/** Commands only: no implicit file enumeration, shell execution or home access. */
export const commandCompletion: AutocompleteProvider = {
  triggerCharacters: ['/'],
  async getSuggestions(lines, line, column) {
    const prefix = lines[line].slice(0, column);
    if (line !== 0 || !/^\/\w*$/.test(prefix)) return null;
    const items = commands.filter((item) => item.value.startsWith(prefix));
    return items.length ? { items, prefix } : null;
  },
  applyCompletion(lines, line, column, item, prefix) {
    const next = [...lines];
    const value = `${item.value} `;
    next[line] = next[line].slice(0, column - prefix.length) + value + next[line].slice(column);
    return { lines: next, cursorLine: line, cursorCol: column - prefix.length + value.length };
  },
};
