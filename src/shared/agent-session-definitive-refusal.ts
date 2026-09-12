/**
 * "May a caller create something else instead?" — the fallback question.
 *
 * Deliberately NOT `agentSessionRefusalOperationState`: that answers "did this operation durably
 * settle?", and for that question `structured_agent_session_unsupported` is correctly
 * pending-admission. Reused here it would rule out a fallback on the one refusal that most needs
 * one. The two questions only look alike.
 *
 * An allowlist, never a negation: falling back on an outcome the host could not describe is how a
 * user ends up with two sessions for one intent. Everything absent — transport failures, timeouts,
 * `agent_session_operation_unknown`, `agent_session_ownership_unknown` — is unknown, and unknown
 * never falls back.
 */

import type { AgentSessionWireRefusalCode } from './agent-session-wire'

/** Proves the host neither created a session nor will on a retry. */
const DEFINITIVE_REFUSAL_CODES: ReadonlySet<string> = new Set<AgentSessionWireRefusalCode>([
  'structured_agent_session_unsupported'
])

/** A dispatcher that never registered the method ran no handler at all, which is as definitive as
 *  a refusal — and the only transport-level answer that is. */
const DEFINITIVE_RPC_ERROR_CODES: ReadonlySet<string> = new Set(['method_not_found'])

/**
 * True only when the code proves nothing was created. Accepts a wire refusal code or an RPC error
 * code; the two namespaces are disjoint.
 */
export function isDefinitiveAgentSessionCreateRefusal(code: string | null | undefined): boolean {
  if (typeof code !== 'string') {
    return false
  }
  return DEFINITIVE_REFUSAL_CODES.has(code) || DEFINITIVE_RPC_ERROR_CODES.has(code)
}
