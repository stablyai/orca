import { replaceTabBuckets } from '@/store/keyed-record-transitions'
import { getTerminalTabOwnerWorktreeIds } from './terminal-tab-owner-index'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph/graph-sync-scheduler'
import { resolveTerminalWorktreeRoute } from '@/lib/workspace/ownership/terminal-worktree-route'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { findRenamableUnifiedTab } from './renamable-unified-tab'
import { captureStructuredChatRename } from '@/runtime/native-chat/naming/structured-chat-rename-action'
import { syncLocalClaudeSessionName } from '@/runtime/claude-session-name-sync'

export function createTerminalTabAppearanceActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'setTabCustomTitle' | 'setTabColor'> {
  return {
    setTabCustomTitle: (tabId, title, opts) => {
      // Why: a remote server's tab is named on that server, which republishes the name back here.
      const state = get()
      void import('@/runtime/hosted-terminals/actions/web-runtime-terminal-rename').then(
        ({ renameHostTerminalTab }) => renameHostTerminalTab(state, tabId, title)
      )
      set((s) => {
        const owners = [...getTerminalTabOwnerWorktreeIds(s.tabsByWorktree, tabId)]
        if (owners.length === 0) {
          return s
        }
        const replacements = owners.map(
          (wId) =>
            [
              wId,
              s.tabsByWorktree[wId].map((t) => (t.id === tabId ? { ...t, customTitle: title } : t))
            ] as const
        )
        scheduleRuntimeGraphSync()
        return { tabsByWorktree: replaceTabBuckets(s.tabsByWorktree, replacements) }
      })
      const item = findRenamableUnifiedTab(get().unifiedTabsByWorktree, tabId)
      if (item?.contentType === 'agent-session') {
        const action = captureStructuredChatRename(get, item)
        void import('@/runtime/native-chat/naming/structured-chat-rename')
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
      } else {
        if (item) {
          get().setTabCustomLabel(item.id, title, opts)
        }
        syncLocalClaudeSessionName(tabId, title)
      }
    },
    setTabColor: (tabId, color, opts) => {
      set((s) => {
        const owners = [...getTerminalTabOwnerWorktreeIds(s.tabsByWorktree, tabId)]
        if (owners.length === 0) {
          return s
        }
        return {
          tabsByWorktree: replaceTabBuckets(
            s.tabsByWorktree,
            owners.map(
              (wId) =>
                [
                  wId,
                  s.tabsByWorktree[wId].map((t) => (t.id === tabId ? { ...t, color } : t))
                ] as const
            )
          )
        }
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
          void import('@/runtime/hosted-terminals/actions/web-runtime-tab-properties').then(
            ({ setWebRuntimeTabProps }) =>
              setWebRuntimeTabProps({ worktreeId: owningWorktreeId, tabId: item.id, color })
          )
        }
      }
    }
  }
}
