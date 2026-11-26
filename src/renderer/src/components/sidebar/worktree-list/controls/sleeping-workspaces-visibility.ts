import { useAppStore } from '@/store'
import { getActiveSidebarWorkspaceId } from '../../../../../../shared/workspace/identity/workspace-scope'
import { findOnScreenActiveWorktreeOption } from '../navigation/mounted-row-reveal'
import {
  getElementScrollBounds,
  getRevealTargetBounds
} from '../navigation/worktree-sidebar-reveal'
import { clearSidebarFilters, selectSidebarFilterState } from './sidebar-filter-actions'

// Why: the reveal also scrolls the outer sidebar viewport, so a row the user scrolled past
// (e.g. down to Bots on a short sidebar) must not pull that viewport back.
function isInOuterSidebarViewport(scroller: HTMLElement, option: HTMLElement): boolean {
  const outer = scroller.closest<HTMLElement>('[data-sidebar-content-viewport]')
  if (!outer) {
    return true
  }
  const row = getRevealTargetBounds(outer, option)
  if (!row) {
    return false
  }
  const list = getElementScrollBounds(outer, scroller)
  const start = Math.max(row.start, list.start, outer.scrollTop)
  const end = Math.min(row.end, list.end, outer.scrollTop + outer.clientHeight)
  return end > start
}

function findVisibleActiveRowKey(activeId: string): string | undefined {
  for (const scroller of document.querySelectorAll<HTMLElement>('[data-worktree-sidebar]')) {
    if (scroller.clientHeight === 0) {
      continue
    }
    const option = findOnScreenActiveWorktreeOption(scroller, activeId)
    if (option && isInOuterSidebarViewport(scroller, option)) {
      return option.dataset.worktreeRowKey
    }
  }
  return undefined
}

// Why: newly shown sleeping rows above an on-screen active row push it out of view (#47643).
function keepActiveRowInView(showsSleeping: boolean, change: () => void): void {
  const state = useAppStore.getState()
  const activeId = getActiveSidebarWorkspaceId(state.activeWorkspaceKey, state.activeWorktreeId)
  const rowKey =
    showsSleeping && !state.showSleepingWorkspaces && activeId
      ? findVisibleActiveRowKey(activeId)
      : undefined
  change()
  if (activeId && rowKey) {
    // The virtualizer-backed reveal scrolls only as far as needed, even after the row unmounts.
    state.revealWorktreeInSidebar(activeId, { rowKey, behavior: 'auto' })
  }
}

export function setShowSleepingWorkspacesKeepingActiveRow(show: boolean): void {
  keepActiveRowInView(show, () => useAppStore.getState().setShowSleepingWorkspaces(show))
}

export function clearSidebarFiltersKeepingActiveRow(): void {
  keepActiveRowInView(true, () => {
    const state = useAppStore.getState()
    clearSidebarFilters(selectSidebarFilterState(state), state)
  })
}
