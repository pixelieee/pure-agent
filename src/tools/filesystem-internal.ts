import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import picomatch from 'picomatch';

export interface FileToolsOptions {
  /** Absolute workspace directory. These checks are not a shell or OS sandbox. */
  root: string;
  /** Maximum content bytes in one result (default 50 KiB). */
  maxReadBytes?: number;
  /** Maximum lines in one read result (default 2000). */
  maxReadLines?: number;
  /** Maximum bytes in an edit/write or one searched file (default 32 MiB). Reads stream independently. */
  maxFileBytes?: number;
  /** Maximum search/list records in one page (default 1000). */
  maxResults?: number;
  /** Maximum directory entries visited by one search/list (default 50000). */
  maxTraversalEntries?: number;
  /** Maximum recursive directory depth (default 64). */
  maxDepth?: number;
  /** Deadline per invocation, including regex execution (default 15000 ms). */
  timeoutMs?: number;
  /** Extra gitignore-style discovery rules. Direct reads/writes are unaffected. */
  ignore?: readonly string[];
  /** Override credential exclusions for every operation. [] disables them. */
  exclude?: readonly string[];
  /** Read workspace and nested .gitignore/.ignore files (default true). */
  respectGitignore?: boolean;
}

export interface FileLimits {
  maxReadBytes: number;
  maxReadLines: number;
  maxFileBytes: number;
  maxResults: number;
  maxTraversalEntries: number;
  maxDepth: number;
  timeoutMs: number;
}

const DEFAULT_EXCLUSIONS = [
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.sample',
  '!.env.template',
  '.ssh/',
  '.aws/credentials',
  '.npmrc',
  '.netrc',
  'id_rsa',
  'id_ed25519',
];
const DEFAULT_IGNORES = ['.git/', 'node_modules/'];
const posix = (path: string) => path.split(sep).join('/');
export const hashContent = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');
export const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;

export function globMatcher(pattern: string): (path: string) => boolean {
  const match = picomatch(pattern, { dot: true });
  return (path) => match(pattern.includes('/') ? path : basename(path));
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 2 ** 31 - 1) {
    throw new Error(`${name} must be a positive safe integer no greater than 2147483647`);
  }
  return result;
}

interface IgnoreLayer {
  base: string;
  rules: Ignore;
}
export interface WalkEntry {
  path: string;
  relativePath: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
}
export interface WalkResult {
  entries: WalkEntry[];
  truncated: boolean;
  reasons: string[];
  visited: number;
}

/** Canonical-root checks limit accidental access. Hostile filesystem races need OS isolation. */
export class FileWorkspace {
  readonly limits: FileLimits;
  readonly root: string;
  readonly #excluded: Ignore;
  readonly #ignored: Ignore;
  readonly #respectGitignore: boolean;
  readonly #queues = new Map<string, Promise<void>>();
  #canonicalRoot?: Promise<string>;

  constructor(options: FileToolsOptions) {
    if (!options || typeof options.root !== 'string' || !isAbsolute(options.root) || options.root.includes('\0')) {
      throw new Error('File tools require an absolute workspace root');
    }
    for (const list of [options.ignore, options.exclude]) {
      if (list !== undefined && (!Array.isArray(list) || !list.every((item) => typeof item === 'string'))) {
        throw new Error('ignore and exclude must be arrays of gitignore-style strings');
      }
    }
    if (options.respectGitignore !== undefined && typeof options.respectGitignore !== 'boolean') {
      throw new Error('respectGitignore must be a boolean');
    }
    this.root = resolve(options.root);
    this.limits = {
      maxReadBytes: positive(options.maxReadBytes, 50 * 1024, 'maxReadBytes'),
      maxReadLines: positive(options.maxReadLines, 2000, 'maxReadLines'),
      maxFileBytes: positive(options.maxFileBytes, 32 * 1024 * 1024, 'maxFileBytes'),
      maxResults: positive(options.maxResults, 1000, 'maxResults'),
      maxTraversalEntries: positive(options.maxTraversalEntries, 50000, 'maxTraversalEntries'),
      maxDepth: positive(options.maxDepth, 64, 'maxDepth'),
      timeoutMs: positive(options.timeoutMs, 15000, 'timeoutMs'),
    };
    this.#excluded = ignore().add([...(options.exclude ?? DEFAULT_EXCLUSIONS)]);
    this.#ignored = ignore({ ignorecase: process.platform === 'win32' }).add([
      ...DEFAULT_IGNORES,
      ...(options.ignore ?? []),
    ]);
    this.#respectGitignore = options.respectGitignore ?? true;
  }

  canonicalRoot(): Promise<string> {
    this.#canonicalRoot ??= realpath(this.root).then(async (root) => {
      if (!(await lstat(root)).isDirectory()) throw new Error('Workspace root must be a directory');
      return root;
    });
    return this.#canonicalRoot;
  }

  #assertContained(root: string, target: string): void {
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('Path is outside the workspace root');
    }
  }

  #assertAllowed(root: string, target: string, directory = false): void {
    const rel = posix(relative(root, target));
    if (rel && this.#excluded.ignores(`${rel}${directory ? '/' : ''}`)) {
      throw new Error(`Path is excluded by filesystem policy: ${rel}`);
    }
  }

  async resolvePath(input: string, signal: AbortSignal, allowMissing = false): Promise<string> {
    signal.throwIfAborted();
    if (typeof input !== 'string' || !input || input.includes('\0')) throw new Error('A nonempty path is required');
    const root = await this.canonicalRoot();
    const lexical = isAbsolute(input) ? resolve(input) : resolve(root, input);
    // A host-selected symlink root also accepts absolute paths through its original spelling.
    let target = lexical;
    if (isAbsolute(input)) {
      const fromOriginal = relative(this.root, lexical);
      if (fromOriginal !== '..' && !fromOriginal.startsWith(`..${sep}`) && !isAbsolute(fromOriginal)) {
        target = resolve(root, fromOriginal);
      }
    }
    this.#assertContained(root, target);
    this.#assertAllowed(root, target);
    const parts = relative(root, target).split(sep).filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      signal.throwIfAborted();
      current = join(current, parts[i]);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) current = await realpath(current);
        this.#assertContained(root, current);
        this.#assertAllowed(root, current, info.isDirectory());
        if (i < parts.length - 1 && !(await lstat(current)).isDirectory()) {
          throw new Error(`Path component is not a directory: ${parts[i]}`);
        }
      } catch (error) {
        if (!allowMissing || !isCode(error, 'ENOENT')) throw error;
        // A dangling symlink is not a missing file and must never be replaced implicitly.
        try {
          if ((await lstat(current)).isSymbolicLink()) throw new Error('Dangling symlinks are not supported');
        } catch (missing) {
          if (!isCode(missing, 'ENOENT')) throw missing;
        }
        current = resolve(current, ...parts.slice(i + 1));
        this.#assertContained(root, current);
        this.#assertAllowed(root, current);
        return current;
      }
    }
    signal.throwIfAborted();
    return current;
  }

  async displayPath(path: string): Promise<string> {
    return posix(relative(await this.canonicalRoot(), path)) || '.';
  }

  async openFile(path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Path is not a regular file');
      signal.throwIfAborted();
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async readBytes(path: string, signal: AbortSignal, maxBytes = this.limits.maxFileBytes): Promise<Buffer> {
    const handle = await this.openFile(path, signal);
    try {
      if ((await handle.stat()).size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte operation limit`);
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        signal.throwIfAborted();
        const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size));
        const { bytesRead } = await handle.read(buffer);
        if (!bytesRead) return Buffer.concat(chunks, size);
        size += bytesRead;
        if (size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte operation limit`);
        chunks.push(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
  }

  decode(bytes: Buffer): string {
    if (bytes.includes(0)) throw new Error('Binary files are not supported by this UTF-8 text tool');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error('File is not valid UTF-8 text');
    }
  }

  async mutate<T>(input: string, signal: AbortSignal, run: (path: string) => Promise<T>): Promise<T> {
    const key = await this.resolvePath(input, signal, true);
    const prior = this.#queues.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = prior.then(() => current);
    this.#queues.set(key, queue);
    try {
      await prior;
      signal.throwIfAborted();
      const resolved = await this.resolvePath(input, signal, true);
      if (resolved !== key) throw new Error('File target changed while waiting to write; retry after reading it');
      return await run(resolved);
    } finally {
      release();
      if (this.#queues.get(key) === queue) this.#queues.delete(key);
    }
  }

  async atomicWrite(path: string, bytes: Buffer, signal: AbortSignal, original?: Buffer): Promise<void> {
    if (bytes.length > this.limits.maxFileBytes) {
      throw new Error(`Content exceeds the ${this.limits.maxFileBytes}-byte operation limit`);
    }
    signal.throwIfAborted();
    await mkdir(dirname(path), { recursive: true });
    if ((await this.resolvePath(path, signal, true)) !== path) throw new Error('File target changed before write');
    let mode = 0o666;
    let existing = false;
    try {
      const info = await lstat(path);
      if (!info.isFile()) throw new Error('Write target is not a regular file');
      mode = info.mode & 0o777;
      existing = true;
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    }
    const temporary = join(dirname(path), `.pure-agent-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    let renamed = false;
    try {
      if (existing) await handle.chmod(mode);
      await handle.writeFile(bytes, { signal });
      await handle.sync();
      await handle.close();
      signal.throwIfAborted();
      if ((await this.resolvePath(path, signal, true)) !== path) throw new Error('File target changed during write');
      if (original && !(await this.readBytes(path, signal)).equals(original)) {
        throw new Error('File changed since it was read; write cancelled to avoid losing changes');
      }
      signal.throwIfAborted();
      await rename(temporary, path);
      renamed = true;
      // Commit is complete. Do not report cancellation after a successful replacement.
    } finally {
      await handle.close().catch(() => {});
      if (!renamed) await unlink(temporary).catch(() => {});
    }
  }

  async #layers(directory: string, inherited: IgnoreLayer[], signal: AbortSignal): Promise<IgnoreLayer[]> {
    if (!this.#respectGitignore) return inherited;
    const layers = [...inherited];
    for (const name of ['.gitignore', '.ignore']) {
      const file = join(directory, name);
      try {
        // Ignore configuration is ordinary data, not a reason to follow a symlink outside the root.
        const path = await this.resolvePath(file, signal);
        const bytes = await this.readBytes(path, signal, 256 * 1024);
        layers.push({
          base: directory,
          rules: ignore({ ignorecase: process.platform === 'win32' }).add(this.decode(bytes)),
        });
      } catch (error) {
        if (!isCode(error, 'ENOENT')) throw error;
      }
    }
    return layers;
  }

  async walk(start: string, signal: AbortSignal, recursive = true): Promise<WalkResult> {
    const root = await this.canonicalRoot();
    const output: WalkResult = { entries: [], truncated: false, reasons: [], visited: 0 };
    let ancestors: IgnoreLayer[] = [];
    let ancestor = root;
    for (const part of relative(root, start).split(sep).filter(Boolean)) {
      ancestors = await this.#layers(ancestor, ancestors, signal);
      ancestor = join(ancestor, part);
    }
    const stack: { directory: string; layers: IgnoreLayer[]; depth: number }[] = [
      { directory: start, layers: ancestors, depth: 0 },
    ];
    while (stack.length) {
      signal.throwIfAborted();
      const item = stack.pop();
      if (!item) break;
      const layers = await this.#layers(item.directory, item.layers, signal);
      const directory = await opendir(item.directory);
      const children: WalkEntry[] = [];
      for await (const entry of directory) {
        signal.throwIfAborted();
        if (output.visited >= this.limits.maxTraversalEntries) {
          output.truncated = true;
          output.reasons.push('traversal entry limit reached; narrow path or increase maxTraversalEntries');
          break;
        }
        output.visited++;
        const path = join(item.directory, entry.name);
        const directorySuffix = entry.isDirectory() ? '/' : '';
        const fromRoot = posix(relative(root, path)) + directorySuffix;
        if (this.#excluded.ignores(fromRoot) || this.#ignored.ignores(fromRoot)) continue;
        let ignored = false;
        for (const layer of layers) {
          const result = layer.rules.test(posix(relative(layer.base, path)) + directorySuffix);
          if (result.ignored) ignored = true;
          if (result.unignored) ignored = false;
        }
        if (ignored) continue;
        children.push({
          path,
          relativePath: posix(relative(start, path)),
          type: entry.isDirectory()
            ? 'directory'
            : entry.isFile()
              ? 'file'
              : entry.isSymbolicLink()
                ? 'symlink'
                : 'other',
        });
      }
      children.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
      output.entries.push(...children);
      if (output.visited >= this.limits.maxTraversalEntries && output.truncated) break;
      if (recursive) {
        for (const child of children.toReversed()) {
          if (child.type !== 'directory') continue;
          if (item.depth >= this.limits.maxDepth) {
            output.truncated = true;
            if (!output.reasons.includes('maximum traversal depth reached')) {
              output.reasons.push('maximum traversal depth reached');
            }
            continue;
          }
          // Never descend symlinks. Explicit operations may resolve contained symlinks.
          stack.push({ directory: child.path, layers, depth: item.depth + 1 });
        }
      }
    }
    output.entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
    return output;
  }
}
