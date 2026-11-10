import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { getLocalExecutionHostLabel } from '../../../../../../shared/execution-host'
import { collectHeaderRevealPlacements } from '../../../../../../shared/sidebar-list/header-reveal-placement'
import { addHostSectionRows } from '../../../../../../shared/sidebar-list/host-section-rows'
import type { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'

type HostSectionArgs = Pick<
  Parameters<typeof addHostSectionRows>[0],
  'hostOptions' | 'workspaceHostScope' | 'visibleWorkspaceHostIds' | 'defaultHostId'
>

/** Where hidden rows would land if their headers opened; computed only while a reveal is pending. */
export function useSectionHeaderRevealPlacements(
  rowPlan: ReturnType<typeof planSidebarRows>,
  { hostOptions, workspaceHostScope, visibleWorkspaceHostIds, defaultHostId }: HostSectionArgs
) {
  const revealPending = useAppStore((state) =>
    Boolean(state.pendingRevealSidebarRow || state.pendingRevealWorktree)
  )
  return useMemo(
    () =>
      revealPending
        ? collectHeaderRevealPlacements(
            addHostSectionRows({
              rows: rowPlan.render(new Set()),
              hostOptions,
              workspaceHostScope,
              visibleWorkspaceHostIds,
              defaultHostId,
              localHostLabel: getLocalExecutionHostLabel(),
              preferProjectGrouping: true
            }),
            rowPlan.headerRevealPaths
          )
        : undefined,
    [
      revealPending,
      rowPlan,
      hostOptions,
      workspaceHostScope,
      visibleWorkspaceHostIds,
      defaultHostId
    ]
  )
}
