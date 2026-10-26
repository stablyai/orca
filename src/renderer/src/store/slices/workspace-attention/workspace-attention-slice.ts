import type { StateCreator } from 'zustand'
import type { AgentAttentionUnreadReason } from '@/attention/agent-attention-contract'
import type { AppState } from '../../types'
import type { WorkspaceAttentionSlice } from './workspace-attention-contract'
import {
  collectRemovedAttention,
  dismissReadNotifications,
  sameMarkers
} from './attention-removal-follow-up'
import { removeTabsAttention } from './subject-attention-transitions'
import {
  markWorkspaceUnreadFlag,
  onScreenHostId,
  settleWorkspaceUnreadFlag,
  noteWorkspaceRead
} from './workspace-unread-flag'
import { workspaceMarkerTabIds } from './workspace-live-markers'
import { isTabOnScreen } from '@/hooks/agent-auto-ack-targets'
import { isWorkspaceNotificationMutedBySidebarFilters } from '@/attention/hidden-workspace-notification-mute'

export const createWorkspaceAttentionSlice: StateCreator<
  AppState,
  [],
  [],
  WorkspaceAttentionSlice
> = (set, get) => {
  const markTabUnread = (tabId: string, reason: AgentAttentionUnreadReason): void => {
    const state = get()
    // Terminal tab IDs and structured-chat unified IDs both own markers; SortableTab/findRenamableUnifiedTab use the same pair.
    const ownsTab =
      Object.values(state.tabsByWorktree ?? {})
        .flat()
        .some((tab) => tab.id === tabId) ||
      Object.values(state.unifiedTabsByWorktree ?? {})
        .flat()
        .some((tab) => tab.contentType === 'agent-session' && tab.id === tabId)
    if (!ownsTab) {
      return
    }
    // Why: a marker stays until its tab is read on screen, Marked as read, or closed.
    set((s) =>
      s.unreadTerminalTabs[tabId]
        ? s
        : { unreadTerminalTabs: { ...s.unreadTerminalTabs, [tabId]: reason } }
    )
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
  /** Removes every marker of the tabs and dismisses their panes' notifications; true if any. */
  const removeAndDismiss = (tabIds: Iterable<string>): boolean => {
    const before = get()
    set((s) => {
      const next = removeTabsAttention(s, tabIds)
      return sameMarkers(s, next) ? s : next
    })
    const removed = collectRemovedAttention(before, get())
    if (removed) {
      dismissReadNotifications(removed.paneKeys)
    }
    return removed !== null
  }
  const paneAttentionEnabled = (): boolean => get().settings?.experimentalTerminalAttention === true

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
    readOnScreenAttention: ({ workspaceIds, targets }, { screenArrived }) => {
      const removed = removeAndDismiss(targets.map((target) => target.tabId))
      // Read marker-free flags on screen arrival (manual unread/restart/peer), not on every scan.
      if (removed || screenArrived) {
        for (const workspaceId of workspaceIds) {
          settleWorkspaceUnreadFlag(set, get, workspaceId, onScreenHostId(get(), workspaceId))
        }
      }
    },
    setWorkspaceUnreadByUser: (worktreeId, isUnread, executionHostId) => {
      if (!isUnread) {
        noteWorkspaceRead(worktreeId)
        removeAndDismiss(workspaceMarkerTabIds(get(), worktreeId))
      }
      // Update only the clicked host’s row; markers stay workspace-wide because tab keys omit host.
      void get().updateWorktreeMeta(worktreeId, { isUnread }, { executionHostId })
    }
  }
}
