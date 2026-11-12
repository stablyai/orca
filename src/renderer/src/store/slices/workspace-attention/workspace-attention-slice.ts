import type { StateCreator } from 'zustand'
import type { AgentAttentionUnreadReason } from '@/attention/agent-attention-contract'
import type { AppState } from '../../types'
import type { WorkspaceAttentionSlice } from './workspace-attention-contract'
import {
  collectRemovedAttention,
  dismissReadNotifications,
  sameMarkers,
  type RemovedAttention
} from './attention-removal-follow-up'
import { removeTabsAttention } from './subject-attention-transitions'
import {
  markWorkspaceUnreadFlag,
  onScreenHostId,
  settleWorkspaceUnreadFlag,
  noteWorkspaceRead
} from './workspace-unread-flag'
import { workspaceMarkerTabs, paneKeyTabId } from './workspace-live-markers'
import { workspaceMarkerTabIdsForHost } from './workspace-marker-host'
import {
  composeWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../../shared/worktree/host-qualified-identity'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import { getAgentPaneExecutionHost } from '../agent-status/agent-pane-execution-host'
import { resolveAgentStatusWorktreeId } from '../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { isTabOnScreen } from '@/hooks/agent-auto-ack-targets'
import { isWorkspaceNotificationMutedBySidebarFilters } from '@/attention/hidden-workspace-notification-mute'
import { getTerminalTabOwnerWorktreeId } from '../../terminals/ownership/terminal-tab-owner-index'
import { hasUnreadAgentSessionTab } from '@/components/terminal-pane/notifications/unread-agent-session-membership'

const emptyTerminalTabs: AppState['tabsByWorktree'] = {}

export const createWorkspaceAttentionSlice: StateCreator<
  AppState,
  [],
  [],
  WorkspaceAttentionSlice
> = (set, get) => {
  const markTabUnread = (tabId: string, reason: AgentAttentionUnreadReason): void => {
    const state = get()
    if (state.unreadTerminalTabs[tabId]) {
      return
    }
    // Terminal tab IDs and structured-chat unified IDs both own markers; SortableTab/findRenamableUnifiedTab use the same pair.
    const ownsTab =
      getTerminalTabOwnerWorktreeId(state.tabsByWorktree ?? emptyTerminalTabs, tabId) !== null ||
      hasUnreadAgentSessionTab(state.unifiedTabsByWorktree, tabId)
    if (!ownsTab) {
      return
    }
    // Why: a marker stays until its tab is read on screen, Marked as read, or closed.
    set((s) => ({ unreadTerminalTabs: { ...s.unreadTerminalTabs, [tabId]: reason } }))
  }
  const markPaneUnread = (paneKey: string, reason: AgentAttentionUnreadReason): void => {
    set((s) =>
      s.unreadTerminalPanes[paneKey]
        ? s
        : { unreadTerminalPanes: { ...s.unreadTerminalPanes, [paneKey]: reason } }
    )
  }
  const markCompletionUnread = (paneKey: string, reason: AgentAttentionUnreadReason): void => {
    set((s) =>
      s.unreadAgentCompletionPanes[paneKey]
        ? s
        : { unreadAgentCompletionPanes: { ...s.unreadAgentCompletionPanes, [paneKey]: reason } }
    )
  }
  /** Removes every marker of the tabs and dismisses their panes' notifications. */
  const removeAndDismiss = (tabIds: Iterable<string>): RemovedAttention | null => {
    const before = get()
    set((s) => {
      const next = removeTabsAttention(s, tabIds)
      return sameMarkers(s, next) ? s : next
    })
    const removed = collectRemovedAttention(before, get())
    if (removed) {
      dismissReadNotifications(removed.paneKeys)
    }
    return removed
  }
  const paneAttentionEnabled = (): boolean => get().settings?.experimentalTerminalAttention === true
  const setWorkspacesMarkedUnreadByUser = (
    identities: readonly HostScopedWorktreeKey[],
    marked: boolean
  ): void =>
    set((s) => {
      const changed = identities.filter(
        (identity) => Boolean(s.workspacesMarkedUnreadByUser[identity]) !== marked
      )
      if (changed.length === 0) {
        return s
      }
      const next = { ...s.workspacesMarkedUnreadByUser }
      for (const identity of changed) {
        if (marked) {
          next[identity] = true
        } else {
          delete next[identity]
        }
      }
      return { workspacesMarkedUnreadByUser: next }
    })

  return {
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    unreadAgentCompletionPanes: {},
    markTerminalBell: ({ worktreeId, tabId, paneKey }) => {
      // Why: a bell on the tab on screen is already read; marking it would persist the flag
      // true then false, and a remote owner turns each persist into an RPC.
      if (isTabOnScreen(get(), worktreeId, tabId, 'terminal')) {
        return
      }
      // Why here too: the bell's marker is written before its delayed banner reaches the attention policy.
      if (isWorkspaceNotificationMutedBySidebarFilters(get(), worktreeId)) {
        return
      }
      markWorkspaceUnreadFlag(set, get, worktreeId)
      markTabUnread(tabId, 'terminal-bell')
      if (paneAttentionEnabled()) {
        markPaneUnread(paneKey, 'terminal-bell')
      }
    },
    markAgentAttentionUnread: ({ workspaceId, subjectKey, groupId, reason }) => {
      markWorkspaceUnreadFlag(set, get, workspaceId)
      if (subjectKey === null) {
        return
      }
      // Auto-ack needs completion-specific markers; generic bell/pane markers remain behind the experimental attention gate.
      markCompletionUnread(subjectKey, reason)
      if (groupId !== null && paneAttentionEnabled()) {
        markTabUnread(groupId, reason)
        markPaneUnread(subjectKey, reason)
      }
    },
    readOnScreenAttention: ({ workspaceIds, targets }, { screenArrived, markersRead }) => {
      // Arriving fulfils "come back to this", even while other tabs still hold markers.
      if (screenArrived) {
        const state = get()
        setWorkspacesMarkedUnreadByUser(
          workspaceIds.flatMap((id) => {
            const host =
              onScreenHostId(state, id) ?? getResolvedExecutionHostIdForWorktree(state, id)
            return host ? [composeWorktreeHostIdentity(host, id)] : []
          }),
          false
        )
      }
      // Agent acknowledgement may already have removed this scan's completion markers.
      if (
        removeAndDismiss(targets.map((target) => target.tabId)) !== null ||
        markersRead ||
        screenArrived
      ) {
        for (const workspaceId of workspaceIds) {
          settleWorkspaceUnreadFlag(set, get, workspaceId, onScreenHostId(get(), workspaceId))
        }
      }
    },
    workspacesMarkedUnreadByUser: {},
    setWorkspaceUnreadByUser: (worktreeId, isUnread, executionHostId) => {
      setWorkspacesMarkedUnreadByUser(
        [composeWorktreeHostIdentity(executionHostId, worktreeId)],
        isUnread
      )
      if (isUnread) {
        void get().updateWorktreeMeta(worktreeId, { isUnread }, { executionHostId })
        return
      }
      noteWorkspaceRead(worktreeId)
      const removed = removeAndDismiss(
        workspaceMarkerTabIdsForHost(get(), worktreeId, executionHostId)
      )
      void get().updateWorktreeMeta(worktreeId, { isUnread }, { executionHostId })
      // Mark read reads the agents too, or their lines keep the dot the user just cleared.
      // Journal-positioned chat alerts retire only with this explicit read that bounds them.
      const paneKeys = new Set([
        ...(removed?.paneKeys ?? []),
        ...workspaceAgentPaneKeys(get(), worktreeId)
      ])
      const state = get()
      // One index per action: a lookup per pane is O(tabs × panes) for a workspace with many tabs.
      const tabsById = new Map((state.tabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab]))
      const hostPaneKeys = [...paneKeys].filter((paneKey) => {
        const retained = state.retainedAgentsByPaneKey[paneKey]
        const entry = state.agentStatusByPaneKey[paneKey] ?? retained?.entry
        const tabId = paneKeyTabId(paneKey)
        const tab = tabId ? tabsById.get(tabId) : undefined
        return (
          getAgentPaneExecutionHost(state, paneKey, entry, tab?.ptyId ?? retained?.tab.ptyId) ===
          executionHostId
        )
      })
      if (hostPaneKeys.length > 0) {
        get().acknowledgeAgents(hostPaneKeys, undefined, 'explicit')
      }
    }
  }
}

/** Every agent pane, live or retained, that belongs to the workspace. */
function workspaceAgentPaneKeys(state: AppState, worktreeId: string): string[] {
  const keys: string[] = []
  const tabOwners = new Map<string, string>()
  for (const id of new Set([
    ...Object.keys(state.tabsByWorktree),
    ...Object.keys(state.unifiedTabsByWorktree)
  ])) {
    for (const tab of workspaceMarkerTabs(state, id)) {
      tabOwners.set(tab.id, id)
    }
  }
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    if (resolveAgentStatusWorktreeId(entry, tabOwners) === worktreeId) {
      keys.push(paneKey)
    }
  }
  for (const [paneKey, retained] of Object.entries(state.retainedAgentsByPaneKey)) {
    if (retained.worktreeId === worktreeId) {
      keys.push(paneKey)
    }
  }
  return keys
}
