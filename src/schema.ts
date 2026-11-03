import { Ajv, MissingRefError, type Options, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_NODES = 10_000;
const MAX_CACHED_VALIDATORS = 32;
const validators = new Map<string, (args: unknown) => void>();
const dialects = {
  'draft-07': 'http://json-schema.org/draft-07/schema#',
  '2019-09': 'https://json-schema.org/draft/2019-09/schema',
  '2020-12': 'https://json-schema.org/draft/2020-12/schema',
} as const;
type Dialect = keyof typeof dialects;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Copy only bounded JSON data, before Ajv traverses or generates code for it. */
function snapshot(parameters: Record<string, unknown>): Record<string, Json> {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function countText(value: string): void {
    bytes += Buffer.byteLength(value);
    if (bytes > MAX_SCHEMA_BYTES) throw new Error(`Tool parameter schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  }
  function copy(value: unknown, depth: number): Json {
    if (++nodes > MAX_SCHEMA_NODES) throw new Error(`Tool parameter schema exceeds ${MAX_SCHEMA_NODES} nodes`);
    if (depth > MAX_SCHEMA_DEPTH) throw new Error(`Tool parameter schema exceeds depth ${MAX_SCHEMA_DEPTH}`);
    if (typeof value === 'string') {
      countText(value);
      return value;
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
      return value;
    if (typeof value !== 'object') throw new Error('Tool parameter schemas must contain only JSON values');
    if (ancestors.has(value)) throw new Error('Tool parameter schemas must not contain cyclic objects; use $ref');
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null)
      throw new Error('Tool parameter schemas must contain only plain JSON objects');
    ancestors.add(value);
    const keys = Object.keys(value);
    if (keys.length > MAX_SCHEMA_NODES - nodes)
      throw new Error(`Tool parameter schema exceeds ${MAX_SCHEMA_NODES} nodes`);
    const result: { [key: string]: Json } = Object.create(null);
    const items: Json[] = [];
    for (const key of keys) {
      countText(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor))
        throw new Error('Tool parameter schemas must not contain accessor properties');
      const child = copy(descriptor.value, depth + 1);
      if (array) {
        if (key !== String(items.length)) throw new Error('Tool parameter schemas must contain plain JSON arrays');
        items.push(child);
      } else result[key] = child;
    }
    if (array && items.length !== value.length)
      throw new Error('Tool parameter schemas must contain plain JSON arrays');
    ancestors.delete(value);
    return array ? items : result;
  }
  return copy(parameters, 0) as Record<string, Json>;
}

function schemaDialect(schema: Record<string, Json>): Dialect {
  if (!Object.hasOwn(schema, '$schema')) return 'draft-07';
  const uri = schema.$schema;
  if (typeof uri === 'string') {
    const normalized = uri.replace(/^https:/, 'http:').replace(/#$/, '');
    for (const [dialect, canonical] of Object.entries(dialects)) {
      if (normalized === canonical.replace(/^https:/, 'http:').replace(/#$/, '')) return dialect as Dialect;
    }
  }
  throw new Error('Unsupported tool parameter $schema; use JSON Schema draft-07, 2019-09, or 2020-12');
}

/**
 * Compile synchronous tool schemas without network loading or data mutation.
 * Omitted $schema retains draft-07 compatibility; protocol adapters should make
 * their own default dialect explicit. All three supported drafts enforce formats.
 *
 * Size/depth/node limits reduce compilation risk, not a CPU sandbox: hosts must
 * still trust schema authors, especially their regexes and recursive references.
 * Separate Ajv registries keep one tool's embedded IDs out of another tool's refs.
 */
export function compileParameters(parameters: Record<string, unknown>): (args: unknown) => void {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error('Tool parameters must be a JSON Schema object');
  }
  const schema = snapshot(parameters);
  const dialect = schemaDialect(schema);
  schema.$schema = dialects[dialect];
  const key = JSON.stringify(schema);
  if (Buffer.byteLength(key) > MAX_SCHEMA_BYTES)
    throw new Error(`Tool parameter schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  const cached = validators.get(key);
  if (cached) {
    validators.delete(key);
    validators.set(key, cached);
    return cached;
  }
  if (schema.$async) throw new Error('Tool parameter schemas must be synchronous');
  const options: Options = {
    strict: true,
    // JSON Schema permits multi-type unions; retain every other strict check.
    allowUnionTypes: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    // Avoid repeatedly inlining referenced definitions into generated code.
    inlineRefs: false,
  };
  const ajv =
    dialect === '2020-12' ? new Ajv2020(options) : dialect === '2019-09' ? new Ajv2019(options) : new Ajv(options);
  addFormats.default(ajv);
  // Ajv resolves static anchors, but does not register this core keyword itself.
  if (dialect !== 'draft-07') ajv.addKeyword({ keyword: '$anchor', schemaType: 'string' });
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    if (error instanceof MissingRefError) {
      throw new Error(
        `Unresolved tool parameter schema reference ${error.missingRef}. Bundle referenced schemas in $defs/definitions; remote schema loading is disabled.`,
        { cause: error },
      );
    }
    throw error;
  }
  if ('$async' in validate && validate.$async) throw new Error('Tool parameter schemas must be synchronous');
  const check = (args: unknown): void => {
    if (!validate(args)) throw new Error(`Invalid tool arguments: ${ajv.errorsText(validate.errors)}`);
  };
  validators.set(key, check);
  if (validators.size > MAX_CACHED_VALIDATORS) {
    const oldest = validators.keys().next().value;
    if (oldest !== undefined) validators.delete(oldest);
  }
  return check;
}
