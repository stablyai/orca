import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'

const UNSETTLED_DISPATCH_STATUSES = new Set(['pending', 'dispatched'])

/**
 * Panes supervising a worker whose Dispatch has not settled.
 *
 * Belt-and-braces only: the wake path is what makes a slept supervisor safe, so
 * an obligation this misses is no longer a silent deadlock. It avoids the common
 * case ever needing a wake, and it reads the supervisor identity each worker
 * already publishes rather than enumerating obligation kinds.
 *
 * Keyed by stable leaf id: a pane key's tab half is reminted on break-out.
 */
export function getSupervisorLeafIdsWithUnsettledDispatch(
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
): Set<string> {
  const leafIds = new Set<string>()
  for (const entry of Object.values(agentStatusByPaneKey)) {
    const orchestration = entry?.orchestration
    if (!orchestration || !UNSETTLED_DISPATCH_STATUSES.has(orchestration.dispatchStatus ?? '')) {
      continue
    }
    const supervisorLeafId = orchestration.parentPaneKey
      ? parsePaneKey(orchestration.parentPaneKey)?.leafId
      : undefined
    if (supervisorLeafId) {
      leafIds.add(supervisorLeafId)
    }
  }
  return leafIds
}

export function isSupervisingUnsettledDispatch(
  paneKey: string,
  supervisorLeafIds: ReadonlySet<string>
): boolean {
  const leafId = parsePaneKey(paneKey)?.leafId
  return leafId !== undefined && supervisorLeafIds.has(leafId)
}
