import { useEffect, useRef } from 'react'
import type { TerminalTab } from '../../../../shared/types'
import { syncParkedTerminalTabWatchers } from './terminal-parked-tab-watchers'

type TerminalParkingAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

export function getTerminalParkingInputsKey(terminalTabs: readonly TerminalTab[]): string {
  return JSON.stringify(terminalTabs.map((tab) => [tab.id, tab.ptyId, tab.pendingActivationSpawn]))
}

export function getTerminalParkingAssignmentsKey(
  assignments: ReadonlyMap<string, TerminalParkingAssignment>
): string {
  return JSON.stringify(
    Array.from(assignments, ([tabId, assignment]) => [
      tabId,
      assignment.groupId,
      assignment.isActiveInGroup
    ])
  )
}

function getWatcherSynchronizationKey(args: {
  worktreeId: string
  inputsKey: string
  assignmentsKey: string
  parkedTabIds: ReadonlySet<string>
  activationDeferredMountTabIds?: ReadonlySet<string> | null
}): string {
  return JSON.stringify([
    args.worktreeId,
    args.inputsKey,
    args.assignmentsKey,
    Array.from(args.parkedTabIds),
    Array.from(args.activationDeferredMountTabIds ?? []).sort()
  ])
}

export function useParkedTerminalWatcherSynchronization(args: {
  worktreeId: string
  terminalTabs: readonly TerminalTab[]
  inputsKey: string
  assignmentsKey: string
  parkedTabIds: ReadonlySet<string>
  activationDeferredMountTabIds?: ReadonlySet<string> | null
}): void {
  const { worktreeId, terminalTabs, parkedTabIds, activationDeferredMountTabIds } = args
  const synchronizationKey = getWatcherSynchronizationKey(args)
  const synchronizationKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (synchronizationKeyRef.current === synchronizationKey) {
      return
    }
    synchronizationKeyRef.current = synchronizationKey
    syncParkedTerminalTabWatchers({
      worktreeId,
      tabs: terminalTabs,
      parkedTabIds,
      // Why: activation-deferred tabs have no prior pane-owned title slot.
      restoreTitleOnStartTabIds: activationDeferredMountTabIds ?? undefined
    })
  }, [activationDeferredMountTabIds, parkedTabIds, synchronizationKey, terminalTabs, worktreeId])
}
