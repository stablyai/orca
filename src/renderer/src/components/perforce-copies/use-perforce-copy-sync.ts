import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { PERFORCE_UPDATE_REQUIRED_MESSAGE } from '../../../../shared/perforce/perforce-runtime-capability'
import { runPerforceCopyOperation } from '../../runtime/runtime-perforce-client'
import { perforceProjectTarget } from '@/lib/perforce-workspace-target'

const synced = new Set<string>()

/**
 * Once per session per folder project: marks one inside a Perforce workspace as a Perforce project,
 * then lists its copies so ones made outside Orca in the same layout join the sidebar and deleted
 * ones leave it. The host that owns the project notifies the sidebar on change.
 */
export function usePerforceCopySync(): void {
  const repos = useAppStore((s) => s.repos)
  useEffect(() => {
    for (const repo of repos) {
      const hostId = getRepoExecutionHostId(repo)
      const key = `${hostId}|${repo.id}|${repo.path}`
      if (!isFolderRepo(repo) || synced.has(key)) {
        continue
      }
      synced.add(key)
      const target = perforceProjectTarget(repo.id, hostId)
      void (async () => {
        const detected = await runPerforceCopyOperation(target, 'detectProject', {})
        const outcome =
          detected.ok && detected.value
            ? await runPerforceCopyOperation(target, 'syncCopies', {})
            : detected
        // Why: an unreachable host or server is retried on the next project change; a folder that
        // is not a workspace, or a server too old for Perforce, is not.
        if (!outcome.ok && outcome.error !== PERFORCE_UPDATE_REQUIRED_MESSAGE) {
          synced.delete(key)
        }
      })()
    }
  }, [repos])
}
