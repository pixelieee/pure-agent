import { types } from 'node:util';

// Reject lossy/non-data structures before cloning, reading fields, or encoding JSON.
export function assertPlainData(
  value: unknown,
  fail: (code: string) => never,
  ancestors = new Set<object>(),
  depth = 0,
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return;
  if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value) || depth > 128)
    fail('INVALID');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('INVALID');
  const keys = Reflect.ownKeys(value).filter((key) => !(array && key === 'length'));
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) fail('INVALID');
  ancestors.add(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) fail('INVALID');
    assertPlainData(descriptor.value, fail, ancestors, depth + 1);
  }
  ancestors.delete(value);
}
