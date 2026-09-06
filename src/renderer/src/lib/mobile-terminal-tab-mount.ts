import type { BackgroundMountTerminalWorktreeDetail } from '@/constants/terminal'
import {
  isInboundMessageTabMount,
  type TerminalTabMountIntent
} from '../../../shared/terminal-tab-mount-intent'
import { makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import {
  resolveTerminalTabIdForPtyId,
  type TerminalTabPtyOwnershipState
} from './terminal-tab-for-pty-id'

export type MobileTerminalTabMountRequest = {
  worktreeId: string
  tabId?: string
  ptyId?: string
  paneKey?: string
  intent?: TerminalTabMountIntent
}

type MobileTerminalTabMountOptions = {
  isTabMounted?: (tabId: string, worktreeId?: string) => boolean
}

export type MobileTerminalTabMountResolution =
  | { kind: 'mount'; detail: BackgroundMountTerminalWorktreeDetail }
  | { kind: 'already-mounted'; tabId: string }
  | null

/** Why: exact-tab planning prevents a stale ptyId from mounting every saved xterm (#8597). */
export function resolveMobileTerminalTabMount(
  state: TerminalTabPtyOwnershipState,
  request: MobileTerminalTabMountRequest,
  options: MobileTerminalTabMountOptions = {}
): MobileTerminalTabMountResolution {
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
  if (!tabId) {
    return null
  }
  const requestedPane = request.paneKey ? parsePaneKey(request.paneKey) : null
  if (isInboundMessageTabMount(request.intent) && request.paneKey && !requestedPane) {
    return null
  }
  // Why: replaying the background-mount event for a live pane restarts its
  // three-second hidden measurement window on every mobile reconnect. The
  // caller still needs to know the tab resolved: a slept pane whose tab is
  // still mounted is woken in place, not by mounting (its mount is a no-op).
  return options.isTabMounted?.(tabId, request.worktreeId)
    ? { kind: 'already-mounted', tabId }
    : {
        kind: 'mount',
        detail: {
          worktreeId: request.worktreeId,
          tabIds: [tabId],
          ...(isInboundMessageTabMount(request.intent) && requestedPane
            ? {
                coldRestorePaneKeysByTabId: {
                  [tabId]: [makePaneKey(tabId, requestedPane.leafId)]
                }
              }
            : {})
        }
      }
}

export function planMobileTerminalTabMount(
  state: TerminalTabPtyOwnershipState,
  request: MobileTerminalTabMountRequest,
  options: MobileTerminalTabMountOptions = {}
): BackgroundMountTerminalWorktreeDetail | null {
  const resolution = resolveMobileTerminalTabMount(state, request, options)
  return resolution?.kind === 'mount' ? resolution.detail : null
}
