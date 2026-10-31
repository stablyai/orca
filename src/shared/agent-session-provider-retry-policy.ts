export type AgentSessionTransientFailure =
  | 'overloaded'
  | 'stream-disconnected'
  | 'connection-failed'
  | 'internal'

export function agentSessionProviderRetryDelay(attempt: number): number | null {
  return attempt >= 1 && attempt <= 5 ? Math.min(2_000 * 2 ** (attempt - 1), 30_000) : null
}
