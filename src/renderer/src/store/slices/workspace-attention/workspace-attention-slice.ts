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
  settleWorkspaceUnreadFlag
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
    // Why both indexes: a container id is a terminal tab id, or a structured chat's unified tab
    // id (which has no TerminalTab record) — the same pair `findRenamableUnifiedTab` resolves,
    // and the same pair SortableTab reads this marker back under.
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
      // Why: focus-return auto-ack needs an agent-specific marker; the tab and pane markers
      // below also cover bells and are gated behind the experimental attention setting.
      markCompletionUnread(subjectKey, reason)
      if (groupId !== null && paneAttentionEnabled()) {
        markTabUnread(groupId, reason)
        markPaneUnread(subjectKey, reason)
      }
    },
    readOnScreenAttention: ({ workspaceIds, targets }, { screenArrived }) => {
      const removed = removeAndDismiss(targets.map((target) => target.tabId))
      // Why on arrival even with nothing removed: a flag with no marker behind it (Mark as unread,
      // restart, another client) is read when the screen moves to it, not on every later scan.
      if (removed || screenArrived) {
        for (const workspaceId of workspaceIds) {
          settleWorkspaceUnreadFlag(set, get, workspaceId, onScreenHostId(get(), workspaceId))
        }
      }
    },
    setWorkspaceUnreadByUser: (worktreeId, isUnread, executionHostId) => {
      if (!isUnread) {
        removeAndDismiss(workspaceMarkerTabIds(get(), worktreeId))
      }
      // Why: the toggle writes only the clicked host's row; the markers it removes are
      // workspace-wide because tabs, and so markers, are keyed by workspace id, not host.
      void get().updateWorktreeMeta(worktreeId, { isUnread }, { executionHostId })
    }
  }
}
