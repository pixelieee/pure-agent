import { Ajv } from 'ajv';

/** Compile trusted tool schemas once, using synchronous draft-07 validation.
 * No remote loading, coercion, inserted defaults, or removal of extra fields.
 * Schema authors must opt into additionalProperties: false when appropriate.
 */
export function compileParameters(parameters: Record<string, unknown>): (args: unknown) => void {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error('Tool parameters must be a JSON Schema object');
  }
  const ajv = new Ajv({ strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  const validate = ajv.compile(parameters);
  if ('$async' in validate && validate.$async) throw new Error('Tool parameter schemas must be synchronous');
  return args => {
    if (!validate(args)) throw new Error(`Invalid tool arguments: ${ajv.errorsText(validate.errors)}`);
  };
}
