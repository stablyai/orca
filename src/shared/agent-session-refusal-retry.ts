import type { AgentSessionWireRefusalCode } from './agent-session-wire'

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
