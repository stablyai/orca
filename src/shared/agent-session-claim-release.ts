import {
  isAgentSessionOwnerBinding,
  type AgentSessionOwnerBinding
} from './agent-session/agent-session-host-authority'

/** Remove exactly one owner binding at the authority holding it, keeping its PTY running. */
export type AgentSessionClaimReleaseRequest = {
  id: string
  expectedIncarnationId: string
  owner: AgentSessionOwnerBinding
}

export type AgentSessionClaimReleaseOutcome =
  | { outcome: 'released' }
  | {
      outcome: 'refused'
      reason: 'replaced' | 'pending' | 'owner' | 'unsupported' | 'unverifiable'
    }

const REFUSAL_REASONS = new Set(['replaced', 'pending', 'owner', 'unsupported', 'unverifiable'])

export function isAgentSessionClaimReleaseOutcome(
  value: unknown
): value is AgentSessionClaimReleaseOutcome {
  if (!value || typeof value !== 'object' || !('outcome' in value)) {
    return false
  }
  return (
    value.outcome === 'released' ||
    (value.outcome === 'refused' &&
      'reason' in value &&
      typeof value.reason === 'string' &&
      REFUSAL_REASONS.has(value.reason))
  )
}

export function isAgentSessionClaimReleasePayload(
  value: unknown
): value is { sessionId: string; expectedIncarnationId: string; owner: AgentSessionOwnerBinding } {
  if (!value || typeof value !== 'object') {
    return false
  }
  const payload = value as Record<string, unknown>
  return (
    typeof payload.sessionId === 'string' &&
    typeof payload.expectedIncarnationId === 'string' &&
    payload.expectedIncarnationId.length > 0 &&
    isAgentSessionOwnerBinding(payload.owner) &&
    payload.owner.ptyId === payload.sessionId
  )
}
