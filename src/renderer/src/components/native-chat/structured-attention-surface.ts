/**
 * Structured-chat implementation of the provider-neutral attention surface.
 *
 * Addressing: the subject key is the pane key the structured status producer already publishes,
 * `structuredAgentSessionPaneKey(unifiedTabId, sessionId)`, so the container this surface reports
 * as `groupId` is the unified tab id that prefixes it — never the split-layout group the tab sits
 * in. One structured tab owns exactly one session, so tab and subject are one-to-one.
 */
import type { useAppStore } from '@/store'
import type {
  AgentAttentionRemainder,
  AgentAttentionSubject,
  AgentAttentionSurface,
  AgentAttentionSurfaceAdmission,
  AgentAttentionSurfaceSubject
} from '@/attention/agent-attention-contract'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import { findTabAndWorktree } from '@/store/slices/tab-group-state'
import { isOrcaWindowForegroundFocused } from '../terminal-pane/terminal-notification-pane-visibility'
import { isStructuredTab, type StructuredTab } from './structured-agent-session-tabs'

type StoreSnapshot = ReturnType<typeof useAppStore.getState>
const tabsByIdBySnapshot = new WeakMap<Record<string, Tab[]>, Map<string, Tab>>()

function structuredTabsIn(state: StoreSnapshot, workspaceId: string): StructuredTab[] {
  return (state.unifiedTabsByWorktree[workspaceId] ?? []).filter(isStructuredTab)
}

/**
 * The structured tab a subject key addresses, and only while the key still names that tab's
 * current session — a tab rebound to a new session no longer owns the old key.
 */
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

/** The tab the workspace's focused group is currently showing, if it is this structured tab. */
function isViewedStructuredTab(
  state: StoreSnapshot,
  workspaceId: string,
  tab: StructuredTab
): boolean {
  if (!isOrcaWindowForegroundFocused() || state.activeWorktreeId !== workspaceId) {
    return false
  }
  const activeGroupId = state.activeGroupIdByWorktree[workspaceId]
  const group = (state.groupsByWorktree[workspaceId] ?? []).find(
    (candidate) => candidate.id === activeGroupId
  )
  return group?.activeTabId === tab.id
}

function collectStructuredAttentionRemainder(
  state: StoreSnapshot,
  workspaceId: string
): AgentAttentionRemainder {
  const tabs = structuredTabsIn(state, workspaceId)
  if (tabs.length === 0) {
    return { hasSurfaces: false, unreadSubjectKeys: [], unreadGroupIds: [] }
  }
  const unreadSubjectKeys: string[] = []
  const unreadGroupIds: string[] = []
  // Why read per live tab instead of scanning the marker maps: a marker left behind by a closed
  // tab or a superseded session would otherwise hold workspace unread lit with nothing to clear it.
  for (const tab of tabs) {
    const subjectKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
    if (state.unreadAgentCompletionPanes[subjectKey]) {
      unreadSubjectKeys.push(subjectKey)
    }
    if (state.unreadTerminalTabs[tab.id]) {
      unreadGroupIds.push(tab.id)
    }
  }
  return { hasSurfaces: true, unreadSubjectKeys, unreadGroupIds }
}

/** Binds the neutral surface contract to one store snapshot. */
export function createStructuredAttentionSurface(state: StoreSnapshot): AgentAttentionSurface {
  return {
    // Why: a structured session runs on the execution host with no renderer PTY, so an open tab
    // still bound to the session is the only liveness evidence this process holds.
    hasLiveSession: (subject: AgentAttentionSubject) =>
      subject.surfaceKey === undefined
        ? structuredTabsIn(state, subject.workspaceId).length > 0
        : findSubjectTab(state, subject.workspaceId, subject.surfaceKey) !== null,
    admitSurface: (subject) => admitStructuredSession(state, subject),
    isSurfaceViewed: (subject) => {
      const tab = findSubjectTab(state, subject.workspaceId, subject.surfaceKey)
      return tab !== null && isViewedStructuredTab(state, subject.workspaceId, tab)
    },
    // Why: activeWorktreeId is in-app selection only. A backgrounded Orca still needs unread.
    isWorkspaceViewed: (workspaceId) =>
      state.activeWorktreeId === workspaceId && isOrcaWindowForegroundFocused(),
    isWorkspaceActive: (workspaceId) => state.activeWorktreeId === workspaceId,
    resolveViewedSubjectKey: (groupId) => {
      let tabsById = tabsByIdBySnapshot.get(state.unifiedTabsByWorktree)
      if (!tabsById) {
        tabsById = new Map()
        tabsByIdBySnapshot.set(state.unifiedTabsByWorktree, tabsById)
      }
      let tab = tabsById.get(groupId)
      if (!tab) {
        // Why: trusted pointer input repeats this lookup even without a store change.
        tab = findTabAndWorktree(state.unifiedTabsByWorktree, groupId)?.tab
        if (tab) {
          // Cache only matches so stale IDs cannot grow the cache.
          tabsById.set(groupId, tab)
        }
      }
      return tab && isStructuredTab(tab)
        ? structuredAgentSessionPaneKey(tab.id, tab.entityId)
        : null
    },
    collectWorkspaceAttentionRemainder: (workspaceId) =>
      collectStructuredAttentionRemainder(state, workspaceId)
  }
}
