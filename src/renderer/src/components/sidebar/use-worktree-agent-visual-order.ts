import { useMemo } from 'react'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { useAppStore } from '@/store'
import { orderAgentsByVisibleTabs } from './worktree-agent-visual-order'
import type { Tab, TabGroup } from '../../../../shared/tab-types'

const EMPTY_TABS: Tab[] = []
const EMPTY_GROUPS: TabGroup[] = []
const EMPTY_ORDER: string[] = []

export function useWorktreeAgentVisualOrder(
  worktreeId: string,
  agents: DashboardAgentRow[]
): DashboardAgentRow[] {
  const tabs = useAppStore((s) => s.unifiedTabsByWorktree?.[worktreeId] ?? EMPTY_TABS)
  const groups = useAppStore((s) => s.groupsByWorktree?.[worktreeId] ?? EMPTY_GROUPS)
  const layout = useAppStore((s) => s.layoutByWorktree?.[worktreeId])
  const legacyOrder = useAppStore((s) => s.tabBarOrderByWorktree?.[worktreeId] ?? EMPTY_ORDER)
  return useMemo(
    () => orderAgentsByVisibleTabs(agents, tabs, groups, layout, legacyOrder),
    [agents, tabs, groups, layout, legacyOrder]
  )
}
