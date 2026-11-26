import { useMemo } from 'react'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import type { Tab, TabGroup } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { orderByVisibleTabs } from './worktree-agent-visible-tab-order'

// Selectors return these shared empties: a fresh [] reads as a change on every store update.
const NO_TABS: Tab[] = []
const NO_GROUPS: TabGroup[] = []
const NO_ORDER: string[] = []

/**
 * Orders a workspace card's root agent keys by where their tabs sit in the workspace's tab
 * strips, so dragging or pinning a tab moves its agent rows. The hook subscribes to the
 * workspace's tabs, tab groups, layout and the agent status projection.
 *
 * @param worktreeId The workspace whose tab strips set the order.
 * @param roots Root agent keys in projection order. Keys in one tab keep this order. Keys whose
 *   tab is not visible go last, also in this order.
 * @returns `roots` itself when the tab order moves no key.
 */
export function useTabOrderedAgentRoots(
  worktreeId: string,
  roots: readonly string[]
): readonly string[] {
  const projection = useAppStateValue((s) => s.agentStatusByPaneKey.projection)
  const tabs = useAppStateValue((s) => s.unifiedTabsByWorktree[worktreeId] ?? NO_TABS)
  const groups = useAppStateValue((s) => s.groupsByWorktree[worktreeId] ?? NO_GROUPS)
  const layout = useAppStateValue((s) => s.layoutByWorktree[worktreeId])
  const legacyOrder = useAppStateValue((s) => s.tabBarOrderByWorktree[worktreeId] ?? NO_ORDER)
  return useMemo(
    () =>
      orderByVisibleTabs(roots, (key) => projection.row(key)?.tab.id, {
        tabs,
        groups,
        layout,
        legacyOrder
      }),
    [roots, projection, tabs, groups, layout, legacyOrder]
  )
}
