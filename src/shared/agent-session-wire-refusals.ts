// How the host declines an `agentSession.*` mutation: the closed code list, its
// narrowing guard, and the refusal body a client reads.

import type { AgentJournalResolution } from './agent-session-journal-types'
import type { AgentSessionRewindReason } from './agent-session-rewind'

export const AGENT_SESSION_WIRE_REFUSAL_CODES = [
  'structured_agent_session_unsupported',
  'agent_session_checkpoint_stale',
  'agent_session_conflict',
  'agent_session_ownership_unknown',
  'agent_session_operation_conflict',
  'agent_session_operation_expired',
  'agent_session_operation_capacity',
  'agent_session_operation_invalid',
  'agent_session_operation_unknown',
  'agent_session_item_revision_stale',
  'agent_session_already_resolved',
  'agent_session_identity_required',
  'agent_session_journal_unreadable',
  'execution_owner_reconciling'
] as const
export type AgentSessionWireRefusalCode = (typeof AGENT_SESSION_WIRE_REFUSAL_CODES)[number]

/** For a host path that raises its refusal as the thrown code. Narrowing through this keeps an
 *  unrelated fault from being reported to the client as a tidy, wrong refusal. */
export function isAgentSessionWireRefusalCode(
  value: unknown
): value is AgentSessionWireRefusalCode {
  return (
    typeof value === 'string' &&
    (AGENT_SESSION_WIRE_REFUSAL_CODES as readonly string[]).includes(value)
  )
}

export type AgentSessionWireRefusal = {
  rewindReason?: AgentSessionRewindReason
  code: AgentSessionWireRefusalCode
  message: string
  /** On a stale fence, so the client can retry without another round trip. */
  currentFence?: number
  /** On a lost compare-and-set: the winning answer and who gave it. */
  resolution?: AgentJournalResolution
  /** On a lost compare-and-set: the revision the host actually holds. */
  currentRevision?: number
}
