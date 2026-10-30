/** Structured subjects pair tab/session ids one-to-one; groupId is the unified tab id, never its enclosing split-layout group. */
import type { useAppStore } from '@/store'
import type {
  AgentAttentionSubject,
  AgentAttentionSurface,
  AgentAttentionSurfaceAdmission,
  AgentAttentionSurfaceSubject
} from '@/attention/agent-attention-contract'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { isTabOnScreen, isWorkspaceOnScreen } from '@/hooks/agent-auto-ack-targets'
import { isWorkspaceNotificationMutedBySidebarFilters } from '@/attention/hidden-workspace-notification-mute'
import type { StructuredTab } from './structured-agent-session-tabs'
import { isStructuredTab } from '../../../../shared/structured-agent-session-tab'

type StoreSnapshot = ReturnType<typeof useAppStore.getState>

function structuredTabsIn(state: StoreSnapshot, workspaceId: string): StructuredTab[] {
  return (state.unifiedTabsByWorktree[workspaceId] ?? []).filter(isStructuredTab)
}

/** Resolve a subject only while its tab still owns that session; rebound tabs reject old keys. */
function findSubjectTab(
  state: StoreSnapshot,
  workspaceId: string,
  surfaceKey: string
): StructuredTab | null {
  const parsed = parsePaneKey(surfaceKey)
  if (!parsed) {
    return null
  }
  const tab = structuredTabsIn(state, workspaceId).find(
    (candidate) => candidate.id === parsed.tabId
  )
  if (!tab || structuredAgentSessionPaneKey(tab.id, tab.entityId) !== surfaceKey) {
    return null
  }
  return tab
}

function admitStructuredSession(
  state: StoreSnapshot,
  subject: AgentAttentionSurfaceSubject
): AgentAttentionSurfaceAdmission {
  const parsed = parsePaneKey(subject.surfaceKey)
  if (!parsed) {
    return { admitted: false, cause: 'unknown-surface' }
  }
  const tab = structuredTabsIn(state, subject.workspaceId).find(
    (candidate) => candidate.id === parsed.tabId
  )
  if (!tab) {
    return { admitted: false, cause: 'unknown-surface' }
  }
  return structuredAgentSessionPaneKey(tab.id, tab.entityId) === subject.surfaceKey
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
      isWorkspaceNotificationMutedBySidebarFilters(state, workspaceId),
    resolveViewedSubjectKey: (groupId) => {
      const tab = Object.values(state.unifiedTabsByWorktree)
        .flat()
        .find((candidate) => candidate.id === groupId)
      return tab && isStructuredTab(tab)
        ? structuredAgentSessionPaneKey(tab.id, tab.entityId)
        : null
    }
  }
}
