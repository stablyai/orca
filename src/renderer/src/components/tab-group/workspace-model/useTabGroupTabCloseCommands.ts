import { useMemo } from 'react'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace/tabs/workspace-tab-commands'
import { announceKeptMixedWorkerTabs } from '@/components/tab-bar/worker-tab-user-close'
import { useAppStore } from '@/store'

export function useTabGroupTabCloseCommands({ worktreeId }: { worktreeId: string }) {
  return useMemo(
    () => ({
      closeItem: (tabId: string, opts?: { skipEmptyCheck?: boolean }) => {
        dispatchWorkspaceTabCommand({
          type: 'close',
          target: { kind: 'tab', worktreeId, tabId },
          ...opts
        })
      },
      closeMany: (tabIds: string[]) => {
        // Counted once here; a tab that turns mixed while the closes run is kept without a second note.
        announceKeptMixedWorkerTabs(useAppStore.getState(), tabIds)
        for (const tabId of tabIds) {
          dispatchWorkspaceTabCommand({
            type: 'close',
            target: { kind: 'tab', worktreeId, tabId },
            bulk: true
          })
        }
      }
    }),
    [worktreeId]
  )
}
