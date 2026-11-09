import type {
  RuntimeStatusSlice,
  RuntimeStatusStoreSetState,
  RuntimeStatusStoreState
} from './runtime-status-types'
import { terminalInputRecordTransition } from '../../terminals/terminal-input-record-transition'
import { dismissRuntimeDisconnectedToast } from './runtime-environment-disconnect-toast'
import * as runtimeStatusConnectionGeneration from './runtime-status-connection-generation'

export function createRuntimeEnvironmentStatusRetention(
  set: RuntimeStatusStoreSetState,
  get: () => RuntimeStatusStoreState
): Pick<RuntimeStatusSlice, 'clearRuntimeEnvironmentStatus' | 'retainRuntimeEnvironmentStatuses'> {
  return {
    clearRuntimeEnvironmentStatus: (environmentId) => {
      dismissRuntimeDisconnectedToast(environmentId)
      set((s) => {
        runtimeStatusConnectionGeneration.advanceRuntimeEnvironmentConnectionGeneration(
          environmentId
        )
        if (!s.runtimeStatusByEnvironmentId.has(environmentId)) {
          return s
        }
        const next = new Map(s.runtimeStatusByEnvironmentId)
        next.delete(environmentId)
        return {
          runtimeStatusByEnvironmentId: terminalInputRecordTransition(
            s.runtimeStatusByEnvironmentId,
            next,
            [environmentId]
          )
        }
      })
    },

    retainRuntimeEnvironmentStatuses: (environmentIds) => {
      const keep = new Set(environmentIds)
      for (const id of get().runtimeStatusByEnvironmentId.keys()) {
        if (!keep.has(id)) {
          dismissRuntimeDisconnectedToast(id)
        }
      }
      set((s) => {
        let changed = false
        const removed: string[] = []
        const next = new Map(s.runtimeStatusByEnvironmentId)
        for (const id of next.keys()) {
          if (!keep.has(id)) {
            next.delete(id)
            removed.push(id)
            changed = true
          }
        }
        return changed
          ? {
              runtimeStatusByEnvironmentId: terminalInputRecordTransition(
                s.runtimeStatusByEnvironmentId,
                next,
                removed
              )
            }
          : s
      })
    }
  }
}
