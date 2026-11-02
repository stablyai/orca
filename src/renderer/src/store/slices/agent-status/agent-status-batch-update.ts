import type { AgentStatusBatchUpdate } from './agent-status-contract'
import type { AgentStatusSlice } from './agent-status-slice-contract'

export function applyAgentStatusBatchUpdate(
  actions: Pick<
    AgentStatusSlice,
    'setAgentStatus' | 'recordAgentProviderSession' | 'setAgentProgramStatus'
  >,
  update: AgentStatusBatchUpdate
): void {
  if (update.kind === 'providerSession') {
    actions.recordAgentProviderSession(
      update.paneKey,
      update.agent,
      update.providerSession,
      update.timing,
      update.routing,
      update.metadata
    )
  } else if (update.kind === 'programStatus') {
    actions.setAgentProgramStatus(update.paneKey, update.programStatus)
  } else {
    actions.setAgentStatus(
      update.paneKey,
      update.payload,
      update.terminalTitle,
      update.timing,
      update.routing,
      update.metadata
    )
  }
}
