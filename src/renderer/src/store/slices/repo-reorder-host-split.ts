import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
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

/** Hosts accept only full permutations of their own repos. Split combined user order by owner, preserving relative order per host; unstamped repos retain focused-host fallback. */
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
    // Same bare ID can occur per host; cursor assigns each occurrence to its owner once.
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
