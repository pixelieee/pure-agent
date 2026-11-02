import test from 'node:test';
import assert from 'node:assert/strict';
import { formatToolDetails } from '../src/ui/tool-details.ts';

test('tool detail projection pretty prints generic JSON and decodes string results safely', () => {
  assert.equal(formatToolDetails('{"ok":true,"count":2}'), '{\n  "ok": true,\n  "count": 2\n}');
  assert.equal(formatToolDetails(JSON.stringify('line one\nline two\x1b[2J')), 'line one\nline two');
  assert.equal(formatToolDetails('plain output'), 'plain output');
});

test('tool detail limits affect display only and do not split graphemes', () => {
  const input = JSON.stringify('👨‍👩‍👧‍👦'.repeat(4000));
  const output = formatToolDetails(input);
  const body = output.split('\n[display truncated; model result unchanged]')[0];
  assert.ok(body.length <= 24_000);
  assert.equal(body.replaceAll('👨‍👩‍👧‍👦', ''), '');
  assert.match(output, /display truncated; model result unchanged/);
  assert.equal(JSON.parse(input).length, 44000);
});
