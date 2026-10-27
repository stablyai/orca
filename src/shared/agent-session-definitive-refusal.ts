/** Fallback needs an allowlisted proof that nothing was created; unknown outcomes/timeouts never qualify. Do not reuse agentSessionRefusalOperationState: unsupported is pending-admission for settlement but permits fallback. */

import type { AgentSessionWireRefusal, AgentSessionWireRefusalCode } from './agent-session-wire'

/** Admission reasons eligible for attempt-level proof, only at a boundary before commit. */
export function isAgentSessionCreateAdmissionRefusal(
  refusal: Pick<AgentSessionWireRefusal, 'code' | 'details'>
): boolean {
  return (
    ((refusal.code === 'agent_session_conflict' ||
      refusal.code === 'agent_session_ownership_unknown') &&
      refusal.details?.reason === 'conversationHeldElsewhere') ||
    (refusal.code === 'agent_session_identity_required' &&
      (refusal.details?.reason === 'transcriptNotFound' ||
        refusal.details?.reason === 'transcriptUnreadable'))
  )
}

/** Proves the host neither created a session nor will on a retry. */
const DEFINITIVE_REFUSAL_CODES: ReadonlySet<string> = new Set<AgentSessionWireRefusalCode>([
  'structured_agent_session_unsupported'
])

/** An unregistered RPC method ran no handler: the only definitive transport-level refusal. */
const DEFINITIVE_RPC_ERROR_CODES: ReadonlySet<string> = new Set(['method_not_found'])

/** Accept disjoint wire-refusal/RPC error codes only when they prove nothing was created. */
export function isDefinitiveAgentSessionCreateRefusal(code: string | null | undefined): boolean {
  if (typeof code !== 'string') {
    return false
  }
  return DEFINITIVE_REFUSAL_CODES.has(code) || DEFINITIVE_RPC_ERROR_CODES.has(code)
}
