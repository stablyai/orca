import type { AppState } from '../../types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusChange } from './agent-status-contract'
import type { AgentStatusProjectionState } from './agent-status-projection-state'

function active(entry: AgentStatusEntry | undefined): number {
  return Number(
    entry?.state === 'working' || entry?.state === 'waiting' || entry?.state === 'blocked'
  )
}

export function stageAcceptedAgentTransitions(
  data: AgentStatusProjectionState,
  state: AppState,
  changes: readonly AgentStatusChange[]
): () => void {
  let count = data.activeAgentCount
  if (!data.inputs) {
    count = 0
    for (const entry of state.agentStatusByPaneKey.values()) {
      count += active(entry)
    }
  } else {
    for (const { previous, current } of changes) {
      count += active(current) - active(previous)
    }
  }
  const batch = data.inputs ? changes : []
  return () => {
    data.activeAgentCount = count
    if (batch.length) {
      data.transitionBatches.push(batch)
    }
  }
}
