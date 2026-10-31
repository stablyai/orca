import { useEffect, useState } from 'react'
import { watchRuntimeRepoBaseRefDefault } from '@/runtime/runtime-repo-client'
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
  // Unknown bases must not trigger comparison against a fabricated origin/main.
  const [defaultBaseRef, setDefaultBaseRef] = useState<string | null>(null)
  useEffect(() => {
    if (!isBranchVisible || !activeRepoId || !activeRepoExecutionHostId || isFolder) {
      return
    }
    // Drop the previous repo’s default while loading to prevent transient invalid-base comparisons.
    setDefaultBaseRef(null)
    // Resolve on the repo owner, which may differ from the focused host.
    return watchRuntimeRepoBaseRefDefault(activeRepoExecutionHostId, activeRepoId, {
      onResult: (result) => setDefaultBaseRef(result.defaultBaseRef),
      onError: (err) => {
        console.error('[SourceControl] getBaseRefDefault failed', err)
        // Keep failures unknown so comparison/review fetches cannot use a fabricated ref.
        setDefaultBaseRef(null)
      }
    })
  }, [
    // Only owner changes reset the base; metadata churn must not restart eligibility’s timeout.
    activeRepoConnectionId,
    activeRepoExecutionHostId,
    activeRepoId,
    isBranchVisible,
    isFolder
  ])
  return defaultBaseRef
}
