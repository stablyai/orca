import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { collectHeaderRevealPlacements } from '../../../../../../shared/sidebar-list/header-reveal-placement'
import {
  renderSidebarFeedRows,
  type planSidebarFeedRows,
  type SidebarFeedView
} from '../../../../../../shared/sidebar-list/sidebar-feed-rows'

const UNCOLLAPSED: ReadonlySet<string> = new Set()

/** Where hidden rows would land if their headers opened; computed only while a reveal is pending. */
export function useHeaderRevealPlacements(
  planned: ReturnType<typeof planSidebarFeedRows>,
  view: SidebarFeedView
) {
  const revealPending = useAppStore((state) =>
    Boolean(state.pendingRevealSidebarRow || state.pendingRevealWorktree)
  )
  return useMemo(
    () =>
      revealPending
        ? collectHeaderRevealPlacements(
            renderSidebarFeedRows(planned, view, UNCOLLAPSED).sectionRows,
            planned.plan.headerRevealPaths
          )
        : undefined,
    [planned, view, revealPending]
  )
}
