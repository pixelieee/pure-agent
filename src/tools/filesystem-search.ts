import { Worker } from 'node:worker_threads';

export interface SearchMatch {
  line: number;
  content: string;
  truncated: boolean;
  before?: { line: number; content: string }[];
  after?: { line: number; content: string }[];
}
interface SearchResponse {
  matches: SearchMatch[];
  total: number;
  error?: string;
}

// Run model-supplied regular expressions off the main event loop. A pathological
// expression must remain cancellable and must not freeze the interactive agent.
const SEARCH_WORKER = String.raw`
import { parentPort } from 'node:worker_threads';
parentPort.on('message', ({ text, pattern, literal, ignoreCase, context, skip, limit, lineBytes }) => {
  try {
    const regex = literal ? null : new RegExp(pattern, ignoreCase ? 'iu' : 'u');
    const needle = ignoreCase ? pattern.toLocaleLowerCase('en-US') : pattern;
    const lines = text.length ? text.split('\n') : [];
    if (text.endsWith('\n')) lines.pop();
    const clipped = (value) => {
      const line = value.endsWith('\r') ? value.slice(0, -1) : value;
      const bytes = Buffer.from(line);
      return bytes.length > lineBytes
        ? new TextDecoder().decode(bytes.subarray(0, lineBytes), { stream: true })
        : line;
    };
    let total = 0;
    const matches = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
      const found = regex ? regex.test(line) : (ignoreCase ? line.toLocaleLowerCase('en-US') : line).includes(needle);
      if (!found) continue;
      total++;
      if (total <= skip) continue;
      const match = { line: index + 1, content: clipped(line), truncated: Buffer.byteLength(line) > lineBytes };
      if (context) {
        match.before = lines.slice(Math.max(0, index - context), index).map((value, i) => ({ line: Math.max(0, index - context) + i + 1, content: clipped(value) }));
        match.after = lines.slice(index + 1, index + context + 1).map((value, i) => ({ line: index + i + 2, content: clipped(value) }));
      }
      matches.push(match);
      if (matches.length >= limit) break;
    }
    parentPort.postMessage({ matches, total });
  } catch (error) {
    parentPort.postMessage({ error: error.message, matches: [], total: 0 });
  }
});
`;

export class SearchWorker {
  // An explicit ESM URL avoids inheriting the caller's eval/stdin module mode.
  // Keep execArgv inherited so security, loader and diagnostic flags are preserved.
  readonly #worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(SEARCH_WORKER)}`), {
    resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 },
  });

  async search(
    text: string,
    options: {
      pattern: string;
      literal: boolean;
      ignoreCase: boolean;
      context: number;
      skip: number;
      limit: number;
      lineBytes: number;
    },
    signal: AbortSignal,
  ): Promise<SearchResponse> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', aborted);
        this.#worker.off('message', result);
        this.#worker.off('error', failed);
        this.#worker.off('exit', exited);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const exited = (code: number) => failed(new Error(`Search worker stopped unexpectedly (exit ${code})`));
      const aborted = () => failed(signal.reason instanceof Error ? signal.reason : new Error('Search cancelled'));
      const result = (value: SearchResponse) => {
        cleanup();
        if (value.error) reject(new Error(`Invalid search pattern: ${value.error}`));
        else resolve(value);
      };
      signal.addEventListener('abort', aborted, { once: true });
      this.#worker.once('message', result);
      this.#worker.once('error', failed);
      this.#worker.once('exit', exited);
      this.#worker.postMessage({ text, ...options });
    });
  }

  async close(): Promise<void> {
    await this.#worker.terminate();
  }
}
