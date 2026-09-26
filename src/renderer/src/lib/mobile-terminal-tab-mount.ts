import type { BackgroundMountTerminalWorktreeDetail } from '@/constants/terminal'
import type { AppState } from '@/store/types'
import {
  resolveTerminalPtyPaneOwnership,
  type TerminalPtyPaneOwnerState
} from './terminal-pty-pane-owner'
import { findTerminalTabRow } from './terminal-tab-row-lookup'

export type MobileTerminalTabMountState = TerminalPtyPaneOwnerState &
  Pick<AppState, 'tabsByWorktree'>

export type MobileTerminalTabMountRequest = {
  worktreeId: string
  tabId?: string
  ptyId?: string
}

type MobileTerminalTabMountOptions = {
  isTabMounted?: (tabId: string, worktreeId?: string) => boolean
}

/**
 * Why scoped here and not in the lookup: ownership is worktree-agnostic, but this caller mounts
 * the tab under the requested worktree, so a row filed elsewhere is not a usable answer (#8597).
 */
function resolvePtyOwnerTabIdInWorktree(
  state: MobileTerminalTabMountState,
  worktreeId: string,
  ptyId: string
): string | null {
  const ownership = resolveTerminalPtyPaneOwnership(state, ptyId)
  if (ownership.kind !== 'owned') {
    return null
  }
  const row = findTerminalTabRow(state, ownership.owner.tabId)
  return row?.worktreeId === worktreeId ? ownership.owner.tabId : null
}

/** Why: exact-tab planning prevents a stale ptyId from mounting every saved xterm (#8597). */
export function planMobileTerminalTabMount(
  state: MobileTerminalTabMountState,
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
      ? resolvePtyOwnerTabIdInWorktree(state, request.worktreeId, request.ptyId)
      : null
  // Why: replaying the background-mount event for a live pane restarts its
  // three-second hidden measurement window on every mobile reconnect.
  return tabId && !options.isTabMounted?.(tabId, request.worktreeId)
    ? { worktreeId: request.worktreeId, tabIds: [tabId] }
    : null
}
