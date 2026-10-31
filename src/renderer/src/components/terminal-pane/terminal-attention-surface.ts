/** Binds provider-neutral attention policy to terminal state; owns PTY/leaf/layout admission checks. */
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
import { isTabOnScreen, isWorkspaceOnScreen } from '@/hooks/agent-auto-ack-targets'
import { isWorkspaceNotificationMutedBySidebarFilters } from '@/attention/hidden-workspace-notification-mute'

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
  // Late completion from a closed split must not notify just because a sibling pane remains live.
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

// Why the whole tab: every split pane of the tab on screen is read, so none earns a marker.
function isViewedTerminalPane(state: StoreSnapshot, workspaceId: string, paneKey: string): boolean {
  const tabId = getPaneKeyTabId(paneKey)
  return tabId !== null && isTabOnScreen(state, workspaceId, tabId, 'terminal')
}

export function createTerminalAttentionSurface(state: StoreSnapshot): AgentAttentionSurface {
  return {
    // Shutdown clears PTY IDs before async kills; checking liveness here rejects every late timer/closure source.
    hasLiveSession: (subject: AgentAttentionSubject) =>
      hasLivePtyForNotification(state, subject.workspaceId, subject.surfaceKey),
    admitSurface: (subject, liveness) => admitTerminalPane(state, subject, liveness),
    isSurfaceViewed: (subject) =>
      isViewedTerminalPane(state, subject.workspaceId, subject.surfaceKey),
    // Why: in-app selection alone is not viewing — a backgrounded Orca, Settings or an away user still need unread.
    isWorkspaceViewed: (workspaceId) => isWorkspaceOnScreen(state, workspaceId),
    isWorkspaceActive: (workspaceId) => state.activeWorktreeId === workspaceId,
    isWorkspaceMuted: (workspaceId) =>
      isWorkspaceNotificationMutedBySidebarFilters(state, workspaceId),
    resolveViewedSubjectKey: (groupId) => resolveViewedPaneKey(state, groupId)
  }
}
