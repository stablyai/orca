import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'

/** Start time of the newest completed turn, counting turns already folded into history.
 *  Why: batched publications coalesce done→working→done into a single store notification,
 *  so the done EDGE survives only in stateHistory; comparing `state` alone misses it. */
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
