import type { AgentSessionOwnerVerdict, AgentSessionWireRefusalCode } from './agent-session-wire'

export type AgentSessionRefusalOperationState = 'settled-rejected' | 'pending-admission' | 'unknown'

export function agentSessionRefusalOperationState(
  code: AgentSessionWireRefusalCode
): AgentSessionRefusalOperationState {
  switch (code) {
    // The host tried to restart the owner for this send and could not; a Retry tries again.
    case 'agent_session_owner_restart_failed':
    case 'agent_session_operation_conflict':
    case 'agent_session_operation_expired':
    case 'agent_session_operation_invalid':
    case 'agent_session_item_revision_stale':
    case 'agent_session_already_resolved':
      return 'settled-rejected'
    case 'agent_session_operation_unknown':
      return 'unknown'
    case 'structured_agent_session_unsupported':
    case 'agent_session_checkpoint_stale':
    case 'agent_session_conflict':
    case 'agent_session_ownership_unknown':
    case 'agent_session_operation_capacity':
    case 'agent_session_identity_required':
    case 'agent_session_journal_unreadable':
    case 'execution_owner_reconciling':
      // These refusals do not prove the operation reached durable settlement.
      return 'pending-admission'
  }
}

/**
 * Whether a verdict lets a retry use a new operation id. A stored `exited` is final: nothing runs
 * the refused operation, so a new id cannot collide with it. Any other stored verdict is a floor:
 * the first operation may still land, so only a verdict re-derived from the current lease can prove
 * `exited`, and nothing lowers a stored `exited`.
 */
export function agentSessionOwnerVerdictAllowsFreshOperationId(
  stored: AgentSessionOwnerVerdict | undefined,
  current?: AgentSessionOwnerVerdict
): boolean {
  return stored === 'exited' || current === 'exited'
}
