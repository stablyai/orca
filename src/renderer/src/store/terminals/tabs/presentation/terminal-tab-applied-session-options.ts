import { replaceTabBuckets } from '@/store/record-transitions/keyed-record-transitions'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph/graph-sync-scheduler'
import { getTerminalTabOwnerWorktreeId } from '../../ownership/terminal-tab-owner-index'
import type { TerminalSlice, TerminalStoreSet } from '../../terminal-state'

export function createTerminalTabAppliedSessionOptionsActions(
  set: TerminalStoreSet
): Pick<TerminalSlice, 'setTabAppliedSessionOptions'> {
  return {
    setTabAppliedSessionOptions: (tabId, appliedSessionOptions) => {
      set((s) => {
        const ownerWorktreeId = getTerminalTabOwnerWorktreeId(s.tabsByWorktree, tabId)
        const tabs = ownerWorktreeId ? s.tabsByWorktree[ownerWorktreeId] : undefined
        if (!ownerWorktreeId || !tabs?.some((tab) => tab.id === tabId)) {
          return s
        }
        scheduleRuntimeGraphSync()
        return {
          tabsByWorktree: replaceTabBuckets(s.tabsByWorktree, [
            [
              ownerWorktreeId,
              tabs.map((tab) => (tab.id === tabId ? { ...tab, appliedSessionOptions } : tab))
            ]
          ])
        }
      })
    }
  }
}
