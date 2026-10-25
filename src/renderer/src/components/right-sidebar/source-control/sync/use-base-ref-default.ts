import { useEffect, useState } from 'react'
import { getRuntimeRepoBaseRefDefault } from '@/runtime/runtime-repo-client'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

export function useSourceControlBaseRefDefault({
  activeRepoConnectionId,
  activeRepoExecutionHostId,
  activeRepoId,
  isBranchVisible,
  isFolder
}: {
  activeRepoConnectionId: string | null
  activeRepoExecutionHostId: ExecutionHostId | null
  activeRepoId: string | null
  isBranchVisible: boolean
  isFolder: boolean
}): string | null {
  // Why: start null (not 'origin/main') so branch compare doesn't fire with a fabricated ref before the IPC resolves.
  const [defaultBaseRef, setDefaultBaseRef] = useState<string | null>(null)
  useEffect(() => {
    if (!isBranchVisible || !activeRepoId || !activeRepoExecutionHostId || isFolder) {
      return
    }
    // Why: reset to null so that effectiveBaseRef becomes falsy until the IPC resolves, so branch compare can't fire with a stale defaultBaseRef from a different repo (transient "invalid-base" on switch).
    setDefaultBaseRef(null)
    let stale = false
    // Why: resolved on the repo's OWNER host, not the focused runtime.
    void getRuntimeRepoBaseRefDefault(activeRepoExecutionHostId, activeRepoId)
      .then((result) => {
        if (!stale) {
          // IPC returns a { defaultBaseRef, remoteCount } envelope; only defaultBaseRef is needed here (remoteCount powers BaseRefPicker's multi-remote hint).
          setDefaultBaseRef(result.defaultBaseRef)
        }
      })
      .catch((err) => {
        console.error('[SourceControl] getBaseRefDefault failed', err)
        // Why: leave defaultBaseRef null on failure (not a fabricated 'origin/main') so branch compare/PR fetch skip a possibly-nonexistent ref.
        if (!stale) {
          setDefaultBaseRef(null)
        }
      })
    return () => {
      stale = true
    }
  }, [
    // Why: only repo/host ownership changes should reset the base; unrelated metadata churn must not restart eligibility's timeout.
    activeRepoConnectionId,
    activeRepoExecutionHostId,
    activeRepoId,
    isBranchVisible,
    isFolder
  ])
  return defaultBaseRef
}
