import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { types } from 'node:util';

/** Internal storage errors; public adapters sanitize all errors at their boundary. */
export class PrivateRecordError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
function fail(code: string): never {
  throw new PrivateRecordError(code);
}
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
export const recordCodeIs = (error: unknown, code: string) =>
  !!error &&
  typeof error === 'object' &&
  !types.isProxy(error) &&
  Object.getOwnPropertyDescriptor(error, 'code')?.value === code;

export interface PrivateRecordStore<Record, Fence, Transition> {
  readonly path: string;
  load(): Promise<Record>;
  create(record: Record): Promise<Record>;
  transition(fence: Fence, transition: Transition): Promise<Record>;
}
/** Linux private atomic replacement. Schema adapters must validate and detach inputs before awaiting I/O. */
export function createPrivateRecordStore<Record extends object, Fence, Transition>(
  options: { path: string; maxBytes?: number },
  schema: {
    validate(value: unknown): Record;
    initial(value: unknown): Record;
    reduce(value: Record, fence: Fence, transition: Transition): Record;
  },
): PrivateRecordStore<Record, Fence, Transition> {
  if (process.platform !== 'linux') return fail('PLATFORM');
  if (!options || typeof options.path !== 'string' || !isAbsolute(options.path) || options.path.includes('\0'))
    return fail('PATH');
  const path = resolve(options.path);
  const parent = dirname(path);
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!positive(maxBytes) || maxBytes > 256 * 1024 * 1024) return fail('SIZE');
  async function directory() {
    let part = parent;
    while (true) {
      const stat = await lstat(part);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return fail('UNSAFE_PATH');
      if (part === parent && ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()))
        return fail('PERMISSIONS');
      if (dirname(part) === part) break;
      part = dirname(part);
    }
    const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const before = await lstat(parent);
      const after = await handle.stat();
      if (before.ino !== after.ino || before.dev !== after.dev) return fail('UNSAFE_PATH');
      if ((after.mode & 0o777) !== 0o700 || after.uid !== process.getuid?.()) return fail('PERMISSIONS');
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async function read(): Promise<Record> {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return fail('UNSAFE_PATH');
    if ((before.mode & 0o777) !== 0o600 || before.uid !== process.getuid?.()) return fail('PERMISSIONS');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) return fail('UNSAFE_PATH');
      if (stat.size > maxBytes) return fail('SIZE');
      const bytes = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const result = await handle.read(bytes, size, bytes.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size !== stat.size) return fail('CORRUPT');
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
      } catch {
        return fail('CORRUPT');
      }
      return schema.validate(parsed);
    } finally {
      await handle.close();
    }
  }
  async function write(initial: Record | undefined, fence?: Fence, transition?: Transition): Promise<Record> {
    const dir = await directory();
    let locked = false;
    let temporary: string | undefined;
    let commitStarted = false;
    let result: Record | undefined;
    let failure: unknown;
    try {
      const lock = await open(
        `${path}.lock`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      ).catch((error: unknown) => {
        if (recordCodeIs(error, 'EEXIST')) return fail('LOCKED');
        throw error;
      });
      locked = true;
      try {
        await lock.chmod(0o600);
      } finally {
        await lock.close();
      }
      await dir.sync();
      let current: Record | undefined;
      try {
        current = await read();
      } catch (error) {
        if (!recordCodeIs(error, 'ENOENT')) throw error;
      }
      if (initial) {
        if (current) return fail('EXISTS');
        result = initial;
      } else {
        if (!current || !fence || !transition) return fail('CONFLICT');
        result = schema.reduce(current, fence, transition);
      }
      // Never publish a reducer result before the schema validates and detaches it.
      result = schema.validate(result);
      const body = `${JSON.stringify(result)}\n`;
      if (Buffer.byteLength(body) > maxBytes) return fail('SIZE');
      temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
      const file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.chmod(0o600);
        await file.writeFile(body, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      commitStarted = true;
      await rename(temporary, path);
      temporary = undefined;
      await dir.sync();
    } catch (error) {
      failure = error;
    }
    try {
      if (temporary) await unlink(temporary);
      if (locked) {
        await unlink(`${path}.lock`);
        await dir.sync();
      }
    } catch (error) {
      failure ??= error;
    }
    try {
      await dir.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure) {
      if (commitStarted) return fail('COMMIT_UNCERTAIN');
      throw failure;
    }
    return schema.validate(result);
  }
  return {
    path,
    load: async () => {
      const dir = await directory();
      try {
        return await read();
      } finally {
        await dir.close();
      }
    },
    create: async (value) => write(schema.initial(value)),
    transition: (fence, transition) => write(undefined, fence, transition),
  };
}
