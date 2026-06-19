import type { GlobalSettings, Repo } from '../../../../shared/types'
import {
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId
} from '../../../../shared/execution-host'

export type RepoReorderHostGroup = {
  hostId: string
  orderedIds: string[]
}

/** Split a cross-host reorder permutation into per-host permutations.
 *
 * Why: each host persists only its own repos and rejects any id list that is not
 * a full permutation of that host's repos (persistence.ts#reorderRepos). So a
 * single combined id list can only be applied on the host that owns every id —
 * never the case once repos span hosts. We instead group ids by their owner host
 * (preserving the user's relative order within each host) and dispatch one
 * permutation per host. Repos without an explicit owner fall back to the focused
 * host, matching the rest of the owner-routing helpers.
 */
export function splitRepoReorderByHost(
  orderedIds: readonly string[],
  repos: readonly Repo[],
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): RepoReorderHostGroup[] {
  const focusedHostId = getSettingsFocusedExecutionHostId(settings)
  const hostByRepoId = new Map<string, string>()
  for (const repo of repos) {
    const hasExplicitOwner = Boolean(repo.executionHostId?.trim() || repo.connectionId?.trim())
    hostByRepoId.set(repo.id, hasExplicitOwner ? getRepoExecutionHostId(repo) : focusedHostId)
  }
  const groups = new Map<string, string[]>()
  for (const id of orderedIds) {
    const hostId = hostByRepoId.get(id)
    if (!hostId) {
      continue
    }
    const existing = groups.get(hostId)
    if (existing) {
      existing.push(id)
    } else {
      groups.set(hostId, [id])
    }
  }
  return [...groups.entries()].map(([hostId, ids]) => ({ hostId, orderedIds: ids }))
}
