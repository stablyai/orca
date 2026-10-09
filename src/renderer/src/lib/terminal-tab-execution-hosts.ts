import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'

export function indexTerminalTabExecutionHosts(
  tabs: readonly Tab[]
): ReadonlyMap<string, ExecutionHostId | null> {
  const hosts = new Map<string, ExecutionHostId | null>()
  for (const tab of tabs) {
    if (tab.contentType !== 'terminal' || !tab.executionHostId) {
      continue
    }
    for (const id of [tab.entityId, tab.id]) {
      const existing = hosts.get(id)
      // Conflicting persisted owners remain ambiguous regardless of row order.
      hosts.set(
        id,
        existing === undefined || existing === tab.executionHostId ? tab.executionHostId : null
      )
    }
  }
  return hosts
}
