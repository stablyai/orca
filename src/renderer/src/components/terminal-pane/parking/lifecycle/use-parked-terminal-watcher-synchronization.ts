import { useCallback, useEffect, useEffectEvent, useMemo, useSyncExternalStore } from 'react'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { syncParkedTerminalTabWatchers } from '../output-watchers/terminal-parked-tab-watchers'
import { disposeParkedTerminalWatchersForWorktree } from '../output-watchers/terminal-parked-watcher-registry'
import {
  subscribeTerminalParkingInputs,
  terminalParkingInputRevision
} from '../terminal-parking-input-events'

export function useTerminalParkingWorkspaceInputs(worktreeId: string) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeTerminalParkingInputs(worktreeId, listener),
    [worktreeId]
  )
  const snapshot = useCallback(() => terminalParkingInputRevision(worktreeId), [worktreeId])
  const revision = useSyncExternalStore(subscribe, snapshot)
  return useMemo(() => ({ worktreeId, revision }), [worktreeId, revision])
}

export function useParkedTerminalWatcherSynchronization(args: {
  worktreeId: string
  terminalTabs: readonly TerminalTab[]
  parkedTabIds: ReadonlySet<string>
  activationDeferredMountTabIds?: ReadonlySet<string> | null
}): void {
  const { worktreeId, terminalTabs, parkedTabIds, activationDeferredMountTabIds } = args
  const inputs = useTerminalParkingWorkspaceInputs(worktreeId)
  useEffect(() => () => disposeParkedTerminalWatchersForWorktree(worktreeId), [worktreeId])
  const synchronize = useEffectEvent(() => {
    syncParkedTerminalTabWatchers({
      worktreeId,
      tabs: terminalTabs,
      parkedTabIds,
      restoreTitleOnStartTabIds: activationDeferredMountTabIds ?? undefined
    })
  })
  useEffect(() => {
    synchronize()
  }, [activationDeferredMountTabIds, parkedTabIds, inputs])
}
