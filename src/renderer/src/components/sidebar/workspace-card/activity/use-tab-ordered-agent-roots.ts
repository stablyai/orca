import { useMemo } from 'react'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import type { Tab, TabGroup } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { orderByVisibleTabs } from './worktree-agent-visible-tab-order'

const NO_TABS: Tab[] = []
const NO_GROUPS: TabGroup[] = []
const NO_ORDER: string[] = []

/** A card's root agent keys in tab strip order, so dragging or pinning a tab moves its agents. */
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
