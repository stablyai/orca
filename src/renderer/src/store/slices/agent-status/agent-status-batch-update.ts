import type { AppState } from '../../types'
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

export function buildAgentStatusBatchPatch(
  initialState: AppState,
  nextState: AppState,
  touchedKeys: ReadonlySet<keyof AppState>
): Partial<AppState> {
  const patch: Record<string, unknown> = {}
  // Untouched slices cannot differ, so the patch stays proportional to what the fold actually wrote.
  for (const key of touchedKeys) {
    if (!Object.is(nextState[key], initialState[key])) {
      patch[key as string] = nextState[key]
    }
  }
  return patch as Partial<AppState>
}
