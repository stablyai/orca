import { reorderWithinDisplayedOrder } from '@/components/tab-group/drag/tab-drop-displayed-order'
import type { TabGroup } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { visibleAgentTabs, type WorktreeTabLayout } from './worktree-agent-visible-tab-order'

export type AgentRowDropSide = 'before' | 'after'

/** The tab strip reorder a sidebar agent row drop asks for. */
export type AgentRowTabDrop = { tabId: string; groupId: string; tabOrder: string[] }

/**
 * The group order after dropping one agent row beside another, or null when the drop is refused or moves nothing.
 * Rows move their whole tab, so agents sharing a tab (split panes) travel together. Rules: both rows need a visible
 * tab; the tabs must share a group (a sidebar drop never moves a tab between split groups); and the dragged tab stays
 * in its pinned or unpinned run, clamped to that run's edge.
 *
 * @param draggedTabRef The dragged row's tab id, as `orderByVisibleTabs` matches rows to tabs.
 * @param displayedOrderOf The group's order as its tab bar draws it.
 */
export function agentRowDropTabOrder({
  draggedTabRef,
  targetTabRef,
  side,
  tabLayout,
  displayedOrderOf = (group) => group.tabOrder
}: {
  draggedTabRef: string | undefined
  targetTabRef: string | undefined
  side: AgentRowDropSide
  tabLayout: WorktreeTabLayout
  displayedOrderOf?: (group: TabGroup) => string[]
}): AgentRowTabDrop | null {
  if (draggedTabRef === undefined || targetTabRef === undefined) {
    return null
  }
  const visible = visibleAgentTabs(tabLayout)
  const dragged = visible.get(draggedTabRef)?.tab
  const target = visible.get(targetTabRef)?.tab
  if (!dragged || !target || dragged.id === target.id || dragged.groupId !== target.groupId) {
    return null
  }
  const group = tabLayout.groups.find((candidate) => candidate.id === dragged.groupId)
  if (!group) {
    return null
  }
  const displayed = displayedOrderOf(group)
  const moved = reorderWithinDisplayedOrder(
    displayed,
    dragged.id,
    target.id,
    side === 'before' ? 'left' : 'right'
  )
  if (!moved) {
    return null
  }
  const pinnedIds = new Set(tabLayout.tabs.filter((tab) => tab.isPinned).map((tab) => tab.id))
  const tabOrder = [
    ...moved.filter((id) => pinnedIds.has(id)),
    ...moved.filter((id) => !pinnedIds.has(id))
  ]
  return tabOrder.every((id, index) => id === displayed[index])
    ? null
    : { tabId: dragged.id, groupId: group.id, tabOrder }
}
