import type { AppState } from '../../types'
import { readRecordChanges } from '../../keyed-record-change-reads'
import { resolveAgentStatusWorktreeId } from '../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { workspaceMarkerTabs } from './workspace-live-markers'

function createAgentPaneWorkspaceIndex<T>() {
  let source: Readonly<Record<string, T>> | null = null
  const ownerByPaneKey = new Map<string, string>()
  const keysByWorkspace = new Map<string, Set<string>>()
  return (
    next: Readonly<Record<string, T>>,
    owner: (entry: T) => string | null,
    reset = false
  ): ReadonlyMap<string, ReadonlySet<string>> => {
    if (source === next && !reset) {
      return keysByWorkspace
    }
    const changes = source && !reset ? readRecordChanges(next, source) : null
    const keys = changes?.kind === 'addressed' ? changes.keys : null
    if (keys === null) {
      ownerByPaneKey.clear()
      keysByWorkspace.clear()
    }
    for (const paneKey of keys ?? Object.keys(next)) {
      const previousOwner = ownerByPaneKey.get(paneKey)
      const nextOwner = next[paneKey] ? owner(next[paneKey]) : null
      if (previousOwner === nextOwner) {
        continue
      }
      if (previousOwner !== undefined) {
        const bucket = keysByWorkspace.get(previousOwner)!
        bucket.delete(paneKey)
        if (bucket.size === 0) {
          keysByWorkspace.delete(previousOwner)
        }
        ownerByPaneKey.delete(paneKey)
      }
      if (nextOwner !== null) {
        let bucket = keysByWorkspace.get(nextOwner)
        if (!bucket) {
          keysByWorkspace.set(nextOwner, (bucket = new Set()))
        }
        bucket.add(paneKey)
        ownerByPaneKey.set(paneKey, nextOwner)
      }
    }
    source = next
    return keysByWorkspace
  }
}

let terminalTabs: AppState['tabsByWorktree'] | null = null
let unifiedTabs: AppState['unifiedTabsByWorktree'] | null = null
const tabOwners = new Map<string, string>()
const liveIndex = createAgentPaneWorkspaceIndex<AppState['agentStatusByPaneKey'][string]>()
const retainedIndex = createAgentPaneWorkspaceIndex<AppState['retainedAgentsByPaneKey'][string]>()

/** Explicit reads include completed orphans and parent-attributed panes, even without a sidebar row. */
export function workspaceAgentPaneKeys(state: AppState, worktreeId: string): string[] {
  const tabsChanged =
    terminalTabs !== state.tabsByWorktree || unifiedTabs !== state.unifiedTabsByWorktree
  if (tabsChanged) {
    tabOwners.clear()
    for (const id of new Set([
      ...Object.keys(state.tabsByWorktree),
      ...Object.keys(state.unifiedTabsByWorktree)
    ])) {
      for (const tab of workspaceMarkerTabs(state, id)) {
        tabOwners.set(tab.id, id)
      }
    }
    terminalTabs = state.tabsByWorktree
    unifiedTabs = state.unifiedTabsByWorktree
  }
  const live = liveIndex(
    state.agentStatusByPaneKey,
    (entry) => resolveAgentStatusWorktreeId(entry, tabOwners),
    tabsChanged
  )
  const retained = retainedIndex(state.retainedAgentsByPaneKey, (entry) => entry.worktreeId)
  return [...(live.get(worktreeId) ?? []), ...(retained.get(worktreeId) ?? [])]
}
