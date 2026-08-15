import type { SshRepoReadoption } from '../../../../shared/ssh-types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'

export type SshRepoReconciliation = {
  repos: readonly Repo[]
  pendingReadoptions: readonly SshRepoReadoption[]
}

function repoBelongsToTarget(repo: Repo, targetId: string): boolean {
  return (
    repo.connectionId === targetId &&
    getRepoExecutionHostId(repo) === toSshExecutionHostId(targetId)
  )
}

/**
 * Drops old-host rows only when main reports the exact repo re-adoption and the
 * renderer has received the corresponding new-host row. Evidence stays pending
 * across the add-response/repos:changed race until that row arrives.
 */
export function reconcileReadoptedSshRepoRows(
  repos: readonly Repo[],
  readoptions: readonly SshRepoReadoption[]
): SshRepoReconciliation {
  const prunedOwners = new Set<string>()
  const pendingReadoptions: SshRepoReadoption[] = []
  const directSshOwners = new Set(
    repos.flatMap((repo) =>
      repo.connectionId && repoBelongsToTarget(repo, repo.connectionId)
        ? [getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo))]
        : []
    )
  )

  for (const readoption of readoptions) {
    const pendingRepoIds: string[] = []
    for (const repoId of readoption.repoIds) {
      const newOwner = getRepoHostIdentityForParts(
        repoId,
        toSshExecutionHostId(readoption.newTargetId)
      )
      const hasNewRow = directSshOwners.has(newOwner)
      if (!hasNewRow) {
        pendingRepoIds.push(repoId)
        continue
      }
      prunedOwners.add(
        getRepoHostIdentityForParts(repoId, toSshExecutionHostId(readoption.oldTargetId))
      )
    }
    if (pendingRepoIds.length > 0) {
      pendingReadoptions.push({ ...readoption, repoIds: pendingRepoIds })
    }
  }

  // Why: pruning nothing must hand back the input array, or the copy alone would defeat the
  // referential stability reconcileFetchedRepos just established upstream.
  if (prunedOwners.size === 0) {
    return { repos, pendingReadoptions }
  }
  return {
    repos: repos.filter(
      (repo) =>
        !prunedOwners.has(getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo)))
    ),
    pendingReadoptions
  }
}

export function mergeSshRepoReadoptions(
  pending: readonly SshRepoReadoption[],
  incoming: readonly SshRepoReadoption[]
): readonly SshRepoReadoption[] {
  const repoIdsByMigration = new Map<string, Set<string>>()
  for (const readoption of [...pending, ...incoming]) {
    const key = `${readoption.oldTargetId}\0${readoption.newTargetId}`
    const repoIds = repoIdsByMigration.get(key) ?? new Set<string>()
    readoption.repoIds.forEach((repoId) => repoIds.add(repoId))
    repoIdsByMigration.set(key, repoIds)
  }
  return [...repoIdsByMigration].map(([key, repoIds]) => {
    const [oldTargetId, newTargetId] = key.split('\0')
    return { oldTargetId, newTargetId, repoIds: [...repoIds] }
  })
}
