import { useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentsRetired,
  onRuntimeEnvironmentRevisionsChanged
} from '@/runtime/runtime-environment-revision'

export function useThreadHostGeneration(hosts: readonly string[]): string {
  const observation = useMemo(() => {
    const ids = new Set(
      hosts.filter((host) => host.startsWith('runtime:')).map((host) => host.slice(8))
    )
    let source: ReturnType<typeof useAppStore.getState>['runtimeStatusByEnvironmentId'] | undefined
    let revision = 0
    let capturedRevision = -1
    let snapshot = ''
    const read = () => {
      const next = useAppStore.getState().runtimeStatusByEnvironmentId
      if (source !== next || revision !== capturedRevision) {
        source = next
        capturedRevision = revision
        snapshot = JSON.stringify([
          revision,
          [...ids].map((id) => {
            const entry = next.get(id)
            const verified = lastVerifiedRuntimeStatus(entry)
            return [
              id,
              getRuntimeEnvironmentRevision(id),
              entry?.hostContactEpoch,
              entry?.connectionGeneration,
              verified?.runtimeId,
              verified?.capabilities
            ]
          })
        ])
      }
      return snapshot
    }
    return {
      read,
      subscribe: (listener: () => void) => {
        if (!ids.size) {
          return () => {}
        }
        let active = true
        const changed = (changedIds: readonly string[]) => {
          if (active && changedIds.some((id) => ids.has(id))) {
            revision++
            listener()
          }
        }
        const app = useAppStore.subscribe(listener)
        const revisions = onRuntimeEnvironmentRevisionsChanged(changed)
        // Retirement fences old owners before the revision map is replaced.
        const retired = onRuntimeEnvironmentsRetired((retiredIds) =>
          queueMicrotask(() => changed(retiredIds))
        )
        return () => {
          active = false
          app()
          revisions()
          retired()
        }
      }
    }
  }, [hosts])
  return useSyncExternalStore(observation.subscribe, observation.read, observation.read)
}
