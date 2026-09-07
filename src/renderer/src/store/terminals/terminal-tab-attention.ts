import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

export function createTerminalTabAttentionActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<
  TerminalSlice,
  | 'markTerminalTabUnread'
  | 'markTerminalPaneUnread'
  | 'markAgentCompletionPaneUnread'
  | 'clearTerminalTabUnread'
  | 'clearTerminalPaneUnread'
  | 'setTabCustomTitle'
  | 'setTabColor'
> {
  return {
    markTerminalTabUnread: (tabId) => {
      const state = get()
      const ownerTab = Object.values(state.tabsByWorktree ?? {})
        .flat()
        .find((t) => t.id === tabId)
      if (!ownerTab) {
        return
      }
      // Why: terminal attention persists until real interaction.
      set((s) => {
        if (s.unreadTerminalTabs[tabId]) {
          return s
        }
        return { unreadTerminalTabs: { ...s.unreadTerminalTabs, [tabId]: true as const } }
      })
    },
    markTerminalPaneUnread: (paneKey) => {
      set((s) => {
        if (s.unreadTerminalPanes[paneKey]) {
          return s
        }
        return { unreadTerminalPanes: { ...s.unreadTerminalPanes, [paneKey]: true as const } }
      })
    },
    markAgentCompletionPaneUnread: (paneKey) => {
      set((s) => {
        if (s.unreadAgentCompletionPanes[paneKey]) {
          return s
        }
        return {
          unreadAgentCompletionPanes: {
            ...s.unreadAgentCompletionPanes,
            [paneKey]: true as const
          }
        }
      })
    },
    clearTerminalTabUnread: (tabId) => {
      set((s) => {
        if (!s.unreadTerminalTabs[tabId]) {
          return s
        }
        const copy = { ...s.unreadTerminalTabs }
        delete copy[tabId]
        return { unreadTerminalTabs: copy }
      })
    },
    clearTerminalPaneUnread: (paneKey) => {
      set((s) => {
        if (!s.unreadTerminalPanes[paneKey] && !s.unreadAgentCompletionPanes[paneKey]) {
          return s
        }
        const nextUnreadTerminalPanes = { ...s.unreadTerminalPanes }
        const nextUnreadAgentCompletionPanes = { ...s.unreadAgentCompletionPanes }
        delete nextUnreadTerminalPanes[paneKey]
        delete nextUnreadAgentCompletionPanes[paneKey]
        return {
          unreadTerminalPanes: nextUnreadTerminalPanes,
          unreadAgentCompletionPanes: nextUnreadAgentCompletionPanes
        }
      })
    },
    setTabCustomTitle: (tabId, title, opts) => {
      set((s) => {
        const next = { ...s.tabsByWorktree }
        for (const wId of Object.keys(next)) {
          next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, customTitle: title } : t))
        }
        scheduleRuntimeGraphSync()
        return { tabsByWorktree: next }
      })
      const item = Object.values(get().unifiedTabsByWorktree)
        .flat()
        .find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId)
      if (item) {
        get().setTabCustomLabel(item.id, title, opts)
      }
    },
    setTabColor: (tabId, color) => {
      set((s) => {
        const next = { ...s.tabsByWorktree }
        for (const wId of Object.keys(next)) {
          next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, color } : t))
        }
        return { tabsByWorktree: next }
      })
      const item = Object.values(get().unifiedTabsByWorktree)
        .flat()
        .find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId)
      if (item) {
        get().setUnifiedTabColor(item.id, color)
        // Why: tab color is host-authoritative for remote-server tabs; mirror it so it persists instead of reverting on the next snapshot.
        const state = get()
        const owningWorktreeId = Object.keys(state.unifiedTabsByWorktree).find((wId) =>
          (state.unifiedTabsByWorktree[wId] ?? []).some((entry) => entry.id === item.id)
        )
        if (
          owningWorktreeId &&
          resolveTerminalWorktreeRoute(state, owningWorktreeId)?.runtimeEnvironmentId
        ) {
          void import('@/runtime/web-runtime-session').then(({ setWebRuntimeTabProps }) =>
            setWebRuntimeTabProps({ worktreeId: owningWorktreeId, tabId: item.id, color })
          )
        }
      }
    }
  }
}
