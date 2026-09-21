import type { AgentSessionWireRefusalCode } from './agent-session-wire'

export type AgentSessionRefusalOperationState = 'settled-rejected' | 'pending-admission' | 'unknown'

const HANDOFF_SETTLED_REFUSALS = new Set<AgentSessionWireRefusalCode>([
  'structured_agent_session_unsupported',
  'agent_session_checkpoint_stale',
  'agent_session_conflict',
  'agent_session_operation_conflict'
])

export function agentSessionRefusalOperationState(
  method: string,
  code: AgentSessionWireRefusalCode
): AgentSessionRefusalOperationState {
  if (method === 'agentSession.requestHandoff' && HANDOFF_SETTLED_REFUSALS.has(code)) {
    return 'settled-rejected'
  }
  switch (code) {
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
