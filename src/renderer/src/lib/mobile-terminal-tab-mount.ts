import type { AppState } from '@/store/types'
import type { BackgroundMountTerminalWorktreeDetail } from '@/constants/terminal'
import { resolveTerminalTabIdForPtyId } from './terminal-tab-for-pty-id'

export type MobileTerminalTabMountRequest = {
  worktreeId: string
  tabId?: string
  ptyId?: string
}

type MobileTerminalTabMountOptions = {
  isTabMounted?: (tabId: string) => boolean
}

/** Why: exact-tab planning prevents a stale ptyId from mounting every saved xterm (#8597). */
export function planMobileTerminalTabMount(
  state: Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId'>,
  request: MobileTerminalTabMountRequest,
  options: MobileTerminalTabMountOptions = {}
): BackgroundMountTerminalWorktreeDetail | null {
  if (!request.worktreeId) {
    return null
  }
  const requestedTabExists = request.tabId
    ? (state.tabsByWorktree[request.worktreeId] ?? []).some((tab) => tab.id === request.tabId)
    : false
  // Why: stale real-tab handles must fail closed like stale synthetic handles;
  // otherwise they mount and measure a hidden worktree with no pane to recover.
  const tabId = request.tabId
    ? requestedTabExists
      ? request.tabId
      : null
    : request.ptyId
      ? resolveTerminalTabIdForPtyId(state, request.worktreeId, request.ptyId)
      : null
  // Why: replaying the background-mount event for a live pane restarts its
  // three-second hidden measurement window on every mobile reconnect.
  return tabId && !options.isTabMounted?.(tabId)
    ? { worktreeId: request.worktreeId, tabIds: [tabId] }
    : null
}
