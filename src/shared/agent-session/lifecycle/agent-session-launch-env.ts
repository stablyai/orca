/** Transient provider environment; persisted records do not carry it. */
export type AgentSessionLaunchEnv = Record<string, string>

const MAX_LAUNCH_ENV_ENTRIES = 256
const MAX_LAUNCH_ENV_KEY_LENGTH = 512
const MAX_LAUNCH_ENV_VALUE_LENGTH = 65_536

export function isAgentSessionLaunchEnv(value: unknown): value is AgentSessionLaunchEnv {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_LAUNCH_ENV_ENTRIES &&
    entries.every(
      ([key, entry]) =>
        key.length > 0 &&
        key.length <= MAX_LAUNCH_ENV_KEY_LENGTH &&
        typeof entry === 'string' &&
        entry.length <= MAX_LAUNCH_ENV_VALUE_LENGTH
    )
  )
}
