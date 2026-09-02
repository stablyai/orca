import { toSshExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import type { AppState } from '../../../types'

// Why: an SSH per-workspace-env project's host is the runtime-owned SSH target; once that runtime is destroyed, remove the project or it lingers as a dead, never-connectable one.
export async function purgeOrphanedRuntimeSshProjects(
  get: () => AppState,
  destroyedSshTargetIds: string[]
): Promise<void> {
  if (destroyedSshTargetIds.length === 0) {
    return
  }
  // Drop blanks once, before both lookups, so a repo with no connectionId never matches below.
  const purgeableSshTargetIds = destroyedSshTargetIds.filter((id) => id !== '')
  const destroyedTargetIds = new Set(purgeableSshTargetIds)
  const destroyedHostIds = new Set<ExecutionHostId>(
    purgeableSshTargetIds.map((id) => toSshExecutionHostId(id))
  )
  const orphanedSetupIds = get()
    .projectHostSetups.filter((setup) => destroyedHostIds.has(setup.hostId))
    .map((setup) => setup.id)
  const purgedRepoIds = new Set<string>()
  for (const setupId of orphanedSetupIds) {
    try {
      const result = await get().deleteProjectHostSetup({ setupId })
      if (result?.repo) {
        purgedRepoIds.add(result.repo.id)
      }
    } catch (error) {
      console.error('Failed to purge orphaned per-workspace-env project:', error)
    }
  }
  // A repo whose only host was the destroyed runtime can outlive its setup (pruned first by a projection refresh); remove it directly so no dead project lingers.
  const orphanedRepoIds = get()
    .repos.filter(
      (repo) => destroyedTargetIds.has(repo.connectionId ?? '') && !purgedRepoIds.has(repo.id)
    )
    .map((repo) => repo.id)
  for (const repoId of orphanedRepoIds) {
    try {
      await get().removeProject(repoId)
    } catch (error) {
      console.error('Failed to purge orphaned per-workspace-env repo:', error)
    }
  }
}
