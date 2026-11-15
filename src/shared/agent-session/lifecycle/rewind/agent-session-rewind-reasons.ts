export const AGENT_SESSION_REWIND_REASONS = [
  'unsupported',
  'history-not-paginated',
  'busy',
  'stale-epoch',
  'invalid-target',
  'history-limit',
  'provider-refused',
  'proof-mismatch',
  'outcome-unknown'
] as const
export type AgentSessionRewindReason = (typeof AGENT_SESSION_REWIND_REASONS)[number]
