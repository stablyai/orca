/** Structured subjects pair tab/session ids one-to-one; groupId is the unified tab id, never its enclosing split-layout group. */
import type { useAppStore } from '@/store'
import type {
  AgentAttentionSubject,
  AgentAttentionSurface,
  AgentAttentionSurfaceAdmission,
  AgentAttentionSurfaceSubject
} from '@/attention/agent-attention-contract'
import { isTabOnScreen, isWorkspaceOnScreen } from '@/attention/agent-auto-ack-targets'
import { isWorkspaceNotificationMutedBySidebarFilters } from '@/attention/hidden-workspace-notification-mute'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import type { StructuredTab } from '../status/structured-agent-session-tabs'
import {
  findTabByChatPaneKey,
  isStructuredTab
} from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import { readBotBackgroundSessionTabs } from '../../../bots/bot-background-sessions'
import { chatPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'

type StoreSnapshot = ReturnType<typeof useAppStore.getState>

function structuredTabsIn(state: StoreSnapshot, workspaceId: string): StructuredTab[] {
  return [
    ...(state.unifiedTabsByWorktree[workspaceId] ?? []).filter(isStructuredTab),
    // A bot's tabless sessions still notify; only a group member's open room shows one.
    ...readBotBackgroundSessionTabs().filter((tab) => tab.worktreeId === workspaceId)
  ]
}

/** Resolve a subject only while its tab still owns that session; rebound tabs reject old keys. */
function findSubjectTab(
  state: StoreSnapshot,
  workspaceId: string,
  surfaceKey: string
): StructuredTab | null {
  const tab = findTabByChatPaneKey(structuredTabsIn(state, workspaceId), surfaceKey)
  if (!tab || chatPaneKey(tab.entityId) !== surfaceKey) {
    return null
  }
  return tab
}

function admitStructuredSession(
  state: StoreSnapshot,
  subject: AgentAttentionSurfaceSubject
): AgentAttentionSurfaceAdmission {
  const tab = findTabByChatPaneKey(structuredTabsIn(state, subject.workspaceId), subject.surfaceKey)
  if (!tab) {
    return { admitted: false, cause: 'unknown-surface' }
  }
  return chatPaneKey(tab.entityId) === subject.surfaceKey
    ? { admitted: true, groupId: tab.id }
    : { admitted: false, cause: 'superseded-surface' }
}

function isViewedStructuredTab(
  state: StoreSnapshot,
  workspaceId: string,
  tab: StructuredTab
): boolean {
  return isTabOnScreen(state, workspaceId, tab.id, 'structured')
}

export function createStructuredAttentionSurface(state: StoreSnapshot): AgentAttentionSurface {
  return {
    // Without a renderer PTY, a tab still bound to the host session is this process’s liveness evidence.
    hasLiveSession: (subject: AgentAttentionSubject) =>
      subject.surfaceKey === undefined
        ? structuredTabsIn(state, subject.workspaceId).length > 0
        : findSubjectTab(state, subject.workspaceId, subject.surfaceKey) !== null,
    admitSurface: (subject) => admitStructuredSession(state, subject),
    isSurfaceViewed: (subject) => {
      const tab = findSubjectTab(state, subject.workspaceId, subject.surfaceKey)
      return tab !== null && isViewedStructuredTab(state, subject.workspaceId, tab)
    },
    // Why: in-app selection alone is not viewing — a backgrounded Orca, Settings or an away user still need unread.
    isWorkspaceViewed: (workspaceId) => isWorkspaceOnScreen(state, workspaceId),
    isWorkspaceActive: (workspaceId) => state.activeWorktreeId === workspaceId,
    isWorkspaceMuted: (workspaceId) =>
      isWorkspaceNotificationMutedBySidebarFilters(state, readRuntimeStatuses(), workspaceId),
    resolveViewedSubjectKey: (groupId) => {
      // A stand-in is viewed through the room that shows its session.
      const tab = [
        ...Object.values(state.unifiedTabsByWorktree).flat(),
        ...readBotBackgroundSessionTabs()
      ].find((candidate) => candidate.id === groupId)
      return tab && isStructuredTab(tab) ? chatPaneKey(tab.entityId) : null
    }
  }
}
