import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import { getGroupVisibleTabOrder } from '../tab-bar/group-tab-order'
import { collectLayoutGroupIds } from '@/runtime/web-session-tabs-sync/tab-group-layout-tree'

type AgentTabRow = { tab: { id: string } }

export function orderAgentsByVisibleTabs<T extends AgentTabRow>(
  agents: T[],
  tabs: readonly Tab[],
  groups: readonly TabGroup[],
  layout: TabGroupLayoutNode | undefined,
  legacyOrder: readonly string[]
): T[] {
  const ranks = new Map<string, number>()
  const add = (id: string): void => {
    if (!ranks.has(id)) {
      ranks.set(id, ranks.size)
    }
  }
  const groupIds = collectLayoutGroupIds(layout)
  groups.forEach((group) => groupIds.add(group.id))
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  for (const id of groupIds) {
    const group = groupsById.get(id)
    if (!group) {
      continue
    }
    const groupTabs = tabs.filter((tab) => tab.groupId === id)
    const entityIds = new Set(groupTabs.map((tab) => tab.entityId))
    for (const ref of getGroupVisibleTabOrder(
      group,
      groupTabs,
      entityIds,
      entityIds,
      entityIds,
      new Set(groupTabs.map((tab) => tab.id))
    )) {
      if (ref.type === 'terminal') {
        add(ref.id)
      }
      if (ref.type === 'agent-session' && ref.tabId !== undefined) {
        add(ref.tabId)
      }
    }
  }
  // Restored workspaces can render the legacy strip before groups hydrate.
  legacyOrder.forEach(add)
  const ordered = [...agents].sort(
    (a, b) =>
      (ranks.get(a.tab.id) ?? Number.MAX_SAFE_INTEGER) -
      (ranks.get(b.tab.id) ?? Number.MAX_SAFE_INTEGER)
  )
  // Preserve the established order within a tab and for rows without a visible tab.
  return ordered.every((row, index) => row === agents[index]) ? agents : ordered
}
