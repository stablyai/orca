import { getRepoExecutionHostId } from '../execution-host'
import { getRepoHostIdentityForParts } from '../repo-host-identity'
import type { Repo } from '../repo-types'
import type { PendingCreationRef } from './row-types'

export function groupPendingCreationsByRepo(
  pendingCreations: readonly PendingCreationRef[],
  repoMap: ReadonlyMap<string, Repo>
) {
  const pendingByRepo = new Map<string, PendingCreationRef[]>()
  for (const creation of pendingCreations) {
    const identity = getRepoHostIdentityForParts(
      creation.repoId,
      creation.hostId ?? getRepoExecutionHostId(repoMap.get(creation.repoId) ?? {})
    )
    const list = pendingByRepo.get(identity) ?? []
    list.push(creation)
    pendingByRepo.set(identity, list)
  }

  return pendingByRepo
}
