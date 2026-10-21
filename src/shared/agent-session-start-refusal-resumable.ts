import type { AgentSessionWireRefusalCode } from './agent-session-wire-refusals'

/**
 * Whether a refused start leaves the chat anything to start again from. `false`: this host has
 * nothing to restart it from — no record, or none it can run — so only a new chat continues.
 * A new wire code does not compile until it is classified here.
 */
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
