/**
 * Terminal implementation of the provider-neutral attention surface.
 *
 * This module is the only place the PTY/leaf/layout admission predicates are called from;
 * the attention policy in `@/attention` reaches terminal state exclusively through it.
 */
import type { useAppStore } from '@/store'
import type {
  AgentAttentionSubject,
  AgentAttentionSurface,
  AgentAttentionSurfaceAdmission,
  AgentAttentionSurfaceSubject,
  AgentAttentionLiveness
} from '@/attention/agent-attention-contract'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import {
  getPaneKeyTabId,
  hasLivePtyForNotification,
  isCurrentKnownPaneKey,
  isCurrentLivePaneKey
} from './terminal-notification-state'
import { isOrcaWindowForegroundFocused } from './terminal-notification-pane-visibility'
import { isTabOnVisibleSurface } from '@/hooks/agent-auto-ack-targets'
import { collectTerminalAttentionRemainder } from '@/lib/workspace-attention-remainder'

type StoreSnapshot = ReturnType<typeof useAppStore.getState>

function admitTerminalPane(
  state: StoreSnapshot,
  subject: AgentAttentionSurfaceSubject,
  liveness: AgentAttentionLiveness
): AgentAttentionSurfaceAdmission {
  const tabId = getPaneKeyTabId(subject.surfaceKey)
  if (tabId === null) {
    return { admitted: false, cause: 'unknown-surface' }
  }
  // Why: delayed completion hooks from a closed split pane can arrive while another pane in
  // the tab is still live; stale leaf completions must not create unread or OS notifications.
  const isCurrentPane = liveness.hasLiveSession
    ? isCurrentLivePaneKey(state, subject.workspaceId, subject.surfaceKey)
    : isCurrentKnownPaneKey(state, subject.workspaceId, subject.surfaceKey)
  return isCurrentPane
    ? { admitted: true, groupId: tabId }
    : { admitted: false, cause: 'superseded-surface' }
}

function resolveViewedPaneKey(state: StoreSnapshot, tabId: string): string | null {
  const leafId = state.terminalLayoutsByTabId[tabId]?.activeLeafId ?? null
  return leafId !== null && isTerminalLeafId(leafId) ? makePaneKey(tabId, leafId) : null
}

// Why: split panes hide their inactive leaves, so only the active leaf of a visible tab is viewed —
// the same pane auto-ack resolves as the one to acknowledge.
function isViewedTerminalPane(state: StoreSnapshot, workspaceId: string, paneKey: string): boolean {
  const tabId = getPaneKeyTabId(paneKey)
  return (
    tabId !== null &&
    isOrcaWindowForegroundFocused() &&
    isTabOnVisibleSurface(state, workspaceId, tabId, 'terminal') &&
    resolveViewedPaneKey(state, tabId) === paneKey
  )
}

/** Binds the neutral surface contract to one store snapshot. */
export function createTerminalAttentionSurface(state: StoreSnapshot): AgentAttentionSurface {
  return {
    // Why: shutdownWorktreeTerminals clears ptyIdsByTabId synchronously before killing PTYs
    // asynchronously, so a late timer or accumulated-closure callback still dispatches.
    // Checking liveness here catches every phantom source instead of cancelling each one.
    hasLiveSession: (subject: AgentAttentionSubject) =>
      hasLivePtyForNotification(state, subject.workspaceId, subject.surfaceKey),
    admitSurface: (subject, liveness) => admitTerminalPane(state, subject, liveness),
    isSurfaceViewed: (subject) =>
      isViewedTerminalPane(state, subject.workspaceId, subject.surfaceKey),
    // Why: activeWorktreeId is in-app selection only. A backgrounded Orca still needs unread.
    isWorkspaceViewed: (workspaceId) =>
      state.activeWorktreeId === workspaceId && isOrcaWindowForegroundFocused(),
    isWorkspaceActive: (workspaceId) => state.activeWorktreeId === workspaceId,
    resolveViewedSubjectKey: (groupId) => resolveViewedPaneKey(state, groupId),
    collectWorkspaceAttentionRemainder: (workspaceId) =>
      collectTerminalAttentionRemainder(state, workspaceId)
  }
}
