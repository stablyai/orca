const MAX_LAUNCH_ARGS = 256
const MAX_LAUNCH_ARGS_BYTES = 16 * 1024

/** Provider CLI arguments captured by the host when the session is created. */
export type AgentSessionLaunchArgs = string[]

export function isAgentSessionLaunchArgs(value: unknown): value is AgentSessionLaunchArgs {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LAUNCH_ARGS &&
    value.every((arg) => typeof arg === 'string' && !arg.includes('\0')) &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_LAUNCH_ARGS_BYTES
  )
}
