// The size bounds every durable agent-session field is validated against, and the one predicate
// that applies them. Separate from the record so the per-field guards can import them without
// importing the record schema back.

export const MAX_ID_LENGTH = 512
export const MAX_PATH_LENGTH = 4096
export const MAX_LAUNCH_ENV_ENTRIES = 256
export const MAX_LAUNCH_ENV_VALUE_LENGTH = 65_536
export const MAX_LAUNCH_ARGS = 256
export const MAX_LAUNCH_ARGS_BYTES = 16 * 1024

export function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}
