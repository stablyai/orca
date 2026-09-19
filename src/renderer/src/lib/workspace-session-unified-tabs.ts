import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WorkspaceSessionSnapshot } from './workspace-session'
import { projectAgentCardsToOrdinaryTabs } from '../store/slices/tabs/agent-cards-projection'

type PersistedUnifiedTabSessionData = Pick<
  WorkspaceSessionState,
  'activeGroupIdByWorktree' | 'tabGroupLayouts' | 'tabGroups' | 'unifiedTabs'
>

type WorktreeAgentCardGroupIds = Record<string, readonly string[]>

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
  > & {
    // Why optional: callers outside the unified-tab session slice (e.g. the web tabs-sync
    // mirror) have no card registry of their own; treat a missing one as empty.
    agentCardGroupIdsByWorktree?: WorkspaceSessionSnapshot['agentCardGroupIdsByWorktree']
    // Why optional: a card group is agent-only only if terminal-launched agents are visible
    // too; callers without that data (e.g. hand-built session fixtures) get none.
    tabsByWorktree?: WorkspaceSessionSnapshot['tabsByWorktree']
  }
): PersistedUnifiedTabSessionData {
  const sourceCardGroupIds: WorktreeAgentCardGroupIds = snapshot.agentCardGroupIdsByWorktree ?? {}
  const sourceTerminalTabs: Record<string, readonly TerminalTab[]> = snapshot.tabsByWorktree ?? {}
  const unifiedTabs: WorkspaceSessionState['unifiedTabs'] = {}
  const tabGroups: WorkspaceSessionState['tabGroups'] = {}
  const tabGroupLayouts: WorkspaceSessionState['tabGroupLayouts'] = {}
  const activeGroupIdByWorktree: WorkspaceSessionState['activeGroupIdByWorktree'] = {}
  const sourceTabs = snapshot.unifiedTabsByWorktree ?? {}
  const sourceGroups = snapshot.groupsByWorktree ?? {}
  const sourceLayouts = snapshot.layoutByWorktree ?? {}
  const sourceActiveGroups = snapshot.activeGroupIdByWorktree ?? {}
  const worktreeIds = new Set([
    ...Object.keys(sourceTabs),
    ...Object.keys(sourceGroups),
    ...Object.keys(sourceLayouts)
  ])

  for (const worktreeId of worktreeIds) {
    const projected = projectAgentCardsToOrdinaryTabs({
      tabs: sourceTabs[worktreeId] ?? [],
      groups: sourceGroups[worktreeId] ?? [],
      layout: sourceLayouts[worktreeId],
      cardGroupIds: sourceCardGroupIds[worktreeId] ?? [],
      terminalTabs: sourceTerminalTabs[worktreeId] ?? []
    })
    const tabs = [...projected.tabs]
    if (tabs.length === 0) {
      continue
    }

    const groups = buildPersistedGroupsForWorktree(tabs, [...projected.groups])
    if (groups.length === 0) {
      continue
    }

    const groupIds = new Set(groups.map((group) => group.id))
    const persistedTabs = tabs.filter((tab) => groupIds.has(tab.groupId))
    if (persistedTabs.length === 0) {
      continue
    }

    unifiedTabs[worktreeId] = persistedTabs
    tabGroups[worktreeId] = groups
    const activeGroupId = sourceActiveGroups[worktreeId]
    activeGroupIdByWorktree[worktreeId] =
      activeGroupId && groupIds.has(activeGroupId) ? activeGroupId : groups[0].id
    const prunedLayout = projected.layout
      ? prunePersistedLayoutForGroups(projected.layout, groupIds)
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
