import type { AppState } from '../../types'
import type { AgentStatusChange } from './agent-status-contract'
import type { AgentStatusProjectionState } from './agent-status-projection-state'
import type { ProjectionTopology } from './agent-status-projection-topology'
import type { ProjectionRows } from './agent-status-projection-rows'

export function publishProjectionTopology(
  data: AgentStatusProjectionState,
  state: AppState,
  changes: readonly AgentStatusChange[],
  topology: ProjectionTopology,
  rows: ProjectionRows
): void {
  const { nextTabs, nextTabOwners, represented, nextUnsupported, nextFallback, nextFallbackTabs } =
    topology
  const { nextSuppressions, suppressionDeltas } = rows
  for (const change of changes) {
    data.changedKeys.add(change.paneKey)
    data.notices.add(`status\0${change.paneKey}`)
  }
  for (const tabId of topology.bindingTabs) {
    for (const key of data.acceptedByTab.get(tabId) ?? []) {
      data.changedKeys.add(key)
    }
  }
  data.inputs = state
  represented.commitInto(data.represented)
  for (const [id, tab] of nextTabs) {
    if (tab) {
      data.tabs.set(id, tab)
    } else {
      data.tabs.delete(id)
    }
  }
  for (const [id, owner] of nextTabOwners) {
    if (owner) {
      data.tabWorktrees.set(id, owner)
    } else {
      data.tabWorktrees.delete(id)
    }
  }
  for (const [key, row] of nextFallback) {
    if (row) {
      data.fallbackRows.set(key, row)
    } else {
      data.fallbackRows.delete(key)
    }
  }
  for (const [tab, keys] of nextFallbackTabs) {
    if (keys.size) {
      data.fallbackByTab.set(tab, keys)
    } else {
      data.fallbackByTab.delete(tab)
    }
  }
  for (const [key, row] of nextUnsupported) {
    if (row) {
      data.unsupportedRows.set(key, row)
    } else {
      data.unsupportedRows.delete(key)
    }
  }
  for (const [key, diff] of suppressionDeltas) {
    const count = (data.suppressed.get(key) ?? 0) + diff
    if (count) {
      data.suppressed.set(key, count)
    } else {
      data.suppressed.delete(key)
    }
  }
  for (const [key, keys] of nextSuppressions) {
    if (keys.length) {
      data.suppressionsBySource.set(key, keys)
    } else {
      data.suppressionsBySource.delete(key)
    }
  }
}
