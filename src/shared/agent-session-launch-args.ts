import type { AgentSessionLaunchArgs } from './agent-session-record'

const MAX_LAUNCH_ARGS = 256
const MAX_LAUNCH_ARGS_BYTES = 16 * 1024

export function isAgentSessionLaunchArgs(value: unknown): value is AgentSessionLaunchArgs {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LAUNCH_ARGS &&
    value.every((arg) => typeof arg === 'string' && !arg.includes('\0')) &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_LAUNCH_ARGS_BYTES
  )
}
