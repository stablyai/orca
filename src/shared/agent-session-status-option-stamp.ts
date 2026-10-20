import type { AgentSessionStatusSummary } from './agent-session-wire'

/** The host status's option values as one stamp: another device's pick moves it, so options re-read. */
export function agentSessionStatusOptionStamp(
  summary: AgentSessionStatusSummary | undefined
): string {
  // An older host omits effort, Fast and speed, so only model and permission mode move it.
  return [
    summary?.model,
    summary?.permissionMode,
    summary?.effort,
    summary?.fastMode,
    summary?.serviceTier
  ]
    .map((value) => value ?? '')
    .join('|')
}
