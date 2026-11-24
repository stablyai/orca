import { useCallback, useRef, useSyncExternalStore } from 'react'
import {
  subscribeAddressedTerminalParkingInputs,
  terminalParkingInputEpoch
} from './terminal-parking-input-events'

/** A missed pre-subscription transition is an unknown snapshot, never an assumed complete dirty list. */
export function useTerminalParkingWorkspaceChanges(workspaceIds: readonly string[]) {
  const pending = useRef(new Set(workspaceIds))
  const observedEpoch = useRef(terminalParkingInputEpoch())
  const subscribe = useCallback((changed: () => void) => {
    return subscribeAddressedTerminalParkingInputs((worktreeId) => {
      pending.current.add(worktreeId)
      observedEpoch.current = terminalParkingInputEpoch()
      changed()
    })
  }, [])
  const revision = useSyncExternalStore(subscribe, terminalParkingInputEpoch)
  const takeChangedWorkspaces = useCallback((): Set<string> => {
    const dirty = pending.current
    pending.current = new Set()
    if (observedEpoch.current !== terminalParkingInputEpoch()) {
      for (const id of workspaceIds) {
        dirty.add(id)
      }
      observedEpoch.current = terminalParkingInputEpoch()
    }
    return dirty
  }, [workspaceIds])
  return { revision, takeChangedWorkspaces }
}
