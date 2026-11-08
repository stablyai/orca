import { useEffect, useState } from 'react'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import { isFolderRepo } from '../../../../../../shared/repo-kind'
import type { Repo } from '../../../../../../shared/repo-types'
import { WORKTREE_FOLDER_SETUP_RUNTIME_CAPABILITY } from '../../../../../../shared/worktree-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'

/** Folder setup runs only on hosts that report it; older hosts would save scripts that never run. */
export function useFolderSetupSupported(repo: Repo): boolean {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  const environmentId = isFolderRepo(repo) && host?.kind === 'runtime' ? host.environmentId : null
  const [supportedEnvironmentId, setSupportedEnvironmentId] = useState<string | null>(null)
  useEffect(() => {
    if (!environmentId) {
      return
    }
    let cancelled = false
    void runtimeEnvironmentSupportsCapability(
      environmentId,
      WORKTREE_FOLDER_SETUP_RUNTIME_CAPABILITY
    )
      .catch(() => false)
      .then((supported) => {
        if (!cancelled && supported) {
          setSupportedEnvironmentId(environmentId)
        }
      })
    return () => {
      cancelled = true
    }
  }, [environmentId])
  if (!isFolderRepo(repo)) {
    return true
  }
  // An unserved SSH folder runs no hooks; its files aren't on a host Orca runs scripts on.
  if (host?.kind === 'ssh') {
    return false
  }
  return environmentId ? supportedEnvironmentId === environmentId : true
}
