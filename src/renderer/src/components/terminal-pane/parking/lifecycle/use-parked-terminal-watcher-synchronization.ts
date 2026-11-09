import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { syncParkedTerminalTabWatchers } from '../output-watchers/terminal-parked-tab-watchers'
import { disposeParkedTerminalWatchersForWorktree } from '../output-watchers/terminal-parked-watcher-registry'
import {
  subscribeTerminalParkingInputs,
  terminalParkingInputRevision
} from '../terminal-parking-input-events'

export function useTerminalParkingWorkspaceRevision(worktreeId: string): number {
  const subscribe = useCallback(
    (listener: () => void) => subscribeTerminalParkingInputs(worktreeId, listener),
    [worktreeId]
  )
  const snapshot = useCallback(() => terminalParkingInputRevision(worktreeId), [worktreeId])
  return useSyncExternalStore(subscribe, snapshot)
}

export function useParkedTerminalWatcherSynchronization(args: {
  worktreeId: string
  terminalTabs: readonly TerminalTab[]
  parkedTabIds: ReadonlySet<string>
  activationDeferredMountTabIds?: ReadonlySet<string> | null
}): void {
  const { worktreeId, terminalTabs, parkedTabIds, activationDeferredMountTabIds } = args
  const revision = useTerminalParkingWorkspaceRevision(worktreeId)
  useEffect(() => () => disposeParkedTerminalWatchersForWorktree(worktreeId), [worktreeId])
  useEffect(() => {
    syncParkedTerminalTabWatchers({
      worktreeId,
      tabs: terminalTabs,
      parkedTabIds,
      restoreTitleOnStartTabIds: activationDeferredMountTabIds ?? undefined
    })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the workspace revision owns semantic tab inputs; title-only replacements carry no watcher change.
  }, [activationDeferredMountTabIds, parkedTabIds, revision, worktreeId])
}
