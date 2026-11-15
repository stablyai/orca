import type {
  RuntimeStatusSlice,
  RuntimeStatusStoreSetState,
  RuntimeStatusStoreState
} from './runtime-status-types'
import { replaceMapEntries } from '@/store/keyed-record-transitions'
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
        return {
          runtimeStatusByEnvironmentId: replaceMapEntries(s.runtimeStatusByEnvironmentId, [
            [environmentId, null]
          ])
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
        const removed = [...s.runtimeStatusByEnvironmentId.keys()].filter((id) => !keep.has(id))
        return removed.length > 0
          ? {
              runtimeStatusByEnvironmentId: replaceMapEntries(
                s.runtimeStatusByEnvironmentId,
                removed.map((id) => [id, null] as const)
              )
            }
          : s
      })
    }
  }
}
