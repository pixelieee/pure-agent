import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Ajv } from 'ajv';
import { DEVELOPER_SYSTEM } from './developer-agent.ts';

/** Session settings only: credentials, endpoints and capabilities are not configurable. */
export interface AgentConfig {
  readonly system: string;
  readonly model: string;
  readonly reasoning: 'low' | 'medium';
  readonly maxSteps: number;
  readonly maxOutputTokens: number;
}
export const DEFAULT_CONFIG: Readonly<AgentConfig> = Object.freeze({
  system: DEVELOPER_SYSTEM,
  model: 'gpt-5.6-luna',
  reasoning: 'low',
  maxSteps: 64,
  maxOutputTokens: 4096,
});
const fields = ['system', 'model', 'reasoning', 'maxSteps', 'maxOutputTokens'];
const validate = new Ajv({ strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false }).compile({
  type: 'object',
  additionalProperties: false,
  properties: {
    system: { type: 'string', minLength: 1, maxLength: 16000, pattern: '\\S' },
    model: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' },
    reasoning: { type: 'string', enum: ['low', 'medium'] },
    maxSteps: { type: 'integer', minimum: 1, maximum: 1000 },
    maxOutputTokens: { type: 'integer', minimum: 1, maximum: 65536 },
  },
});
export class ConfigError extends Error {
  readonly code: string;
  readonly location: string;
  constructor(code: string, location = '/') {
    super(`Configuration error: ${code} at ${location}.`);
    this.name = 'ConfigError';
    this.code = code;
    this.location = location;
  }
}
/** Never render Ajv errors, unknown property names, file paths or JSON parser messages. */
function checked(value: unknown): Readonly<Partial<AgentConfig>> {
  // JSON cannot contain undefined, but direct TypeScript callers can. Do not let
  // an explicitly undefined optional property overwrite a required default.
  if (value && typeof value === 'object') {
    for (const field of fields) {
      if (Object.hasOwn(value, field) && (value as Record<string, unknown>)[field] === undefined) {
        throw new ConfigError('CONFIG_SCHEMA', `/${field}`);
      }
    }
  }
  if (!validate(value)) {
    const error = validate.errors?.[0];
    const location = error && fields.some((field) => error.instancePath === `/${field}`) ? error.instancePath : '/';
    throw new ConfigError('CONFIG_SCHEMA', location);
  }
  return Object.freeze({ ...(value as Partial<AgentConfig>) });
}
/** Explicit path only; bounded reads also keep accidental large inputs inexpensive. */
export async function loadConfig(path: string): Promise<Readonly<Partial<AgentConfig>>> {
  let text: string;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536) throw new ConfigError('CONFIG_FILE');
      const buffer = Buffer.alloc(65537);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 65536) throw new ConfigError('CONFIG_FILE');
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } finally {
      await handle.close();
    }
  } catch {
    throw new ConfigError('CONFIG_FILE');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError('CONFIG_JSON');
  }
  return checked(parsed);
}
/** Resolve once before creating the controller; /new reuses this immutable snapshot. */
export function resolveConfig(
  config: Readonly<Partial<AgentConfig>> = {},
  overrides: Readonly<Partial<AgentConfig>> = {},
): Readonly<AgentConfig> {
  checked(config);
  checked(overrides);
  return Object.freeze({ ...DEFAULT_CONFIG, ...config, ...overrides });
}
