import { getGroupVisibleTabOrder } from '@/lib/workspace/tabs/order/group-tab-order'
import { collectLayoutGroupIds } from '@/runtime/web-session-tabs-sync/placement/tab-group-layout-tree'
import type {
  Tab,
  TabGroup,
  TabGroupLayoutNode
} from '../../../../../../shared/workspace-layout/tab-groups/tab-types'

/** One workspace's tab state, as the tab strips render it. */
export type WorktreeTabStrip = {
  tabs: readonly Tab[]
  groups: readonly TabGroup[]
  layout: TabGroupLayoutNode | undefined
  legacyOrder: readonly string[]
}

const NO_IDS: ReadonlySet<string> = new Set()

function rankVisibleTabs({ tabs, groups, layout, legacyOrder }: WorktreeTabStrip) {
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
    const terminalIds = new Set(groupTabs.map((tab) => tab.entityId))
    for (const ref of getGroupVisibleTabOrder(group, groupTabs, terminalIds, NO_IDS, NO_IDS)) {
      // Agent rows carry the terminal's entity id, but an agent-session tab's own id.
      if (ref.type === 'terminal') {
        add(ref.id)
      } else if (ref.type === 'agent-session' && ref.tabId) {
        add(ref.tabId)
      }
    }
  }
  // A restored workspace renders the legacy strip before its groups hydrate.
  legacyOrder.forEach(add)
  return ranks
}

/**
 * Orders items by where their tab sits in the workspace's tab strips: split groups in layout
 * order, then each group's visible tab order. Items in one tab, and items with no visible tab
 * (which go last), keep their incoming order. Returns `items` itself when nothing moves.
 */
export function orderByVisibleTabs<T>(
  items: readonly T[],
  tabIdOf: (item: T) => string | undefined,
  strip: WorktreeTabStrip
): readonly T[] {
  const ranks = rankVisibleTabs(strip)
  const rankOf = (item: T): number => {
    const tabId = tabIdOf(item)
    return (tabId === undefined ? undefined : ranks.get(tabId)) ?? Number.MAX_SAFE_INTEGER
  }
  const ordered = [...items].sort((a, b) => rankOf(a) - rankOf(b))
  return ordered.every((item, index) => item === items[index]) ? items : ordered
}
