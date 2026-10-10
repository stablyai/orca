import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WorkspaceSessionSnapshot } from './workspace-session'
import { canRestorePersistedTab, dedupeTabsById } from '../store/slices/tab-group-state'

type PersistedUnifiedTabSessionData = Pick<
  WorkspaceSessionState,
  'activeGroupIdByWorktree' | 'tabGroupLayouts' | 'tabGroups' | 'unifiedTabs'
>

function prunePersistedLayoutForGroups(
  root: TabGroupLayoutNode,
  validGroupIds: Set<string>
): TabGroupLayoutNode | null {
  if (root.type === 'leaf') {
    return validGroupIds.has(root.groupId) ? root : null
  }

  const first = prunePersistedLayoutForGroups(root.first, validGroupIds)
  const second = prunePersistedLayoutForGroups(root.second, validGroupIds)

  if (first === null) {
    return second
  }
  if (second === null) {
    return first
  }

  return { ...root, first, second }
}

function buildPersistedGroupsForWorktree(tabs: Tab[], groups: TabGroup[]): TabGroup[] {
  const validTabIds = new Set(tabs.map((tab) => tab.id))
  const tabIdsByGroup = new Map<string, string[]>()
  for (const tab of tabs) {
    const groupTabs = tabIdsByGroup.get(tab.groupId) ?? []
    groupTabs.push(tab.id)
    tabIdsByGroup.set(tab.groupId, groupTabs)
  }

  return groups
    .map((group) => {
      const orderedTabIds = new Set([
        ...group.tabOrder.filter((tabId) => validTabIds.has(tabId)),
        ...(tabIdsByGroup.get(group.id) ?? [])
      ])
      const tabOrder = Array.from(orderedTabIds)
      const activeTabId =
        group.activeTabId && orderedTabIds.has(group.activeTabId) ? group.activeTabId : null
      return {
        ...group,
        activeTabId,
        tabOrder,
        recentTabIds: group.recentTabIds?.filter((tabId) => orderedTabIds.has(tabId))
      }
    })
    .filter((group) => group.tabOrder.length > 0)
}

export function buildPersistedUnifiedTabSessionData(
  snapshot: Pick<
    WorkspaceSessionSnapshot,
    'activeGroupIdByWorktree' | 'groupsByWorktree' | 'layoutByWorktree' | 'unifiedTabsByWorktree'
  > &
    Partial<Pick<WorkspaceSessionSnapshot, 'openFiles'>>
): PersistedUnifiedTabSessionData {
  const unifiedTabs: WorkspaceSessionState['unifiedTabs'] = {}
  const tabGroups: WorkspaceSessionState['tabGroups'] = {}
  const tabGroupLayouts: WorkspaceSessionState['tabGroupLayouts'] = {}
  const activeGroupIdByWorktree: WorkspaceSessionState['activeGroupIdByWorktree'] = {}
  const sourceTabs = snapshot.unifiedTabsByWorktree ?? {}
  const sourceGroups = snapshot.groupsByWorktree ?? {}
  const sourceLayouts = snapshot.layoutByWorktree ?? {}
  const sourceActiveGroups = snapshot.activeGroupIdByWorktree ?? {}
  const persistedEditFileIdsByWorktree = new Map<string, Set<string>>()
  for (const file of snapshot.openFiles ?? []) {
    if (file.mode === 'edit') {
      const ids = persistedEditFileIdsByWorktree.get(file.worktreeId) ?? new Set<string>()
      ids.add(file.filePath)
      persistedEditFileIdsByWorktree.set(file.worktreeId, ids)
    }
  }
  const worktreeIds = new Set([
    ...Object.keys(sourceTabs),
    ...Object.keys(sourceGroups),
    ...Object.keys(sourceLayouts)
  ])

  for (const worktreeId of worktreeIds) {
    // Why: chat-visual tabs are in memory only; the saved-session schema has no such kind.
    const tabs = (sourceTabs[worktreeId] ?? []).filter((tab) => tab.contentType !== 'chat-visual')
    if (tabs.length === 0) {
      continue
    }

    const groups = buildPersistedGroupsForWorktree(tabs, sourceGroups[worktreeId] ?? [])
    if (groups.length === 0) {
      continue
    }

    const groupIds = new Set(groups.map((group) => group.id))
    const persistedEditFileIds = persistedEditFileIdsByWorktree.get(worktreeId) ?? new Set<string>()
    // Filter before deduplication so an unrestorable copy cannot hide a live editor.
    const persistedTabs = dedupeTabsById(
      [...tabs]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
        .filter((tab) => groupIds.has(tab.groupId))
        .filter((tab) => !snapshot.openFiles || canRestorePersistedTab(tab, persistedEditFileIds))
    )
    if (persistedTabs.length === 0) {
      continue
    }

    unifiedTabs[worktreeId] = persistedTabs
    tabGroups[worktreeId] = groups
    const activeGroupId = sourceActiveGroups[worktreeId]
    activeGroupIdByWorktree[worktreeId] =
      activeGroupId && groupIds.has(activeGroupId) ? activeGroupId : groups[0].id
    const prunedLayout = sourceLayouts[worktreeId]
      ? prunePersistedLayoutForGroups(sourceLayouts[worktreeId], groupIds)
      : null
    tabGroupLayouts[worktreeId] = prunedLayout ?? { type: 'leaf', groupId: groups[0].id }
  }

  return {
    unifiedTabs,
    tabGroups,
    tabGroupLayouts,
    activeGroupIdByWorktree
  }
}
