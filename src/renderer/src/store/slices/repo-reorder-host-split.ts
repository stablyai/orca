import type { GlobalSettings, Repo } from '../../../../shared/types'
import {
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId
} from '../../../../shared/execution-host'

export type RepoReorderHostGroup = {
  hostId: string
  orderedIds: string[]
}

type RepoHostCursor = {
  hosts: string[]
  nextIndex: number
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
  const remainingHostsByRepoId = new Map<string, RepoHostCursor>()
  for (const repo of repos) {
    const hasExplicitOwner = Boolean(repo.executionHostId?.trim() || repo.connectionId?.trim())
    const hostId = hasExplicitOwner ? getRepoExecutionHostId(repo) : focusedHostId
    const existing = remainingHostsByRepoId.get(repo.id)
    if (existing) {
      existing.hosts.push(hostId)
    } else {
      remainingHostsByRepoId.set(repo.id, { hosts: [hostId], nextIndex: 0 })
    }
  }
  const groups = new Map<string, string[]>()
  for (const id of orderedIds) {
    const remainingHosts = remainingHostsByRepoId.get(id)
    // Why: a bare repo id can appear once per host in the combined order. The
    // cursor consumes each occurrence against its owner host exactly once.
    const hostId = remainingHosts?.hosts[remainingHosts.nextIndex]
    if (remainingHosts) {
      remainingHosts.nextIndex += 1
    }
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
