import type { AppState } from '../../../types'
import type { AcceptedAgentStatuses } from './accepted-agent-statuses'

/** Agent statuses and their projection publish before the root write and notify after it. */
export function createAgentStatusTransactionOwner() {
  // Held only from stage to commit, which run back to back with no updater or listener between.
  let publishStatuses: (() => void) | undefined
  let publishProjection: (() => void) | undefined
  return {
    initialize(state: AppState): AppState {
      state.agentStatusByPaneKey.projection.prepare(state, [])()
      return captureAgentStatusView(state)
    },
    stage(current: AppState, next: AppState): AcceptedAgentStatuses {
      const fullResync = !next.agentStatusByPaneKey.sharesOwner(current.agentStatusByPaneKey)
      if (fullResync) {
        const incoming = next.agentStatusByPaneKey
        next.agentStatusByPaneKey = current.agentStatusByPaneKey.replace([
          ...Array.from(current.agentStatusByPaneKey.keys(), (key) => [key, null] as const),
          ...incoming
        ])
      }
      const statuses = next.agentStatusByPaneKey
      const preparedStatuses = statuses.prepare()
      const preparedProjection = statuses.projection.prepare(
        next,
        statuses.changes(),
        statuses.refreshKeys,
        fullResync
      )
      // Held only once both succeed, so a failed preparation retains nothing past its write.
      publishStatuses = preparedStatuses
      publishProjection = preparedProjection
      return statuses
    },
    commit(): void {
      const statuses = publishStatuses
      const projection = publishProjection
      publishStatuses = undefined
      publishProjection = undefined
      projection?.()
      statuses?.()
    },
    notify(statuses: AcceptedAgentStatuses): void {
      statuses.projection.notify()
    }
  }
}

export function captureAgentStatusView(state: AppState): AppState {
  const captured = { ...state, agentStatusByPaneKey: state.agentStatusByPaneKey.capture() }
  return captured
}
