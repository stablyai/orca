import type { AppState } from '../../types'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import { findTabAndWorktree } from '../tab-group-state'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'

export function patchTerminalTabPinned(
  tabsByWorktree: Record<string, TerminalTab[]>,
  worktreeId: string,
  tabId: string,
  isPinned: boolean
): Partial<Pick<AppState, 'tabsByWorktree'>> {
  const tabs = tabsByWorktree[worktreeId]
  if (!tabs?.some((tab) => tab.id === tabId)) {
    return {}
  }
  return {
    tabsByWorktree: {
      ...tabsByWorktree,
      [worktreeId]: tabs.map((tab) => (tab.id === tabId ? { ...tab, isPinned } : tab))
    }
  }
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
