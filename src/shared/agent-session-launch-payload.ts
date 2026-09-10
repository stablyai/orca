/**
 * Bounds on the launch payload a session record may carry.
 *
 * These live apart from the record itself because they guard UNTRUSTED, unbounded input — an
 * environment block and an argv a caller supplies — rather than the record's own identity fields.
 */

/** Provider launch environment captured by the host when the session is created. */
export type AgentSessionLaunchEnv = Record<string, string>

/** Provider CLI arguments captured by the host when the session is created. */
export type AgentSessionLaunchArgs = string[]

const MAX_LAUNCH_ENV_KEY_LENGTH = 512
const MAX_LAUNCH_ENV_ENTRIES = 256
const MAX_LAUNCH_ENV_VALUE_LENGTH = 65_536
const MAX_LAUNCH_ARGS = 256
const MAX_LAUNCH_ARGS_BYTES = 16 * 1024

export function isAgentSessionLaunchEnv(value: unknown): value is AgentSessionLaunchEnv {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_LAUNCH_ENV_ENTRIES &&
    entries.every(
      ([key, entry]) =>
        typeof key === 'string' &&
        key.length > 0 &&
        key.length <= MAX_LAUNCH_ENV_KEY_LENGTH &&
        typeof entry === 'string' &&
        entry.length <= MAX_LAUNCH_ENV_VALUE_LENGTH
    )
  )
}

export function isAgentSessionLaunchArgs(value: unknown): value is AgentSessionLaunchArgs {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LAUNCH_ARGS &&
    value.every((arg) => typeof arg === 'string' && !arg.includes('\0')) &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_LAUNCH_ARGS_BYTES
  )
}
