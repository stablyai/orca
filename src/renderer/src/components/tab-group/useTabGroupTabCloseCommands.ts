import { useMemo } from 'react'
import type { Tab } from '../../../../shared/tab-types'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import { createWorkspaceTabCloseCommands } from './workspace-tab-close-commands'

export function useTabGroupTabCloseCommands({
  worktreeId,
  groupTabs
}: {
  worktreeId: string
  groupTabs: Tab[]
}) {
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
      },
      leaveWorktreeIfEmpty: createWorkspaceTabCloseCommands({ worktreeId, groupTabs })
        .leaveWorktreeIfEmpty
    }),
    [worktreeId, groupTabs]
  )
}
