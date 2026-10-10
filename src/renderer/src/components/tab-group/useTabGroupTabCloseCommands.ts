import { useMemo } from 'react'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'

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
