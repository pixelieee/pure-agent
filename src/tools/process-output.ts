import type { FileHandle } from 'node:fs/promises';

/** Raw-byte cursor over a bounded tail. Logs preserve bytes; previews decode UTF-8. */
export class ProcessOutput {
  private tail = Buffer.alloc(0);
  totalBytes = 0;
  stdoutBytes = 0;
  stderrBytes = 0;
  logBytes = 0;
  private reservedLogBytes = 0;
  logComplete = true;
  private writes: Promise<void> = Promise.resolve();
  private failed = false;
  private closed = false;

  private readonly file: FileHandle;
  private readonly maxBytes: number;
  private readonly maxLogBytes: number;
  private readonly onFailure: (reason: 'output_limit' | 'log_error', error?: unknown) => void;

  constructor(
    file: FileHandle,
    maxBytes: number,
    maxLogBytes: number,
    onFailure: (reason: 'output_limit' | 'log_error', error?: unknown) => void,
  ) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.maxLogBytes = maxLogBytes;
    this.onFailure = onFailure;
  }

  /** Backpressure is applied by the caller to BOTH streams until this write settles. */
  append(chunk: Buffer, stream: 'stdout' | 'stderr'): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.totalBytes += chunk.length;
    if (stream === 'stdout') this.stdoutBytes += chunk.length;
    else this.stderrBytes += chunk.length;
    const keep = Math.min(this.maxBytes, chunk.length);
    this.tail =
      chunk.length >= this.maxBytes
        ? Buffer.from(chunk.subarray(chunk.length - keep))
        : Buffer.concat([this.tail.subarray(Math.max(0, this.tail.length + chunk.length - this.maxBytes)), chunk]);
    const remaining = this.maxLogBytes - this.reservedLogBytes;
    const part = chunk.subarray(0, Math.max(0, remaining));
    this.reservedLogBytes += part.length;
    if (part.length < chunk.length && this.logComplete) {
      this.logComplete = false;
      this.onFailure('output_limit');
    }
    this.writes = this.writes.then(async () => {
      if (this.failed) return;
      try {
        let offset = 0;
        while (offset < part.length) {
          const { bytesWritten } = await this.file.write(part, offset, part.length - offset);
          if (!bytesWritten) throw new Error('Process log write made no progress');
          offset += bytesWritten;
          this.logBytes += bytesWritten;
        }
      } catch (error) {
        this.failed = true;
        this.logComplete = false;
        this.onFailure('log_error', error);
      }
    });
    return this.writes;
  }

  read(cursor: number, maxBytes: number, finished: boolean) {
    const availableFrom = this.totalBytes - this.tail.length;
    let start = Math.max(cursor, availableFrom);
    // Do not introduce replacement characters solely because the ring starts mid-codepoint.
    while (start < this.totalBytes && (this.tail[start - availableFrom] & 0xc0) === 0x80) start++;
    let size = 0;
    let outputBytes = 0;
    let output = '';
    while (start + size < this.totalBytes) {
      const offset = start + size - availableFrom;
      const first = this.tail[offset];
      let length =
        first < 0x80
          ? 1
          : first >= 0xc2 && first <= 0xdf
            ? 2
            : first >= 0xe0 && first <= 0xef
              ? 3
              : first >= 0xf0 && first <= 0xf4
                ? 4
                : 0;
      const available = this.tail.length - offset;
      let valid = length > 0;
      for (let i = 1; valid && i < Math.min(length, available); i++) {
        const byte = this.tail[offset + i];
        valid = (byte & 0xc0) === 0x80;
        if (i === 1)
          valid &&=
            !(first === 0xe0 && byte < 0xa0) &&
            !(first === 0xed && byte >= 0xa0) &&
            !(first === 0xf0 && byte < 0x90) &&
            !(first === 0xf4 && byte >= 0x90);
      }
      if (valid && available < length && !finished) break;
      let decoded: string;
      if (valid && available >= length) decoded = this.tail.subarray(offset, offset + length).toString('utf8');
      else {
        decoded = '\uFFFD';
        length = 1;
      }
      const bytes = Buffer.byteLength(decoded);
      if (outputBytes + bytes > maxBytes) break;
      output += decoded;
      outputBytes += bytes;
      size += length;
    }
    return {
      output,
      cursor: start,
      nextCursor: start + size,
      omittedBytes: start - cursor,
      hasMore: start + size < this.totalBytes,
    };
  }

  snapshot(finished: boolean) {
    const result = this.read(Math.max(0, this.totalBytes - this.maxBytes), this.maxBytes, finished);
    return { output: result.output, truncated: result.cursor > 0 || result.hasMore };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writes;
    await this.file.close().catch((error: unknown) => {
      this.logComplete = false;
      this.onFailure('log_error', error);
    });
  }
}
