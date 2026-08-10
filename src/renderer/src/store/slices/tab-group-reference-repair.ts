import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/types'
import { createBrowserUuid } from '@/lib/browser-uuid'

function collectLayoutGroupIds(node: TabGroupLayoutNode, groupIds: Set<string>): void {
  if (node.type === 'leaf') {
    groupIds.add(node.groupId)
    return
  }
  collectLayoutGroupIds(node.first, groupIds)
  collectLayoutGroupIds(node.second, groupIds)
}

export function layoutSpanningGroups(
  groups: readonly TabGroup[],
  existing?: TabGroupLayoutNode | null
): TabGroupLayoutNode {
  const first = existing ?? { type: 'leaf', groupId: groups[0].id }
  const laidOutGroupIds = new Set<string>()
  collectLayoutGroupIds(first, laidOutGroupIds)
  return groups
    .filter((group) => !laidOutGroupIds.has(group.id))
    .reduce<TabGroupLayoutNode>(
      (first, group) => ({
        type: 'split',
        direction: 'horizontal',
        first,
        second: { type: 'leaf', groupId: group.id }
      }),
      first
    )
}

/** Re-home tabs stranded by a dropped group so hydration cannot render a blank workspace. */
export function adoptGrouplessTabs(
  tabsByWorktree: Record<string, Tab[]>,
  groupsByWorktree: Record<string, TabGroup[]>,
  activeGroupIdByWorktree: Record<string, string>,
  layoutByWorktree: Record<string, TabGroupLayoutNode>
): void {
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const groups = groupsByWorktree[worktreeId] ?? []
    const owningGroupIdByTabId = new Map<string, string>()
    for (const group of groups) {
      for (const tabId of group.tabOrder) {
        owningGroupIdByTabId.set(tabId, owningGroupIdByTabId.get(tabId) ?? group.id)
      }
    }
    const orphanIds = tabs.filter((tab) => !owningGroupIdByTabId.has(tab.id)).map((tab) => tab.id)
    const host: TabGroup = groups[0] ?? {
      id: createBrowserUuid(),
      worktreeId,
      activeTabId: null,
      tabOrder: [],
      recentTabIds: []
    }
    const adopted = orphanIds.length
      ? {
          ...host,
          tabOrder: [...host.tabOrder, ...orphanIds],
          activeTabId: host.activeTabId ?? orphanIds[0]
        }
      : host
    for (const tabId of orphanIds) {
      owningGroupIdByTabId.set(tabId, adopted.id)
    }
    tabsByWorktree[worktreeId] = tabs.map((tab) => {
      const owningGroupId = owningGroupIdByTabId.get(tab.id)
      return owningGroupId && tab.groupId !== owningGroupId
        ? { ...tab, groupId: owningGroupId }
        : tab
    })
    if (orphanIds.length) {
      groupsByWorktree[worktreeId] = [adopted, ...groups.slice(1)]
      activeGroupIdByWorktree[worktreeId] ??= adopted.id
      layoutByWorktree[worktreeId] ??= { type: 'leaf', groupId: adopted.id }
    }
  }
}
