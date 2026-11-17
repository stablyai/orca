// The archived page's read of what was captured at archive, owned or paired workspace alike.
import { useCallback, useEffect, useState } from 'react'
import { cloudWorkspaceTarget } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type { ArchiveLoad } from './CloudArchivedWorkspaceView'

/** The last archive read per workspace: selecting it again shows that at once, never a skeleton. */
const archiveLoads = new Map<string, Extract<ArchiveLoad, { status: 'ready' }>>()

export function useArchiveLoad(workspaceId: string, enabled: boolean): [ArchiveLoad, () => void] {
  const [load, setLoad] = useState<ArchiveLoad>(
    () => archiveLoads.get(workspaceId) ?? { status: 'loading' }
  )
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    // A cached read stays on screen while it refreshes; only a first read shows the skeleton.
    if (!archiveLoads.has(workspaceId)) {
      setLoad({ status: 'loading' })
    }
    void window.api.orcaCloudWorkspace
      .getArchive(cloudWorkspaceTarget(workspaceId))
      .then((result) => {
        if (cancelled) {
          return
        }
        if (result.ok) {
          const ready = { status: 'ready' as const, archive: result.value }
          archiveLoads.set(workspaceId, ready)
          setLoad(ready)
        } else if (!archiveLoads.has(workspaceId)) {
          setLoad({ status: 'error', message: result.message })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoad({
            status: 'error',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, enabled, attempt])
  return [load, useCallback(() => setAttempt((n) => n + 1), [])]
}
