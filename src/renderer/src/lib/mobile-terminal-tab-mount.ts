import type { BackgroundMountTerminalWorktreeDetail } from '@/constants/terminal'
import {
  resolveTerminalTabIdForPtyId,
  type TerminalTabPtyOwnershipState
} from './terminal-tab-for-pty-id'

export type MobileTerminalTabMountRequest = {
  worktreeId: string
  tabId?: string
  ptyId?: string
}

type MobileTerminalTabMountOptions = {
  isTabMounted?: (tabId: string, worktreeId?: string) => boolean
}

/** Why: exact-tab planning prevents a stale ptyId from mounting every saved xterm (#8597). */
export function planMobileTerminalTabMount(
  state: TerminalTabPtyOwnershipState,
  request: MobileTerminalTabMountRequest,
  options: MobileTerminalTabMountOptions = {}
): BackgroundMountTerminalWorktreeDetail | null {
  if (!request.worktreeId) {
    return null
  }
  const requestedTabExists = request.tabId
    ? (state.tabsByWorktree[request.worktreeId] ?? []).some((tab) => tab.id === request.tabId)
    : false
  // Reject stale real-tab handles like synthetic ones or hidden workspaces mount/measure without a recoverable pane.
  const tabId = request.tabId
    ? requestedTabExists
      ? request.tabId
      : null
    : request.ptyId
      ? resolveTerminalTabIdForPtyId(state, request.worktreeId, request.ptyId)
      : null
  // Do not remount live panes on mobile reconnect or each replay restarts hidden measurement.
  return tabId && !options.isTabMounted?.(tabId, request.worktreeId)
    ? { worktreeId: request.worktreeId, tabIds: [tabId] }
    : null
}
