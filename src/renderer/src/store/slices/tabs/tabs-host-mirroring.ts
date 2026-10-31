import type { AppState } from '../../types'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import { findTabAndWorktree } from '../tab-group-state'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { locateTerminalTab } from '../../terminals/terminal-tab-location'

/** Mirror host-tracked fields onto terminal rows: reconciliation derives unified fields there and recovery reads row ownership, so unified-only writes revert or remount hidden chat. */
export function patchTerminalTabRow(
  tabsByWorktree: Record<string, TerminalTab[]>,
  tabId: string,
  patch: Partial<Pick<TerminalTab, 'isPinned' | 'viewMode'>>
): Partial<Pick<AppState, 'tabsByWorktree'>> {
  const location = locateTerminalTab(tabsByWorktree, tabId)
  if (!location) {
    return {}
  }
  const nextTabs = tabsByWorktree[location.worktreeId].slice()
  nextTabs[location.index] = { ...location.tab, ...patch }
  return { tabsByWorktree: { ...tabsByWorktree, [location.worktreeId]: nextTabs } }
}

// Mirror terminal pins so reconnect/peers retain them; dynamic import avoids a static store-to-runtime dependency.
export function mirrorTabPinnedToHost(state: AppState, tabId: string, isPinned: boolean): void {
  const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
  // Why: only terminal tab pins are persisted host-side today (browser/editor in #5729); skip the RPC for other types.
  if (
    !found ||
    found.tab.contentType !== 'terminal' ||
    !runtimeEnvironmentIdOrLocalUnlessTwin(state, found.worktreeId)
  ) {
    return
  }
  const worktreeId = found.worktreeId
  void import('@/runtime/web-runtime-terminal-actions').then(({ setWebRuntimeTabProps }) =>
    setWebRuntimeTabProps({ worktreeId, tabId, isPinned })
  )
}

// Mirror only action-originated viewMode changes; applying host snapshots must not echo RPCs.
export function mirrorTabViewModeToHost(
  state: AppState,
  tabId: string,
  viewMode: 'terminal' | 'chat'
): void {
  const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
  // Only terminal viewMode persists host-side; other kinds need no RPC.
  if (
    !found ||
    found.tab.contentType !== 'terminal' ||
    !runtimeEnvironmentIdOrLocalUnlessTwin(state, found.worktreeId)
  ) {
    return
  }
  const worktreeId = found.worktreeId
  void import('@/runtime/web-runtime-terminal-actions').then(({ setWebRuntimeTabProps }) =>
    setWebRuntimeTabProps({ worktreeId, tabId, viewMode })
  )
}
