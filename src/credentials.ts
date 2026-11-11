import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseEnv } from 'node:util';

export class CredentialError extends Error {
  readonly code: 'ENV_FILE' | 'OPENAI_API_KEY_REQUIRED';
  constructor(code: 'ENV_FILE' | 'OPENAI_API_KEY_REQUIRED') {
    super(
      code === 'ENV_FILE'
        ? 'Could not read the explicit env file. Use a UTF-8 regular file no larger than 64 KiB.'
        : 'OPENAI_API_KEY is required. Set it in the process environment or an explicit --credentials-file. Never put the key in command arguments or logs.',
    );
    this.name = 'CredentialError';
    this.code = code;
  }
}

/** Read credentials only. Never discover files, mutate process.env, or export other env-file values. */
export async function resolveOpenAIKey(env: Readonly<{ OPENAI_API_KEY?: string }>, path?: string): Promise<string> {
  let fileKey: string | undefined;
  if (path !== undefined) {
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 65536) throw new Error();
        const buffer = Buffer.alloc(65537);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > 65536) throw new Error();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
        fileKey = parseEnv(text).OPENAI_API_KEY;
      } finally {
        await handle.close();
      }
    } catch {
      // Do not echo paths, parser errors, file contents, or credential values.
      throw new CredentialError('ENV_FILE');
    }
  }
  // An explicitly empty environment variable must not silently select another credential.
  const key = (env.OPENAI_API_KEY ?? fileKey)?.trim();
  if (!key) throw new CredentialError('OPENAI_API_KEY_REQUIRED');
  return key;
}
