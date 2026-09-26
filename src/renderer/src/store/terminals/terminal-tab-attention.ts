import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { findRenamableUnifiedTab } from './renamable-unified-tab'

type MirroredTerminalTabProps = {
  color?: string | null
  customTitle?: string | null
  previousCustomTitle?: string | null
}

function mirrorTerminalTabPropsToRuntime(
  get: TerminalStoreGet,
  tabId: string,
  props: MirroredTerminalTabProps
): void {
  const state = get()
  const owningWorktreeId = Object.keys(state.unifiedTabsByWorktree).find((worktreeId) =>
    (state.unifiedTabsByWorktree[worktreeId] ?? []).some((entry) => entry.id === tabId)
  )
  if (
    !owningWorktreeId ||
    !resolveTerminalWorktreeRoute(state, owningWorktreeId)?.runtimeEnvironmentId
  ) {
    return
  }
  void import('@/runtime/web-runtime-session').then(({ setWebRuntimeTabProps }) =>
    setWebRuntimeTabProps({ worktreeId: owningWorktreeId, tabId, ...props })
  )
}

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
    markTerminalTabUnread: (tabId, reason) => {
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
      // Why: terminal attention persists until real interaction.
      set((s) => {
        if (s.unreadTerminalTabs[tabId]) {
          return s
        }
        return { unreadTerminalTabs: { ...s.unreadTerminalTabs, [tabId]: reason } }
      })
    },
    markTerminalPaneUnread: (paneKey, reason) => {
      set((s) => {
        if (s.unreadTerminalPanes[paneKey]) {
          return s
        }
        return { unreadTerminalPanes: { ...s.unreadTerminalPanes, [paneKey]: reason } }
      })
    },
    markAgentCompletionPaneUnread: (paneKey, reason) => {
      set((s) => {
        if (s.unreadAgentCompletionPanes[paneKey]) {
          return s
        }
        return {
          unreadAgentCompletionPanes: {
            ...s.unreadAgentCompletionPanes,
            [paneKey]: reason
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
      const previousCustomTitle = Object.values(get().tabsByWorktree)
        .flat()
        .find((tab) => tab.id === tabId)?.customTitle
      set((s) => {
        const next = { ...s.tabsByWorktree }
        for (const wId of Object.keys(next)) {
          next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, customTitle: title } : t))
        }
        scheduleRuntimeGraphSync()
        return { tabsByWorktree: next }
      })
      const item = findRenamableUnifiedTab(get().unifiedTabsByWorktree, tabId)
      if (item) {
        get().setTabCustomLabel(item.id, title, opts)
        mirrorTerminalTabPropsToRuntime(get, item.id, {
          customTitle: title,
          previousCustomTitle: previousCustomTitle ?? null
        })
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
      const item = findRenamableUnifiedTab(get().unifiedTabsByWorktree, tabId)
      if (item) {
        get().setUnifiedTabColor(item.id, color)
        mirrorTerminalTabPropsToRuntime(get, item.id, { color })
      }
    }
  }
}
