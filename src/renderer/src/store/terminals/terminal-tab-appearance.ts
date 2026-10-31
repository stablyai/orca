import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { findRenamableUnifiedTab } from './renamable-unified-tab'
import { captureStructuredChatRename } from '@/runtime/structured-chat-rename-action'

export function createTerminalTabAppearanceActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'setTabCustomTitle' | 'setTabColor'> {
  return {
    setTabCustomTitle: (tabId, title, opts) => {
      // Why: a remote server's tab is named on that server, which republishes the name back here.
      const state = get()
      void import('@/runtime/web-runtime-terminal-rename').then(({ renameHostTerminalTab }) =>
        renameHostTerminalTab(state, tabId, title)
      )
      set((s) => {
        const next = { ...s.tabsByWorktree }
        for (const wId of Object.keys(next)) {
          next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, customTitle: title } : t))
        }
        scheduleRuntimeGraphSync()
        return { tabsByWorktree: next }
      })
      const item = findRenamableUnifiedTab(get().unifiedTabsByWorktree, tabId)
      if (item?.contentType === 'agent-session') {
        const action = captureStructuredChatRename(get, item)
        void import('@/runtime/structured-chat-rename')
          .then(({ renameStructuredChatTab }) =>
            renameStructuredChatTab(
              get,
              item,
              title,
              opts,
              () => get().setTabCustomLabel(item.id, title, opts),
              action
            )
          )
          .finally(action.finish)
      } else if (item) {
        get().setTabCustomLabel(item.id, title, opts)
      }
    },
    setTabColor: (tabId, color, opts) => {
      set((s) => {
        const next = { ...s.tabsByWorktree }
        for (const wId of Object.keys(next)) {
          next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, color } : t))
        }
        return { tabsByWorktree: next }
      })
      const item = findRenamableUnifiedTab(get().unifiedTabsByWorktree, tabId)
      if (item) {
        get().setUnifiedTabColor(item.id, color, opts)
        // Why: tab color is host-authoritative for remote-server tabs; mirror it so it persists instead of reverting on the next snapshot.
        const state = get()
        const owningWorktreeId = Object.keys(state.unifiedTabsByWorktree).find((wId) =>
          (state.unifiedTabsByWorktree[wId] ?? []).some((entry) => entry.id === item.id)
        )
        if (
          owningWorktreeId &&
          resolveTerminalWorktreeRoute(state, owningWorktreeId)?.runtimeEnvironmentId
        ) {
          void import('@/runtime/web-runtime-terminal-actions').then(({ setWebRuntimeTabProps }) =>
            setWebRuntimeTabProps({ worktreeId: owningWorktreeId, tabId: item.id, color })
          )
        }
      }
    }
  }
}
