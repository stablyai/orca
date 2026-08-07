import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/types'
import { createBrowserUuid } from '@/lib/browser-uuid'

/* Why: hydration reads a persisted session that no longer guarantees referential
 * integrity — workspace-session salvage drops individual corrupt records, so a
 * group can vanish from under its tabs and a layout from under its groups. These
 * repairs re-home what is left; without them the surviving tabs render nowhere
 * and no downstream pass notices. */

export function layoutSpanningGroups(groups: readonly TabGroup[]): TabGroupLayoutNode {
  return groups.slice(1).reduce<TabGroupLayoutNode>(
    (first, group) => ({
      type: 'split',
      direction: 'horizontal',
      first,
      second: { type: 'leaf', groupId: group.id }
    }),
    { type: 'leaf', groupId: groups[0].id }
  )
}

/** Why: a tab in no group is unreachable, yet still counts toward
 *  renderableTabCount, so the auto-create-first-terminal rescue never fires and
 *  the worktree body renders blank. Session salvage can drop a corrupt group
 *  record while its tabs survive, and a stale tabOrder strands tabs the same way
 *  — re-home them rather than lose the workspace. */
export function adoptGrouplessTabs(
  tabsByWorktree: Record<string, Tab[]>,
  groupsByWorktree: Record<string, TabGroup[]>,
  activeGroupIdByWorktree: Record<string, string>,
  layoutByWorktree: Record<string, TabGroupLayoutNode>
): void {
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const groups = groupsByWorktree[worktreeId] ?? []
    const grouped = new Set(groups.flatMap((group) => group.tabOrder))
    const orphanIds = tabs.filter((tab) => !grouped.has(tab.id)).map((tab) => tab.id)
    if (orphanIds.length === 0) {
      continue
    }
    const host: TabGroup = groups[0] ?? {
      id: createBrowserUuid(),
      worktreeId,
      activeTabId: null,
      tabOrder: [],
      recentTabIds: []
    }
    const adopted: TabGroup = {
      ...host,
      tabOrder: [...host.tabOrder, ...orphanIds],
      activeTabId: host.activeTabId ?? orphanIds[0]
    }
    const orphaned = new Set(orphanIds)
    tabsByWorktree[worktreeId] = tabs.map((tab) =>
      orphaned.has(tab.id) ? { ...tab, groupId: adopted.id } : tab
    )
    groupsByWorktree[worktreeId] = [adopted, ...groups.slice(1)]
    activeGroupIdByWorktree[worktreeId] ??= adopted.id
    layoutByWorktree[worktreeId] ??= { type: 'leaf', groupId: adopted.id }
  }
}
