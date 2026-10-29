import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'

/** Read completed turns from history too: batched done→working→done publications can hide the edge from state alone. */
export function resolveLatestAgentDoneStartedAt(
  entry: AgentStatusEntry | undefined
): number | undefined {
  if (!entry) {
    return undefined
  }
  if (entry.state === 'done') {
    return entry.stateStartedAt
  }
  const history = entry.stateHistory ?? []
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].state === 'done') {
      return history[index].startedAt
    }
  }
  return undefined
}
