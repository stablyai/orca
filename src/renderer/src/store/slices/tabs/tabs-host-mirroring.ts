import type { AppState } from '../../types'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import { findTabAndWorktree } from '../tab-group-state'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { locateTerminalTab } from '../../terminals/terminal-tab-location'

/**
 * Mirror a host-tracked unified-tab field onto its terminal row, in whichever
 * bucket actually holds the row. Reconcile derives these fields from the
 * TerminalTab, so a local toggle that only patched the unified tab would be
 * recomputed away by the next host snapshot — and recovery's chat-ownership
 * guard reads the row, so a lagging row lets a hidden chat surface remount.
 */
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

// Why: pin is host-authoritative for remote-server tabs, so mirror it (like setTabColor) or it's lost on reconnect/other clients.
// Dynamic import keeps this store slice off the runtime layer.
export function mirrorTabPinnedToHost(state: AppState, tabId: string, isPinned: boolean): void {
  const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
  // Why: only terminal tab pins are persisted host-side today (browser/editor in #5729); skip the RPC for other types.
  if (
    !found ||
    found.tab.contentType !== 'terminal' ||
    !getRuntimeEnvironmentIdForWorktree(state, found.worktreeId)
  ) {
    return
  }
  const worktreeId = found.worktreeId
  void import('@/runtime/web-runtime-session').then(({ setWebRuntimeTabProps }) =>
    setWebRuntimeTabProps({ worktreeId, tabId, isPinned })
  )
}

// Why: viewMode is host-tracked like color/pin, so mirror local sets or they're lost on reconnect and to paired clients.
// Only the action path mirrors (never reconcile applying a host value), so the echoed snapshot can't re-trigger an outbound RPC.
export function mirrorTabViewModeToHost(
  state: AppState,
  tabId: string,
  viewMode: 'terminal' | 'chat'
): void {
  const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
  // Why: only terminal tab viewMode is persisted host-side; skip the RPC for other types instead of a no-op round trip.
  if (
    !found ||
    found.tab.contentType !== 'terminal' ||
    !getRuntimeEnvironmentIdForWorktree(state, found.worktreeId)
  ) {
    return
  }
  const worktreeId = found.worktreeId
  void import('@/runtime/web-runtime-session').then(({ setWebRuntimeTabProps }) =>
    setWebRuntimeTabProps({ worktreeId, tabId, viewMode })
  )
}
