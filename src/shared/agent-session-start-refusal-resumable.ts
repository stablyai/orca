import type { AgentSessionWireRefusalCode } from './agent-session-wire-refusals'

/** False means no runnable stored chat remains, so only a new chat continues. Classify every new wire code before compilation succeeds. */
export const START_REFUSAL_RESUMABLE: Record<AgentSessionWireRefusalCode, boolean> = {
  execution_owner_reconciling: true,
  agent_session_conflict: true,
  agent_session_checkpoint_stale: true,
  agent_session_ownership_unknown: true,
  agent_session_operation_capacity: true,
  structured_agent_session_unsupported: false,
  agent_session_operation_conflict: true,
  agent_session_operation_expired: true,
  agent_session_operation_invalid: true,
  agent_session_operation_unknown: true,
  agent_session_item_revision_stale: true,
  agent_session_already_resolved: true,
  agent_session_identity_required: false,
  agent_session_journal_unreadable: true,
  agent_session_owner_restart_failed: true
}
